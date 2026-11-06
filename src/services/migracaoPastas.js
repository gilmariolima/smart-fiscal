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
// Quarta mudança (migrarLayoutAnoMes): para <Cliente>/[fora-da-carteira/]AAAA/<Mês>/<Tipo>/<Direção>/...,
// a mesma ordem das telas e da exportação.
// Quinta mudança (migrarLayoutPastaXml): para <Cliente>/[fora-da-carteira/]AAAA/<Mês>/<Tipo>/XML/<Direção>/...,
// deixando o lado do PDF.
// Sexta mudança (migrarLayoutMesNumerado): a pasta do mês ganha o número (11-Novembro).
// Sétima mudança (migrarLayoutDirecao): a direção vem antes do tipo: <Cliente>/[fora-da-carteira/]AAAA/<MM-Mês>/<Direção>/<Tipo>/(XML|PDF)/...
// Oitava mudança (migrarLayoutEventos): eventos e resumos saem de entradas e saídas: <MM-Mês>/Eventos e Resumos/<Tipo>/...
// Nona mudança (migrarLayoutSemCliente): a pasta fora-da-carteira passa a se chamar Sem cliente cadastrado.
// Décima mudança (migrarLayoutTipoPrimeiro): o tipo vem antes da direção: <MM-Mês>/<Tipo>/<Direção>/... e <MM-Mês>/<Tipo>/Eventos e Resumos/...
// Quem vem de antes passa por todas, em sequência.

const fs = require('node:fs')
const path = require('node:path')
const { direcaoPelaChave, modeloPelaChave, pastaDoClienteNoDisco, caminhoDoResumo, pastaDoMes, comMesNumerado, temMesSemNumero, comDirecaoAntesDoTipo, comAvulsosNoLugar, comTipoPrimeiro, MESES, PASTAS } = require('./armazenamento')
const { nomearSemSobrescreverSync } = require('./copiaDePastas')

const VERSAO = '2'
const VERSAO_LAYOUT = '3'
const VERSAO_EMPRESA = '4'
const VERSAO_ANO_MES = '5'
const VERSAO_PASTA_XML = '6'
const VERSAO_MES = '7'
const VERSAO_DIRECAO = '8'
const VERSAO_EVENTOS = '9'
const VERSAO_SEM_CLIENTE = '10'
const VERSAO_XML = '11'
// Nome da pasta até a nona mudança; as anteriores ainda o encontram no disco.
const FORA_ANTIGA = 'fora-da-carteira'
const PASTA_CLIENTE = /^(\d{14})(_.*)?$/
const PASTA_MES = /^(\d{4}-\d{2}|sem-data)$/
const ARQUIVO = /^(\d+)-(nfe|resumo|evento-\d+-\d+)\.xml$/
const POR_TRANSACAO = 500
// Dentro da pasta do cliente, no formato da versão 2.
const CAMINHO_V2 = /^(?:(fora-da-carteira)\/)?(?:(\d{4})\/(0[1-9]|1[0-2])|sem-data)\/(NF-e|NFS-e|CT-e)\/(Entradas|Saidas|Outros)\/(?:(Eventos|Resumos)\/)?([^/]+)$/

