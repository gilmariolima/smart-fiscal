'use strict'

// Backup para outra pasta (PASTA_BACKUP):
//   xmls/                espelho dos XMLs: copia só os novos ou alterados e nunca apaga
//   diarios/AAAA-MM-DD/  nfe.db (VACUUM INTO, consistente com o sistema rodando), certs/ e .env
// Uma cópia diária por dia; guarda as MANTER_DIARIOS mais recentes.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MANTER_DIARIOS = 30
const DIAS_SEM_BACKUP_ALERTA = 3
const DIA_MS = 86400e3
const NOME_DIARIO = /^\d{4}-\d{2}-\d{2}$/

// Data no horário de Brasília (-03:00), como as competências.
const diaDe = (t) => new Date(t.getTime() - 3 * 3600e3).toISOString().slice(0, 10)

function criarServicoBackup({ db, config, logger, agora = () => new Date() }) {
  const pastaBackup = config.pastaBackup || null
  const sql = {
    iniciar: db.prepare("INSERT INTO execucoes (tipo, inicio) VALUES ('backup', ?)"),
    fechar: db.prepare('UPDATE execucoes SET fim = @fim, docs_recebidos = @docs, x_motivo = @x_motivo, erro = @erro WHERE id = @id'),
    ultima: db.prepare("SELECT fim, erro FROM execucoes WHERE tipo = 'backup' AND fim IS NOT NULL ORDER BY id DESC LIMIT 1"),
    ultimaOk: db.prepare("SELECT fim FROM execucoes WHERE tipo = 'backup' AND fim IS NOT NULL AND erro IS NULL ORDER BY id DESC LIMIT 1"),
  }
  let emAndamento = null

  // Copia o que não existe no espelho ou mudou de tamanho (o resumo da nota vira o XML completo).
  async function espelharXmls(destino) {
    let novos = 0
    let itens = []
    try {
      itens = await fsp.readdir(config.pastaXmls, { recursive: true, withFileTypes: true })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const item of itens) {
      if (!item.isFile()) continue
      const origem = path.join(item.parentPath, item.name)
      const alvo = path.join(destino, path.relative(config.pastaXmls, origem))
      const [o, a] = await Promise.all([fsp.stat(origem), fsp.stat(alvo).catch(() => null)])
      if (a && a.size === o.size) continue
      await fsp.mkdir(path.dirname(alvo), { recursive: true })
      await fsp.copyFile(origem, alvo)
      novos++
    }
    return novos
  }

  async function copiaDoDia(pastaDiarios, dia) {
    const final = path.join(pastaDiarios, dia)
    const temporaria = path.join(pastaDiarios, `.${dia}-incompleto`)
    await fsp.rm(temporaria, { recursive: true, force: true })
    await fsp.mkdir(temporaria, { recursive: true })
    db.exec(`VACUUM INTO '${path.join(temporaria, 'nfe.db').replace(/'/g, "''")}'`)
    if (fs.existsSync(config.pastaCerts)) await fsp.cp(config.pastaCerts, path.join(temporaria, 'certs'), { recursive: true })
    const env = config.raiz && path.join(config.raiz, '.env')
    if (env && fs.existsSync(env)) await fsp.copyFile(env, path.join(temporaria, '.env'))
    await fsp.rm(final, { recursive: true, force: true })
    await fsp.rename(temporaria, final)
  }

  async function rodizio(pastaDiarios) {
    const dias = (await fsp.readdir(pastaDiarios)).filter((n) => NOME_DIARIO.test(n)).sort()
    for (const velho of dias.slice(0, Math.max(0, dias.length - MANTER_DIARIOS))) {
      await fsp.rm(path.join(pastaDiarios, velho), { recursive: true, force: true })
    }
  }

  async function executar({ forcar }) {
    if (!pastaBackup) return { ok: false, desligado: true }
    const t = agora()
    const dia = diaDe(t)
    const pastaDiarios = path.join(pastaBackup, 'diarios')
    if (!forcar && fs.existsSync(path.join(pastaDiarios, dia))) return { ok: true, pulado: true }

    const id = Number(sql.iniciar.run(t.toISOString()).lastInsertRowid)
    const fechar = (campos) => sql.fechar.run({ id, fim: agora().toISOString(), docs: 0, x_motivo: null, erro: null, ...campos })
    try {
      try {
        await fsp.mkdir(pastaDiarios, { recursive: true })
      } catch (e) {
        throw new Error(`Pasta de backup indisponível (${pastaBackup}): ${e.code || e.message}`)
      }
      const xmlsNovos = await espelharXmls(path.join(pastaBackup, 'xmls'))
      await copiaDoDia(pastaDiarios, dia)
      await rodizio(pastaDiarios)
      const resumo = `${xmlsNovos} ${xmlsNovos === 1 ? 'XML novo' : 'XMLs novos'}; cópia de ${dia.split('-').reverse().join('/')}`
      fechar({ docs: xmlsNovos, x_motivo: resumo })
      logger.info('Backup concluído', { pasta: pastaBackup, xmlsNovos, dia })
      return { ok: true, xmlsNovos, dia }
    } catch (e) {
      fechar({ erro: e.message })
      logger.error('Backup falhou', { pasta: pastaBackup, erro: e.message })
      return { ok: false, erro: e.message }
    }
  }

  /** Faz o backup do dia (pula se já existe, a menos que `forcar`). Nunca lança exceção. */
  function fazerBackup({ forcar = false } = {}) {
    emAndamento ||= executar({ forcar }).finally(() => {
      emAndamento = null
    })
    return emAndamento
  }

  /** Situação para o painel: `alerta` só quando há algo a resolver. */
  function estado() {
    if (!pastaBackup) return { configurado: false, ultimoEm: null, alerta: 'Backup automático desligado: defina PASTA_BACKUP no .env.' }
    const ultima = sql.ultima.get()
    const ultimoEm = sql.ultimaOk.get()?.fim || null
    let alerta = null
    if (ultima?.erro) alerta = `O último backup falhou: ${ultima.erro}`
    else if (!ultimoEm) alerta = 'Nenhum backup feito ainda.'
    else {
      const dias = Math.floor((agora().getTime() - new Date(ultimoEm).getTime()) / DIA_MS)
      if (dias >= DIAS_SEM_BACKUP_ALERTA) alerta = `Último backup há ${dias} dias.`
    }
    return { configurado: true, pasta: pastaBackup, ultimoEm, alerta }
  }

  /** Espera o backup em andamento (ao desligar o servidor). */
  const aguardar = () => emAndamento || Promise.resolve()

  return { fazerBackup, aguardar, estado, ativo: !!pastaBackup }
}

module.exports = { criarServicoBackup, MANTER_DIARIOS }
