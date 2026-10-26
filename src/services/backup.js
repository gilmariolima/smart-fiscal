'use strict'

// Backup para outra pasta, escolhida na tela Backup (fica na tabela `sistema`) ou no PASTA_BACKUP do .env:
//   xmls/                espelho dos XMLs: copia só os novos ou alterados e nunca apaga
//   diarios/AAAA-MM-DD/  nfe.db (VACUUM INTO, consistente com o sistema rodando), certs/, .env
//                        e estoque/ (dados do SPED, sem os logs)
// Uma cópia diária por dia; guarda as MANTER_DIARIOS mais recentes.
// A escolha da tela vale mais que o .env; escolher "nenhuma" desliga o backup mesmo com o .env preenchido.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const MANTER_DIARIOS = 30
const DIAS_SEM_BACKUP_ALERTA = 3
const DIA_MS = 86400e3
const NOME_DIARIO = /^\d{4}-\d{2}-\d{2}$/
const CHAVE_PASTA = 'pasta_backup'
// Do SPED ficam fora os logs e o token da execução.
const FORA_DO_ESTOQUE = /(^|[\\/])(painel\.log|painel\.token|[^\\/]*\.log(\.\d+)?)$/

/** Caminho completo no Windows (C:\..., \\servidor\...) ou no Linux/macOS (/...). */
const caminhoCompleto = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p)

// Data no horário de Brasília (-03:00), como as competências.
const diaDe = (t) => new Date(t.getTime() - 3 * 3600e3).toISOString().slice(0, 10)

function criarServicoBackup({ db, config, logger, agora = () => new Date() }) {
  const sql = {
    lerPasta: db.prepare('SELECT valor FROM sistema WHERE chave = ?'),
    gravarPasta: db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
    iniciar: db.prepare("INSERT INTO execucoes (tipo, inicio) VALUES ('backup', ?)"),
    fechar: db.prepare('UPDATE execucoes SET fim = @fim, docs_recebidos = @docs, x_motivo = @x_motivo, erro = @erro WHERE id = @id'),
    ultima: db.prepare("SELECT fim, erro, x_motivo FROM execucoes WHERE tipo = 'backup' AND fim IS NOT NULL ORDER BY id DESC LIMIT 1"),
    ultimaOk: db.prepare("SELECT fim FROM execucoes WHERE tipo = 'backup' AND fim IS NOT NULL AND erro IS NULL ORDER BY id DESC LIMIT 1"),
  }
  let emAndamento = null

  /** Pasta em uso e de onde veio: 'painel' (tela Backup), 'env' (PASTA_BACKUP) ou null (desligado). */
  function escolha() {
    const salva = sql.lerPasta.get(CHAVE_PASTA)
    if (salva) return { pasta: salva.valor || null, origem: salva.valor ? 'painel' : null }
    return { pasta: config.pastaBackup || null, origem: config.pastaBackup ? 'env' : null }
  }
  const pastaAtual = () => escolha().pasta

  /**
   * Escolhe a pasta do backup ('' desliga). Cria a pasta e testa gravar nela antes de aceitar.
   * @returns {{ pasta, avisos: string[] }}
   */
  function definirPasta(valor) {
    const pasta = String(valor ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (!pasta) {
      sql.gravarPasta.run(CHAVE_PASTA, '')
      logger.info('Backup automático desligado pela tela Backup')
      return { pasta: null, avisos: [] }
    }
    if (!caminhoCompleto(pasta)) throw new Error('Informe o endereço completo da pasta, como D:\\Backup ou \\\\servidor\\backup.')
    const dentro = (base) => base && !path.relative(base, pasta).startsWith('..') && !path.isAbsolute(path.relative(base, pasta))
    if (dentro(config.raiz) || dentro(config.pastaEstoque)) throw new Error('A pasta do backup não pode ficar dentro da pasta de dados do Smart Fiscal.')
    try {
      fs.mkdirSync(pasta, { recursive: true })
      const teste = path.join(pasta, `.teste-smart-fiscal-${process.pid}`)
      fs.writeFileSync(teste, 'ok')
      fs.rmSync(teste, { force: true })
    } catch (e) {
      throw new Error(`Não consegui gravar na pasta ${pasta} (${e.code || e.message}). Confira o endereço e a permissão.`)
    }
    const avisos = []
    const disco = (p) => path.win32.parse(p).root.toUpperCase()
    if (config.raiz && /^[A-Z]:\\$/.test(disco(pasta)) && disco(pasta) === disco(config.raiz)) {
      avisos.push(`A pasta fica no mesmo disco ${disco(pasta)} do Smart Fiscal: se o disco der defeito, o backup vai junto. Prefira outro disco, a rede ou uma pasta do OneDrive/Drive.`)
    }
    sql.gravarPasta.run(CHAVE_PASTA, pasta)
    logger.info('Pasta do backup escolhida', { pasta })
    return { pasta, avisos }
  }

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
    if (config.pastaEstoque && fs.existsSync(config.pastaEstoque)) {
      await fsp.cp(config.pastaEstoque, path.join(temporaria, 'estoque'), { recursive: true, filter: (origem) => !FORA_DO_ESTOQUE.test(origem) })
    }
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
    const pastaBackup = pastaAtual()
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
    const { pasta: pastaBackup, origem } = escolha()
    const base = { origem, emAndamento: !!emAndamento, incluiSped: !!config.pastaEstoque }
    if (!pastaBackup) return { ...base, configurado: false, ultimoEm: null, alerta: 'Backup automático desligado: escolha a pasta na tela Backup.' }
    const ultima = sql.ultima.get()
    const ultimoEm = sql.ultimaOk.get()?.fim || null
    let alerta = null
    if (ultima?.erro) alerta = `O último backup falhou: ${ultima.erro}`
    else if (!ultimoEm) alerta = 'Nenhum backup feito ainda.'
    else {
      const dias = Math.floor((agora().getTime() - new Date(ultimoEm).getTime()) / DIA_MS)
      if (dias >= DIAS_SEM_BACKUP_ALERTA) alerta = `Último backup há ${dias} dias.`
    }
    return { ...base, configurado: true, pasta: pastaBackup, ultimoEm, ultimoResumo: ultima?.erro ? null : ultima?.x_motivo || null, alerta }
  }

  /** Espera o backup em andamento (ao desligar o servidor). */
  const aguardar = () => emAndamento || Promise.resolve()

  return {
    fazerBackup,
    aguardar,
    estado,
    definirPasta,
    get ativo() {
      return !!pastaAtual()
    },
  }
}

module.exports = { criarServicoBackup, MANTER_DIARIOS }