// Dentro da pasta do tipo, no formato da versão 3: <Cliente>/[fora-da-carteira/]AAAA/<Mês>|sem-data/<Direção>/...
const CAMINHO_V3 = new RegExp(`^([^/]+)/(?:(fora-da-carteira)/)?((?:\\d{4}/(?:${MESES.join('|')})|sem-data)/(?:Entradas|Saidas|Outros)/(?:(?:Eventos|Resumos)/)?[^/]+)$`)
// Dentro da pasta do cliente, nos formatos da versão 4 (<Tipo>/AAAA/<Mês>|sem-data/...) e da 5 (AAAA/<Mês>|sem-data/<Tipo>/...).
const QUANDO = `(?:\\d{4}/(?:${MESES.join('|')})|sem-data)`
const CAMINHO_V4 = new RegExp(`^(?:(fora-da-carteira)/)?(NF-e|NFS-e|CT-e)/(${QUANDO})/((?:Entradas|Saidas|Outros)/(?:(?:Eventos|Resumos)/)?[^/]+)$`)
// Com a mudança anterior pendente, uma captura já grava com o mês numerado: também não é arquivo fora do padrão.
const QUANDO_ATUAL = `(?:\\d{4}/(?:\\d{2}-)?(?:${MESES.join('|')})|sem-data)`
const CAMINHO_V5 = new RegExp(`^(?:fora-da-carteira/)?${QUANDO_ATUAL}/(?:NF-e|NFS-e|CT-e)/(?:Entradas|Saidas|Outros)/(?:(?:Eventos|Resumos)/)?[^/]+$`)
// Versão 6: o mesmo com XML/ entre o tipo e a direção.
const CAMINHO_V6 = new RegExp(`^(?:fora-da-carteira/|Sem cliente cadastrado/)?${QUANDO_ATUAL}/(?:(?:NF-e|NFS-e|CT-e)/XML/(?:Entradas|Saidas|Outros)|(?:Entradas|Saidas|Outros)/(?:NF-e|NFS-e|CT-e)/XML|Eventos e Resumos/(?:NF-e|NFS-e|CT-e)|(?:NF-e|NFS-e|CT-e)/(?:(?:Entradas|Saidas|Outros)/XML|Eventos e Resumos))/(?:(?:Eventos|Resumos)/)?[^/]+$`)
// O que a pasta organizada gera ao lado do XML (em nova tentativa da migração): não é arquivo fora do padrão.
const GERADO_NO_GRUPO = new RegExp(`^(?:fora-da-carteira/|Sem cliente cadastrado/)?${QUANDO_ATUAL}/(?:(?:Entradas|Saidas|Outros)/)?(?:NF-e|NFS-e|CT-e)/(?:(?:Entradas|Saidas|Outros)/)?(?:PDF/.+|[^/]+\\.(?:xlsx|pdf|zip|tmp))$`, 'i')
const CAMINHO_V5_PARTES = new RegExp(`^(?:(fora-da-carteira)/)?(${QUANDO_ATUAL})/(NF-e|NFS-e|CT-e)/((?:Entradas|Saidas|Outros)/(?:(?:Eventos|Resumos)/)?[^/]+)$`)

const mesmoConteudo = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b))
const barras = (rel) => rel.replace(/\\/g, '/')

