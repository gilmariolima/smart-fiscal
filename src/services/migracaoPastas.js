'use strict'

// Mudança única dos XMLs do formato antigo (<cliente>/[fora-da-carteira/]AAAA-MM|sem-data/arquivo) para o novo
// (<cliente>/[fora-da-carteira/]AAAA/MM/<NF-e|NFS-e>/<Entradas|Saidas>/[Eventos|Resumos/]arquivo).
// Ordem por arquivo: primeiro o banco aponta para o caminho novo, depois o arquivo é movido; se mover falhar,
// o banco volta. Se o app cair no meio, o arquivo continua na pasta antiga e a próxima abertura termina.
// Nunca impede a abertura do app: qualquer erro vai para o log e a mudança tenta de novo depois.
//
// Segunda mudança (migrarLayoutDasTelas): do <CNPJ_cliente>/[fora-da-carteira/]AAAA/MM/<Tipo>/<Direção>/... para a
// <Tipo>/<Cliente>/[fora-da-carteira/]AAAA/<Mês>/<Direção>/...
// Terceira mudança (migrarLayoutEmpresaPrimeiro): para <Cliente>/[fora-da-carteira/]<Tipo>/AAAA/<Mês>/<Direção>/...,
// a mesma ordem das telas e da exportação. Quem vem de antes passa pelas duas, em sequência.

const fs = require('node:fs')
const path = require('node:path')
const { direcaoPelaChave, modeloPelaChave, pastaDoClienteNoDisco, MESES, PASTAS } = require('./armazenamento')

const VERSAO = '2'
const VERSAO_LAYOUT = '3'
const VERSAO_EMPRESA = '4'
const PASTA_CLIENTE = /^(\d{14})(_.*)?$/
const PASTA_MES = /^(\d{4}-\d{2}|sem-data)$/
const ARQUIVO = /^(\d+)-(nfe|resumo|evento-\d+-\d+)\.xml$/
const POR_TRANSACAO = 500
// Dentro da pasta do cliente, no formato da versão 2.
const CAMINHO_V2 = /^(?:(fora-da-carteira)\/)?(?:(\d{4})\/(0[1-9]|1[0-2])|sem-data)\/(NF-e|NFS-e|CT-e)\/(Entradas|Saidas|Outros)\/(?:(Eventos|Resumos)\/)?([^/]+)$/

// Dentro da pasta do tipo, no formato da versão 3: <Cliente>/[fora-da-carteira/]AAAA/<Mês>|sem-data/<Direção>/...
const CAMINHO_V3 = new RegExp(`^([^/]+)/(?:(fora-da-carteira)/)?((?:\\d{4}/(?:${MESES.join('|')})|sem-data)/(?:Entradas|Saidas|Outros)/(?:(?:Eventos|Resumos)/)?[^/]+)$`)

const mesmoConteudo = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b))
const barras = (rel) => rel.replace(/\\/g, '/')

// Caminho da versão 2, sem o nome da pasta do cliente (a migração de quem ainda está na versão 1 passa por ele).
function caminhoV2({ foraDaCarteira, competencia, modelo, direcao, categoria, nomeArquivo }) {
  const m = /^(\d{4})-(\d{2})$/.exec(competencia || '')
  const partes = []
  if (foraDaCarteira) partes.push(PASTAS.foraDaCarteira)
  partes.push(...(m ? [m[1], m[2]] : [PASTAS.semData]))
  partes.push(PASTAS.modelo[modelo] || PASTAS.modelo.nfe, PASTAS.direcao[direcao] || PASTAS.direcao.entrada)
  if (categoria === 'evento') partes.push(PASTAS.evento)
  if (categoria === 'resumo') partes.push(PASTAS.resumo)
  return path.join(...partes, nomeArquivo)
}

// Banco primeiro, arquivo depois, em lotes; o que não mover volta o banco e fica pendente.
function aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos }) {
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
    nota: db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?'),
    evento: db.prepare('UPDATE eventos SET caminho_xml = ? WHERE id = ?'),
  }
  const apontar = db.transaction((lista, campo) => {
    for (const m of lista) {
      for (const id of notasPorCaminho.get(barras(m.antigo)) || []) sql.nota.run(m[campo], id)
      for (const id of eventosPorCaminho.get(barras(m.antigo)) || []) sql.evento.run(m[campo], id)
    }
  })

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

  for (let i = 0; i < movimentos.length; i += POR_TRANSACAO) {
    const lote = movimentos.slice(i, i + POR_TRANSACAO)
    apontar(lote, 'novo')
    const falhas = lote.filter((m) => !mover(m))
    if (falhas.length) apontar(falhas, 'antigo')
    resultado.movidos += lote.length - falhas.length
  }
}

// Pasta de rede ainda desconectada: só dá por feito se o banco não conhece nenhum XML.
function pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso }) {
  const temXml = db.prepare('SELECT 1 FROM notas WHERE caminho_xml IS NOT NULL UNION ALL SELECT 1 FROM eventos WHERE caminho_xml IS NOT NULL LIMIT 1').get()
  if (temXml) logger.warn(aviso, { pastaXmls })
  else gravarVersao()
}

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
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }

  const sql = {
    cliente: db.prepare('SELECT id FROM clientes WHERE cnpj = ?'),
    tipoDaNota: db.prepare('SELECT tipo FROM notas WHERE cliente_id = ? AND chave = ?'),
  }

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
          const relNovo = caminhoV2({ foraDaCarteira, competencia, modelo: modeloPelaChave(chave), direcao, categoria, nomeArquivo: arquivo })
          movimentos.push({ antigo, novo: path.join(pastaCliente, relNovo), pastaMes })
        }
      }
    }
  }

  aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos })
  for (const pasta of new Set(movimentos.map((m) => m.pastaMes))) removerSeVazia(path.join(pastaXmls, pasta))

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

