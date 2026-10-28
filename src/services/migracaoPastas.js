'use strict'

// Mudança única dos XMLs do formato antigo (<cliente>/[fora-da-carteira/]AAAA-MM|sem-data/arquivo) para o novo
// (<cliente>/[fora-da-carteira/]AAAA/MM/<NF-e|NFS-e>/<Entradas|Saidas>/[Eventos|Resumos/]arquivo).
// Ordem por arquivo: primeiro o banco aponta para o caminho novo, depois o arquivo é movido; se mover falhar,
// o banco volta. Se o app cair no meio, o arquivo continua na pasta antiga e a próxima abertura termina.
// Nunca impede a abertura do app: qualquer erro vai para o log e a mudança tenta de novo depois.

const fs = require('node:fs')
const path = require('node:path')
const { caminhoDa, direcaoPelaChave, modeloPelaChave, PASTAS } = require('./armazenamento')

const VERSAO = '2'
const PASTA_CLIENTE = /^(\d{14})(_.*)?$/
const PASTA_MES = /^(\d{4}-\d{2}|sem-data)$/
const ARQUIVO = /^(\d+)-(nfe|resumo|evento-\d+-\d+)\.xml$/
const POR_TRANSACAO = 500

const mesmoConteudo = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b))
const barras = (rel) => rel.replace(/\\/g, '/')

/**
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 * `fsOps` (renameSync, readdirSync) é injetável nos testes.
 */
function migrarPastas({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const lerVersao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_versao'")
  if (lerVersao.get()?.valor === VERSAO) return resultado
  try {
    executar({ db, pastaXmls, logger, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao organizar os XMLs nas pastas novas; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executar({ db, pastaXmls, logger, ops, resultado }) {
  const gravarVersao = () => db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_versao', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(VERSAO)
  if (!fs.existsSync(pastaXmls)) {
    // Pasta de rede ainda desconectada: só dá por feito se o banco não conhece nenhum XML.
    const temXml = db.prepare('SELECT 1 FROM notas WHERE caminho_xml IS NOT NULL UNION ALL SELECT 1 FROM eventos WHERE caminho_xml IS NOT NULL LIMIT 1').get()
    if (temXml) logger.warn('Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura', { pastaXmls })
    else gravarVersao()
    return
  }

  // Caminho antigo (com '/') → ids, carregado uma vez: atualizar por id não varre a tabela a cada arquivo.
  const indice = (tabela) => {
    const m = new Map()
    for (const r of db.prepare(`SELECT id, caminho_xml FROM ${tabela} WHERE caminho_xml IS NOT NULL`).all()) {
      const k = barras(r.caminho_xml)
      m.set(k, [...(m.get(k) || []), r.id])
    }
    return m
  }
  const notasPorCaminho = indice('notas')
  const eventosPorCaminho = indice('eventos')
  const sql = {
    cliente: db.prepare('SELECT id FROM clientes WHERE cnpj = ?'),
    tipoDaNota: db.prepare('SELECT tipo FROM notas WHERE cliente_id = ? AND chave = ?'),
    nota: db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?'),
    evento: db.prepare('UPDATE eventos SET caminho_xml = ? WHERE id = ?'),
  }
  const apontar = db.transaction((lista, campo) => {
    for (const m of lista) {
      for (const id of notasPorCaminho.get(barras(m.antigo)) || []) sql.nota.run(m[campo], id)
      for (const id of eventosPorCaminho.get(barras(m.antigo)) || []) sql.evento.run(m[campo], id)
    }
  })

  const movimentos = []
  for (const pastaCliente of ops.readdirSync(pastaXmls)) {
    const cnpj = PASTA_CLIENTE.exec(pastaCliente)?.[1]
    if (!cnpj || !fs.statSync(path.join(pastaXmls, pastaCliente)).isDirectory()) continue
    const clienteId = sql.cliente.get(cnpj)?.id
    for (const foraDaCarteira of [false, true]) {
      const base = foraDaCarteira ? path.join(pastaCliente, PASTAS.foraDaCarteira) : pastaCliente
      if (!fs.existsSync(path.join(pastaXmls, base))) continue
      for (const mes of ops.readdirSync(path.join(pastaXmls, base)).filter((m) => PASTA_MES.test(m))) {
        const pastaMes = path.join(base, mes)
        // sem-data antigo tem arquivos soltos; o novo sem-data\NF-e\... já são pastas e ficam de fora.
        for (const arquivo of ops.readdirSync(path.join(pastaXmls, pastaMes))) {
          const antigo = path.join(pastaMes, arquivo)
          if (fs.statSync(path.join(pastaXmls, antigo)).isDirectory()) continue
          const m = ARQUIVO.exec(arquivo)
          if (!m) {
            resultado.ignorados.push(antigo)
            continue
          }
          const [, chave, tipo] = m
          const categoria = tipo === 'nfe' ? 'nota' : tipo === 'resumo' ? 'resumo' : 'evento'
          const tipoDaNota = clienteId ? sql.tipoDaNota.get(clienteId, chave)?.tipo : null
          const direcao = foraDaCarteira || categoria === 'resumo' ? 'entrada' : tipoDaNota || direcaoPelaChave(chave, cnpj)
          const competencia = mes === PASTAS.semData ? null : mes
          // O nome da pasta do cliente fica como está (o apelido pode ter mudado desde então).
          const relNovo = caminhoDa({ cliente: { cnpj }, foraDaCarteira, competencia, modelo: modeloPelaChave(chave), direcao, categoria, nomeArquivo: arquivo })
          movimentos.push({ antigo, novo: path.join(pastaCliente, ...relNovo.split(path.sep).slice(1)), pastaMes })
        }
      }
    }
  }

  for (let i = 0; i < movimentos.length; i += POR_TRANSACAO) {
    const lote = movimentos.slice(i, i + POR_TRANSACAO)
    apontar(lote, 'novo')
    const falhas = lote.filter((m) => !mover(m))
    if (falhas.length) apontar(falhas, 'antigo')
    resultado.movidos += lote.length - falhas.length
  }
  for (const pasta of new Set(movimentos.map((m) => m.pastaMes))) removerSeVazia(path.join(pastaXmls, pasta))

  function mover({ antigo, novo }) {
    const origem = path.join(pastaXmls, antigo)
    const destino = path.join(pastaXmls, novo)
    try {
      if (fs.existsSync(destino)) {
        if (!mesmoConteudo(origem, destino)) throw new Error('já existe outro arquivo com o mesmo nome no destino')
        fs.rmSync(origem)
        return true
      }
      fs.mkdirSync(path.dirname(destino), { recursive: true })
      ops.renameSync(origem, destino)
      return true
    } catch (e) {
      resultado.pendentes.push(antigo)
      logger.warn('XML não movido para a pasta nova; tenta de novo na próxima abertura', { arquivo: antigo, erro: e.message })
      return false
    }
  }

  if (resultado.ignorados.length) logger.warn('Arquivos fora do padrão ficaram na pasta antiga', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('XMLs movidos para as pastas novas', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

function removerSeVazia(pasta) {
  try {
    if (!fs.readdirSync(pasta).length) fs.rmdirSync(pasta)
  } catch {
    // fica para a próxima
  }
}

module.exports = { migrarPastas }