// Caminho da versão 2, sem o nome da pasta do cliente (a migração de quem ainda está na versão 1 passa por ele).
function caminhoV2({ foraDaCarteira, competencia, modelo, direcao, categoria, nomeArquivo }) {
  const m = /^(\d{4})-(\d{2})$/.exec(competencia || '')
  const partes = []
  if (foraDaCarteira) partes.push(FORA_ANTIGA)
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
    ops.aoAvancar?.(resultado.movidos)
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
      const base = foraDaCarteira ? path.join(pastaCliente, FORA_ANTIGA) : pastaCliente
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
  if ([VERSAO_LAYOUT, VERSAO_EMPRESA, VERSAO_ANO_MES, VERSAO_PASTA_XML, VERSAO_MES, VERSAO_DIRECAO, VERSAO_EVENTOS, VERSAO_SEM_CLIENTE, VERSAO_XML].includes(lerVersao.get()?.valor)) return resultado
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

/**
 * Leva os XMLs para <Cliente>/[fora-da-carteira/]AAAA/<Mês>/<Tipo>/... Só roda depois da mudança anterior terminar.
 * Quem já está no formato novo fica como está (notas gravadas enquanto um arquivo travado segura a mudança).
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutAnoMes({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  if (db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor !== VERSAO_EMPRESA) return resultado
  try {
    executarAnoMes({ db, pastaXmls, logger, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao organizar os XMLs por ano e mês; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarAnoMes({ db, pastaXmls, logger, ops, resultado }) {
  const gravarVersao = () => db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_ANO_MES)
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }

  const movimentos = []
  const percorrer = (pastaCliente, relativa) => {
    for (const nome of ops.readdirSync(path.join(pastaXmls, relativa))) {
      const antigo = path.join(relativa, nome)
      if (fs.statSync(path.join(pastaXmls, antigo)).isDirectory()) {
        percorrer(pastaCliente, antigo)
        continue
      }
      const dentro = barras(path.relative(pastaCliente, antigo))
      const m = CAMINHO_V4.exec(dentro)
      if (!m) {
        if (!CAMINHO_V5.test(dentro) && !CAMINHO_V6.test(dentro) && !GERADO_NO_GRUPO.test(dentro)) resultado.ignorados.push(antigo)
        continue
      }
      const [, fora, tipo, quando, resto] = m
      movimentos.push({ antigo, novo: path.join(pastaCliente, ...(fora ? [fora] : []), quando, tipo, resto) })
    }
  }
  const clientes = ops.readdirSync(pastaXmls).filter((c) => fs.statSync(path.join(pastaXmls, c)).isDirectory())
  for (const c of clientes) percorrer(c, c)

  aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos })
  for (const c of clientes) removerVaziasDentro(path.join(pastaXmls, c))

  if (resultado.ignorados.length) logger.warn('Arquivos fora do padrão ficaram na pasta antiga', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('XMLs organizados por ano e mês', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * Leva os XMLs para <Cliente>/[fora-da-carteira/]AAAA/<Mês>/<Tipo>/XML/... Só roda depois da mudança anterior terminar.
 * Quem já está no formato novo fica como está (notas gravadas enquanto um arquivo travado segura a mudança).
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutPastaXml({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  if (db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor !== VERSAO_ANO_MES) return resultado
  try {
    executarPastaXml({ db, pastaXmls, logger, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao separar os XMLs em pasta própria; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarPastaXml({ db, pastaXmls, logger, ops, resultado }) {
  const gravarVersao = () => db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_PASTA_XML)
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }

  const movimentos = []
  const percorrer = (pastaCliente, relativa) => {
    for (const nome of ops.readdirSync(path.join(pastaXmls, relativa))) {
      const antigo = path.join(relativa, nome)
      if (fs.statSync(path.join(pastaXmls, antigo)).isDirectory()) {
        percorrer(pastaCliente, antigo)
        continue
      }
      const dentro = barras(path.relative(pastaCliente, antigo))
      const m = CAMINHO_V5_PARTES.exec(dentro)
      if (!m) {
        if (!CAMINHO_V6.test(dentro) && !GERADO_NO_GRUPO.test(dentro)) resultado.ignorados.push(antigo)
        continue
      }
      const [, fora, quando, tipo, resto] = m
      movimentos.push({ antigo, novo: path.join(pastaCliente, ...(fora ? [fora] : []), quando, tipo, PASTAS.xml, resto) })
    }
  }
  const clientes = ops.readdirSync(pastaXmls).filter((c) => fs.statSync(path.join(pastaXmls, c)).isDirectory())
  for (const c of clientes) percorrer(c, c)

  aplicarMovimentos({ db, pastaXmls, logger, ops, resultado, movimentos })
  for (const c of clientes) removerVaziasDentro(path.join(pastaXmls, c))

  if (resultado.ignorados.length) logger.warn('Arquivos fora do padrão ficaram na pasta antiga', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('XMLs separados em pasta própria', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * Dá o número à pasta do mês: <Cliente>/[fora-da-carteira/]AAAA/<MM-Mês>/...
 * Roda também com a pasta XML pendente, sem gravar a versão: um XML travado lá só deve afetar o mês dele.
 * Renomeia o mês inteiro, com PDFs, relatórios e ZIP, em uma operação; o que está em uso vai arquivo a arquivo.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutMesNumerado({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const versao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor
  if (versao !== VERSAO_PASTA_XML && versao !== VERSAO_ANO_MES) return resultado
  try {
    executarMesNumerado({ db, pastaXmls, logger, podeGravarVersao: versao === VERSAO_PASTA_XML, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao numerar as pastas dos meses; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

// Move pastas inteiras, com o banco acompanhando. O que estiver em uso vai arquivo a arquivo. `precisa` e `novoCaminho` dizem quais linhas mudam e como.
function criarMovedorDePastas({ db, pastaXmls, logger, ops, resultado, precisa, novoCaminho }) {
  // Linhas que ainda não mudaram, para apontar sem varrer a tabela a cada pasta.
  const chave = (rel) => barras(rel).toLowerCase()
  const faltam = new Map()
  for (const tabela of ['notas', 'eventos']) {
    const atualizar = db.prepare(`UPDATE ${tabela} SET caminho_xml = ? WHERE id = ?`)
    for (const { id, caminho_xml: caminho } of db.prepare(`SELECT id, caminho_xml FROM ${tabela} WHERE caminho_xml IS NOT NULL`).all()) {
      if (!precisa(caminho)) continue
      const k = chave(caminho)
      faltam.set(k, [...(faltam.get(k) || []), { id, caminho, atualizar }])
    }
  }
  const apontar = db.transaction((chaves) => {
    for (const k of chaves) {
      for (const l of faltam.get(k) || []) l.atualizar.run(novoCaminho(l.caminho), l.id)
      faltam.delete(k)
    }
  })

  function juntar(antigo, novo) {
    const origem = path.join(pastaXmls, antigo)
    for (const item of fs.readdirSync(origem, { recursive: true, withFileTypes: true })) {
      if (!item.isFile() || item.name.toLowerCase().endsWith('.tmp')) continue
      const de = path.join(item.parentPath, item.name)
      const dentro = path.relative(origem, de)
      const rel = path.join(antigo, dentro)
      const para = path.join(pastaXmls, novo, dentro)
      try {
        fs.mkdirSync(path.dirname(para), { recursive: true })
        if (!nomearSemSobrescreverSync(de, para) && !mesmoConteudo(de, para)) {
          // Relatório, ZIP e PDF são refeitos; XML com outro conteúdo não pode ficar sem dono.
          if (rel.toLowerCase().endsWith('.xml')) {
            resultado.pendentes.push(rel)
            logger.warn('XML com outro conteúdo na pasta nova: os dois foram mantidos', { arquivo: rel })
          } else resultado.ignorados.push(rel)
          continue
        }
        apontar([chave(rel)])
        fs.unlinkSync(de)
        resultado.movidos++
        ops.aoAvancar?.(resultado.movidos)
      } catch (e) {
        resultado.pendentes.push(rel)
        logger.warn('Arquivo não saiu da pasta antiga; tenta de novo depois', { arquivo: rel, erro: e.code || e.message })
      }
    }
    removerVaziasDentro(origem)
  }

  function mover(antigo, novo) {
    if (!fs.existsSync(path.join(pastaXmls, novo))) {
      try {
        fs.mkdirSync(path.dirname(path.join(pastaXmls, novo)), { recursive: true })
        ops.renameSync(path.join(pastaXmls, antigo), path.join(pastaXmls, novo))
        const prefixo = `${chave(antigo)}/`
        apontar([...faltam.keys()].filter((k) => k.startsWith(prefixo)))
        resultado.movidos++
        ops.aoAvancar?.(resultado.movidos)
        return
      } catch (e) {
        logger.warn('Pasta em uso: levando arquivo a arquivo', { pasta: antigo, erro: e.code || e.message })
      }
    }
    juntar(antigo, novo)
  }

  // App caiu entre mover e gravar o banco, ou linha sem arquivo: vale o caminho novo, a menos que o arquivo siga na pasta antiga.
  function concluir() {
    for (const k of [...faltam.keys()]) {
      const { caminho } = faltam.get(k)[0]
      if (!fs.existsSync(path.join(pastaXmls, caminho))) apontar([k])
      else if (!resultado.pendentes.some((rel) => chave(rel) === k)) resultado.pendentes.push(caminho)
    }
  }

  return { mover, concluir }
}

// Link ou junction fica de fora.
const subpastas = (pastaXmls, ops, rel) => ops.readdirSync(path.join(pastaXmls, rel)).filter((n) => fs.lstatSync(path.join(pastaXmls, rel, n)).isDirectory())
// A pasta do cliente e, se houver, a das notas sem cliente dentro dela, com o nome antigo ou o atual.
const basesDoCliente = (pastaXmls, cliente) => [cliente, ...[FORA_ANTIGA, PASTAS.foraDaCarteira].map((nome) => path.join(cliente, nome)).filter((d) => fs.existsSync(path.join(pastaXmls, d)))]

function executarMesNumerado({ db, pastaXmls, logger, podeGravarVersao, ops, resultado }) {
  const gravarVersao = () => {
    if (podeGravarVersao) db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_MES)
  }
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }
  const movedor = criarMovedorDePastas({ db, pastaXmls, logger, ops, resultado, precisa: temMesSemNumero, novoCaminho: comMesNumerado })
  for (const cliente of subpastas(pastaXmls, ops, '.')) {
    for (const base of basesDoCliente(pastaXmls, cliente)) {
      for (const ano of subpastas(pastaXmls, ops, base).filter((n) => /^\d{4}$/.test(n))) {
        for (const mes of subpastas(pastaXmls, ops, path.join(base, ano))) {
          const i = MESES.indexOf(mes)
          if (i >= 0) movedor.mover(path.join(base, ano, mes), path.join(base, ano, pastaDoMes(i + 1)))
        }
      }
    }
  }
  movedor.concluir()
  if (resultado.ignorados.length) logger.warn('Arquivos diferentes com o mesmo nome ficaram na pasta antiga do mês', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('Pastas dos meses numeradas', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * Passa a direção para antes do tipo: <MM-Mês>/<Tipo>/(XML|PDF)/<Direção> vira <MM-Mês>/<Direção>/<Tipo>/(XML|PDF).
 * Aproveita XML e PDF. Relatórios e ZIP misturavam as direções: saem, e a geração refaz por direção.
 * Roda também com etapa anterior pendente, sem gravar a versão: um XML travado lá só deve afetar o mês dele.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutDirecao({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const versao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor
  if (![VERSAO_ANO_MES, VERSAO_PASTA_XML, VERSAO_MES].includes(versao)) return resultado
  try {
    executarDirecao({ db, pastaXmls, logger, podeGravarVersao: versao === VERSAO_MES, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao separar as pastas em entradas e saídas; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarDirecao({ db, pastaXmls, logger, podeGravarVersao, ops, resultado }) {
  const gravarVersao = () => {
    if (podeGravarVersao) db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_DIRECAO)
  }
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }
  const movedor = criarMovedorDePastas({
    db,
    pastaXmls,
    logger,
    ops,
    resultado,
    precisa: (c) => comDirecaoAntesDoTipo(c) !== c,
    novoCaminho: comDirecaoAntesDoTipo,
  })
  const tipos = Object.values(PASTAS.modelo)
  const direcoes = Object.values(PASTAS.direcao)

  function arrumarQuando(quando) {
    for (const tipo of subpastas(pastaXmls, ops, quando).filter((n) => tipos.includes(n))) {
      const pastaTipo = path.join(quando, tipo)
      for (const area of subpastas(pastaXmls, ops, pastaTipo).filter((n) => n === PASTAS.xml || n === PASTAS.pdf)) {
        for (const direcao of subpastas(pastaXmls, ops, path.join(pastaTipo, area)).filter((n) => direcoes.includes(n))) {
          movedor.mover(path.join(pastaTipo, area, direcao), path.join(quando, direcao, tipo, area))
        }
      }
      for (const nome of ops.readdirSync(path.join(pastaXmls, pastaTipo))) {
        if (!/^Relatorio .*\.(xlsx|pdf)$/i.test(nome) && !/\.zip$/i.test(nome)) continue
        try {
          fs.rmSync(path.join(pastaXmls, pastaTipo, nome))
        } catch (e) {
          logger.warn('Relatório ou ZIP antigo não saiu da pasta', { arquivo: path.join(pastaTipo, nome), erro: e.code || e.message })
        }
      }
      removerVaziasDentro(path.join(pastaXmls, pastaTipo))
    }
  }

  for (const cliente of subpastas(pastaXmls, ops, '.')) {
    for (const base of basesDoCliente(pastaXmls, cliente)) {
      for (const nome of subpastas(pastaXmls, ops, base)) {
        if (nome === PASTAS.semData) arrumarQuando(path.join(base, nome))
        else if (/^\d{4}$/.test(nome)) for (const mes of subpastas(pastaXmls, ops, path.join(base, nome))) arrumarQuando(path.join(base, nome, mes))
      }
    }
  }
  movedor.concluir()
  if (resultado.ignorados.length) logger.warn('Arquivos diferentes com o mesmo nome ficaram na pasta antiga do tipo', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('Pastas separadas em entradas e saídas', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * Tira eventos e resumos de entradas e saídas: <Direção>/<Tipo>/XML/(Eventos|Resumos) vai para Eventos e Resumos/<Tipo>.
 * Roda também com etapa anterior pendente, sem gravar a versão.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutEventos({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const versao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor
  if (![VERSAO_ANO_MES, VERSAO_PASTA_XML, VERSAO_MES, VERSAO_DIRECAO].includes(versao)) return resultado
  try {
    executarEventos({ db, pastaXmls, logger, podeGravarVersao: versao === VERSAO_DIRECAO, ops: { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }, resultado })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao separar eventos e resumos; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

function executarEventos({ db, pastaXmls, logger, podeGravarVersao, ops, resultado }) {
  const gravarVersao = () => {
    if (podeGravarVersao) db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_EVENTOS)
  }
  if (!fs.existsSync(pastaXmls)) {
    pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
    return
  }
  const movedor = criarMovedorDePastas({
    db,
    pastaXmls,
    logger,
    ops,
    resultado,
    precisa: (c) => comAvulsosNoLugar(c) !== c,
    novoCaminho: comAvulsosNoLugar,
  })
  const tipos = Object.values(PASTAS.modelo)
  const direcoes = Object.values(PASTAS.direcao)

  function arrumarQuando(quando) {
    for (const direcao of subpastas(pastaXmls, ops, quando).filter((n) => direcoes.includes(n))) {
      for (const tipo of subpastas(pastaXmls, ops, path.join(quando, direcao)).filter((n) => tipos.includes(n))) {
        const xml = path.join(quando, direcao, tipo, PASTAS.xml)
        if (!fs.existsSync(path.join(pastaXmls, xml))) continue
        for (const nome of subpastas(pastaXmls, ops, xml).filter((n) => n === PASTAS.evento || n === PASTAS.resumo)) {
          movedor.mover(path.join(xml, nome), path.join(quando, PASTAS.avulsos, tipo))
        }
      }
      removerVaziasDentro(path.join(pastaXmls, quando, direcao))
    }
  }

  for (const cliente of subpastas(pastaXmls, ops, '.')) {
    for (const base of basesDoCliente(pastaXmls, cliente)) {
      for (const nome of subpastas(pastaXmls, ops, base)) {
        if (nome === PASTAS.semData) arrumarQuando(path.join(base, nome))
        else if (/^\d{4}$/.test(nome)) for (const mes of subpastas(pastaXmls, ops, path.join(base, nome))) arrumarQuando(path.join(base, nome, mes))
      }
    }
  }
  movedor.concluir()
  if (resultado.ignorados.length) logger.warn('Arquivos diferentes com o mesmo nome ficaram em entradas ou saídas', { arquivos: resultado.ignorados })
  if (!resultado.pendentes.length) gravarVersao()
  if (resultado.movidos) logger.info('Eventos e resumos separados', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
}

/**
 * A pasta fora-da-carteira passa a se chamar Sem cliente cadastrado. Roda também com etapa anterior pendente, sem gravar a versão.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutSemCliente({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const versao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor
  if (![VERSAO_ANO_MES, VERSAO_PASTA_XML, VERSAO_MES, VERSAO_DIRECAO, VERSAO_EVENTOS].includes(versao)) return resultado
  const gravarVersao = () => {
    if (versao === VERSAO_EVENTOS) db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_SEM_CLIENTE)
  }
  try {
    if (!fs.existsSync(pastaXmls)) {
      pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
      return resultado
    }
    const ops = { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }
    const antiga = new RegExp(`(^|[\\\\/])${FORA_ANTIGA}(?=[\\\\/])`)
    const movedor = criarMovedorDePastas({
      db,
      pastaXmls,
      logger,
      ops,
      resultado,
      precisa: (c) => antiga.test(c),
      novoCaminho: (c) => c.replace(antiga, (_, barra) => `${barra}${PASTAS.foraDaCarteira}`),
    })
    for (const cliente of subpastas(pastaXmls, ops, '.')) {
      if (fs.existsSync(path.join(pastaXmls, cliente, FORA_ANTIGA))) movedor.mover(path.join(cliente, FORA_ANTIGA), path.join(cliente, PASTAS.foraDaCarteira))
    }
    movedor.concluir()
    if (!resultado.pendentes.length) gravarVersao()
    if (resultado.movidos) logger.info('Pasta das notas sem cliente renomeada', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao renomear a pasta das notas sem cliente; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
}

/**
 * Passa o tipo para antes da direção: <Direção>/<Tipo> vira <Tipo>/<Direção>, e Eventos e Resumos/<Tipo> vira <Tipo>/Eventos e Resumos.
 * Move as pastas inteiras: PDF, relatórios e ZIP continuam valendo. Roda também com etapa anterior pendente, sem gravar a versão.
 * @returns {{ movidos: number, ignorados: string[], pendentes: string[], erro?: string }}
 */
function migrarLayoutTipoPrimeiro({ db, pastaXmls, logger, fsOps = {} }) {
  const resultado = { movidos: 0, ignorados: [], pendentes: [] }
  const versao = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor
  if (![VERSAO_ANO_MES, VERSAO_PASTA_XML, VERSAO_MES, VERSAO_DIRECAO, VERSAO_EVENTOS, VERSAO_SEM_CLIENTE].includes(versao)) return resultado
  const gravarVersao = () => {
    if (versao === VERSAO_SEM_CLIENTE) db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_XML)
  }
  try {
    if (!fs.existsSync(pastaXmls)) {
      pastaIndisponivel({ db, pastaXmls, logger, gravarVersao, aviso: 'Pasta de XMLs indisponível; as pastas serão organizadas na próxima abertura' })
      return resultado
    }
    const ops = { renameSync: fs.renameSync, readdirSync: fs.readdirSync, ...fsOps }
    const movedor = criarMovedorDePastas({ db, pastaXmls, logger, ops, resultado, precisa: (c) => comTipoPrimeiro(c) !== c, novoCaminho: comTipoPrimeiro })
    const tipos = Object.values(PASTAS.modelo)
    const grupos = [...Object.values(PASTAS.direcao), PASTAS.avulsos]
    const arrumarQuando = (quando) => {
      for (const grupo of subpastas(pastaXmls, ops, quando).filter((n) => grupos.includes(n))) {
        for (const tipo of subpastas(pastaXmls, ops, path.join(quando, grupo)).filter((n) => tipos.includes(n))) {
          movedor.mover(path.join(quando, grupo, tipo), path.join(quando, tipo, grupo))
        }
        removerVaziasDentro(path.join(pastaXmls, quando, grupo))
      }
    }
    for (const cliente of subpastas(pastaXmls, ops, '.')) {
      for (const base of basesDoCliente(pastaXmls, cliente)) {
        for (const nome of subpastas(pastaXmls, ops, base)) {
          if (nome === PASTAS.semData) arrumarQuando(path.join(base, nome))
          else if (/^\d{4}$/.test(nome)) for (const mes of subpastas(pastaXmls, ops, path.join(base, nome))) arrumarQuando(path.join(base, nome, mes))
        }
      }
    }
    movedor.concluir()
    if (resultado.ignorados.length) logger.warn('Arquivos diferentes com o mesmo nome ficaram na pasta antiga', { arquivos: resultado.ignorados })
    if (!resultado.pendentes.length) gravarVersao()
    if (resultado.movidos) logger.info('Pastas com o tipo primeiro', { movidos: resultado.movidos, pendentes: resultado.pendentes.length })
  } catch (e) {
    resultado.erro = e.message
    logger.error('Falha ao passar o tipo para o começo das pastas; tenta de novo na próxima abertura', { erro: e.message })
  }
  return resultado
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

/**
 * Uma vez só: tira os resumos que sobraram de notas já completas e com o XML no disco. Os meses mudados voltam a ser gerados,
 * para o ZIP acompanhar. Espera as pastas no formato atual; arquivo preso ou pasta fora do ar tenta na próxima abertura.
 * @returns {{ apagados: number, falhas: number }}
 */
function limparResumosDeNotasCompletas({ db, pastaXmls, logger }) {
  const resultado = { apagados: 0, falhas: 0 }
  const valor = (chave) => db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(chave)
  if (valor('resumos_limpos') || valor('pastas_layout') !== VERSAO_XML || !fs.existsSync(pastaXmls)) return resultado
  const meses = new Map()
  for (const n of db.prepare("SELECT cliente_id, competencia, modelo, caminho_xml FROM notas WHERE status = 'completa' AND modelo = 'nfe' AND caminho_xml IS NOT NULL").all()) {
    const relativo = caminhoDoResumo(n.caminho_xml)
    if (!relativo) continue
    const resumo = path.join(pastaXmls, relativo)
    try {
      if (!fs.existsSync(resumo) || !fs.statSync(path.join(pastaXmls, n.caminho_xml)).size) continue
      fs.rmSync(resumo)
      resultado.apagados++
      meses.set(`${n.cliente_id}|${n.competencia}|${n.modelo}`, n)
      removerSeVazia(path.dirname(resumo))
    } catch (e) {
      if (e.code === 'ENOENT') continue // a nota está sem o arquivo: o resumo fica
      resultado.falhas++
      logger.warn('Resumo da nota completa não saiu da pasta; tenta de novo na próxima abertura', { arquivo: relativo, erro: e.code || e.message })
    }
  }
  const refazer = db.prepare('DELETE FROM pasta_grupos WHERE cliente_id = ? AND competencia = ? AND modelo = ?')
  db.transaction(() => {
    for (const n of meses.values()) refazer.run(n.cliente_id, n.competencia, n.modelo)
    if (!resultado.falhas) db.prepare("INSERT INTO sistema (chave, valor) VALUES ('resumos_limpos', '1') ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run()
  })()
  if (resultado.apagados) logger.info('Resumos de notas completas retirados', { ...resultado, meses: meses.size })
  return resultado
}

/**
 * Todas as mudanças, em ordem; quem já está na versão de uma delas passa direto. Só uma tentativa: o que faltar fica para a próxima.
 * @returns {{ movidos: number, pendentes: number, ignorados: number, erros: string[] }}
 */
function migrarLayouts({ db, pastaXmls, logger, fsOps = {} }) {
  const total = { movidos: 0, pendentes: 0, ignorados: 0, erros: [] }
  for (const migrar of [migrarPastas, migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro, migrarLayoutAnoMes, migrarLayoutPastaXml, migrarLayoutMesNumerado, migrarLayoutDirecao, migrarLayoutEventos, migrarLayoutSemCliente, migrarLayoutTipoPrimeiro]) {
    const r = migrar({ db, pastaXmls, logger, fsOps })
    total.movidos += r.movidos
    total.pendentes += r.pendentes.length
    total.ignorados += r.ignorados.length
    if (r.erro) total.erros.push(r.erro)
  }
  return total
}

module.exports = { migrarPastas, migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro, migrarLayoutAnoMes, migrarLayoutPastaXml, migrarLayoutMesNumerado, migrarLayoutDirecao, migrarLayoutEventos, migrarLayoutSemCliente, migrarLayoutTipoPrimeiro, migrarLayouts, limparResumosDeNotasCompletas, VERSAO_XML }