/**
 * Leva os XMLs para a ordem das telas. Só mexe nas pastas <CNPJ>_<nome> do formato antigo: rodar de novo não faz nada.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutDasTelas({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const lerVersao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'")
  if ([VERSAO_LAYOUT, VERSAO_EMPRESA].includes(lerVersao.get()?.valor)) return resultado
  try {
    executarLayout({ db, pastaXmls, logger, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao organizar os XMLs na ordem das telas; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarLayout({ db, pastaXmls, logger, ops, resultado }) {
  const gravarVersao = () => db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(VERSAO_LAYOUT)
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }

  const clientes = db.prepare('SELECT cnpj, papel, apelido, razao_social FROM clientes').all()
  const movimentos = []
  const pastasDosClientes = []

  // Cliente excluído do cadastro: o nome vem da própria pasta.
  const pastaNova = (cnpj, resto) => {
    const c = clientes.find((o) => o.cnpj === cnpj)
    return pastaDoClienteNoDisco(c || { cnpj, papel: 'cliente', apelido: resto.replace(/^_/, '').replace(/_+/g, ' ') }, clientes)
  }

  const percorrer = (relativa, pastaCliente, cnpj, resto) => {
    for (const nome of ops.readdirSync(path.join(pastaXmls, relativa))) {
      const antigo = path.join(relativa, nome)
      if (fs.statSync(path.join(pastaXmls, antigo)).isDirectory()) {
        percorrer(antigo, pastaCliente, cnpj, resto)
        continue
      }
      const m = CAMINHO_V2.exec(barras(path.relative(pastaCliente, antigo)))
      if (!m) {
        resultado.ignorados.push(antigo)
        continue
      }
      const [, fora, ano, mes, tipo, direcao, sub, arquivo] = m
      const novo = path.join(tipo, pastaNova(cnpj, resto), ...(fora ? [fora] : []), ...(ano ? [ano, MESES[Number(mes) - 1]] : [PASTAS.semData]), direcao, ...(sub ? [sub] : []), arquivo)
      movimentos.push({ antigo, novo })
    }
  }

  for (const pastaCliente of ops.readdirSync(pastaXmls)) {
    const m = PASTA_CLIENTE.exec(pastaCliente)
    if (!m || !fs.statSync(path.join(pastaXmls, pastaCliente)).isDirectory()) continue
    pastasDosClientes.push(pastaCliente)
    percorrer(pastaCliente, pastaCliente, m[1], m[2] || '')
  }

  aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos })
  for (const pasta of pastasDosClientes) removerVaziasDentro(path.join(pastaXmls, pasta))

  if (resultado.ignorados.length) logger.warn('Arquivos fora do padrão ficaram na pasta antiga', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('XMLs organizados na ordem das telas', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * Leva os XMLs para <Cliente>/[fora-da-carteira/]<Tipo>/AAAA/<Mês>/... Só roda depois da mudança anterior terminar
 * e só mexe nas pastas NF-e, NFS-e e CT-e da raiz: rodar de novo não faz nada. O nome da pasta do cliente fica como está.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  if (db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor !== VERSAO_LAYOUT) return resultado
  try {
    executarEmpresa({ db, pastaXmls, logger, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao organizar os XMLs por empresa; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarEmpresa({ db, pastaXmls, logger, ops, resultado }) {
  const gravarVersao = () => db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_EMPRESA)
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }

  const tipos = Object.values(PASTAS.modelo)
  const movimentos = []
  const percorrer = (tipo, relativa) => {
    for (const nome of ops.readdirSync(path.join(pastaXmls, relativa))) {
      const antigo = path.join(relativa, nome)
      if (fs.statSync(path.join(pastaXmls, antigo)).isDirectory()) {
        percorrer(tipo, antigo)
        continue
      }
      const m = CAMINHO_V3.exec(barras(path.relative(tipo, antigo)))
      if (!m) {
        resultado.ignorados.push(antigo)
        continue
      }
      const [, cliente, fora, resto] = m
      movimentos.push({ antigo, novo: path.join(cliente, ...(fora ? [fora] : []), tipo, resto) })
    }
  }
  const presentes = ops.readdirSync(pastaXmls).filter((t) => tipos.includes(t) && fs.statSync(path.join(pastaXmls, t)).isDirectory())
  for (const tipo of presentes) percorrer(tipo, tipo)

  aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos })
  for (const tipo of presentes) removerVaziasDentro(path.join(pastaXmls, tipo))

  if (resultado.ignorados.length) logger.warn('Arquivos fora do padrão ficaram na pasta antiga', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('XMLs organizados por empresa', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

// Apaga as subpastas que ficaram vazias, de baixo para cima, e a própria pasta se esvaziar.
function removerVaziasDentro(pasta) {
  try {
    for (const item of fs.readdirSync(pasta, { withFileTypes: true })) {
      if (item.isDirectory()) removerVaziasDentro(path.join(pasta, item.name))
    }
  } catch {
    return // fica para a próxima
  }
  removerSeVazia(pasta)
}

module.exports = { migrarPastas, migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro }
