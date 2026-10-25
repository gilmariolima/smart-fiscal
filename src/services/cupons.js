'use strict'

// CF-e (Cupom Fiscal Eletrônico do SAT/MFE): o cliente emite na venda ao consumidor e o XML fica no
// computador dele. Não há serviço nacional para baixar como a NF-e: o escritório recebe os XMLs
// (soltos ou num ZIP) e importa aqui. Cada cupom vai para o cliente cadastrado com o CNPJ do emitente.
//
//   <PASTA_XMLS>/<CNPJ>_<apelido>/cfe/<AAAA-MM>/<chave>-cfe.xml        venda
//   <PASTA_XMLS>/<CNPJ>_<apelido>/cfe/<AAAA-MM>/<chave>-cfe-canc.xml   cancelamento (chave da venda)

const AdmZip = require('adm-zip')
const { xmlParaJson } = require('../sefaz/xml')
const { criarArmazenamento } = require('./armazenamento')

const LIMITE_ARQUIVOS_ZIP = 50000 // um ano de cupons de uma loja grande cabe com folga

const texto = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? String(v.value ?? '') : String(v)).trim()
const digitos = (v) => texto(v).replace(/\D/g, '')

function dataHora(dEmi, hEmi) {
  const d = digitos(dEmi)
  const h = digitos(hEmi).padEnd(6, '0')
  if (d.length !== 8) return null
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}`
}

const chaveDoId = (id) => digitos(String(id || '').replace(/^CFe/i, ''))

class ErroCupom extends Error {}

/**
 * Lê um XML de CF-e de venda (CFe) ou de cancelamento (CFeCanc).
 * @returns {{ tipo: 'venda'|'cancelamento', chave, chaveVenda?, cnpj, nome, numero, equipamento, caixa, dataHora, valor, destDoc, destNome, ambiente }}
 */
function lerCupom(xml) {
  let json
  try {
    json = xmlParaJson(String(xml).replace(/^﻿/, ''))
  } catch {
    throw new ErroCupom('XML inválido')
  }
  const raiz = json.CFe ? 'CFe' : json.CFeCanc ? 'CFeCanc' : null
  if (!raiz) throw new ErroCupom('não é um CF-e (falta a tag CFe ou CFeCanc)')
  const inf = json[raiz].infCFe
  if (!inf) throw new ErroCupom('CF-e sem infCFe')
  const ide = inf.ide || {}
  const emit = inf.emit || {}
  const chave = chaveDoId(inf['@_Id'])
  if (chave.length !== 44) throw new ErroCupom('CF-e sem a chave de acesso (o XML veio do aplicativo comercial, antes de passar pelo SAT/MFE?)')
  if (texto(ide.mod) && texto(ide.mod) !== '59') throw new ErroCupom(`modelo ${texto(ide.mod)} não é CF-e (59)`)
  const cnpj = digitos(emit.CNPJ)
  if (cnpj.length !== 14) throw new ErroCupom('CF-e sem o CNPJ do emitente')
  const dest = inf.dest || {}
  const base = {
    chave,
    cnpj,
    nome: texto(emit.xNome),
    numero: texto(ide.nCFe),
    equipamento: texto(ide.nserieSAT),
    caixa: texto(ide.numeroCaixa),
    dataHora: dataHora(ide.dEmi, ide.hEmi),
    ambiente: texto(ide.tpAmb),
  }
  if (raiz === 'CFeCanc') {
    const chaveVenda = chaveDoId(inf['@_chCanc'])
    if (chaveVenda.length !== 44) throw new ErroCupom('cancelamento sem a chave do cupom cancelado (chCanc)')
    return { ...base, tipo: 'cancelamento', chaveVenda, valor: Number(texto(inf.total?.vCFe)) || 0 }
  }
  if (!base.dataHora) throw new ErroCupom('CF-e sem data de emissão')
  return {
    ...base,
    tipo: 'venda',
    valor: Number(texto(inf.total?.vCFe)) || 0,
    destDoc: digitos(dest.CNPJ) || digitos(dest.CPF),
    destNome: texto(dest.xNome),
  }
}

/** Competência AAAA-MM pela chave (cUF + AAMM + ...): vale também quando o XML não traz a data. */
const competenciaDaChave = (chave) => `20${chave.slice(2, 4)}-${chave.slice(4, 6)}`

/** XMLs de uma lista de arquivos enviados ({ nome, conteudo }), abrindo os ZIPs. */
function* xmlsDosArquivos(arquivos) {
  for (const a of arquivos) {
    const nome = String(a.nome || 'arquivo')
    const ehZip = /\.zip$/i.test(nome) || (a.conteudo[0] === 0x50 && a.conteudo[1] === 0x4b)
    if (!ehZip) {
      yield { nome, conteudo: a.conteudo }
      continue
    }
    let entradas
    try {
      entradas = new AdmZip(a.conteudo).getEntries().filter((e) => !e.isDirectory && /\.xml$/i.test(e.entryName))
    } catch {
      yield { nome, erro: 'ZIP inválido ou corrompido' }
      continue
    }
    if (entradas.length > LIMITE_ARQUIVOS_ZIP) {
      yield { nome, erro: `ZIP com ${entradas.length} XMLs: divida em partes de até ${LIMITE_ARQUIVOS_ZIP}` }
      continue
    }
    for (const e of entradas) yield { nome: `${nome} › ${e.entryName}`, conteudo: e.getData() }
  }
}

function criarServicoCupons({ db, config, logger }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const sql = {
    clientePorCnpj: db.prepare("SELECT * FROM clientes WHERE cnpj = ? AND papel = 'cliente'"),
    cupomExiste: db.prepare('SELECT 1 FROM cupons WHERE chave = ?'),
    inserir: db.prepare(`INSERT INTO cupons (cliente_id, chave, numero, equipamento, caixa, data_emissao, competencia, valor_total,
        destinatario_doc, destinatario_nome, ambiente, caminho_xml)
      VALUES (@cliente_id, @chave, @numero, @equipamento, @caixa, @data_emissao, @competencia, @valor_total,
        @destinatario_doc, @destinatario_nome, @ambiente, @caminho_xml)`),
    cancExiste: db.prepare('SELECT 1 FROM cupons_cancelamentos WHERE chave_venda = ?'),
    inserirCanc: db.prepare(`INSERT INTO cupons_cancelamentos (chave_venda, chave, cliente_id, numero, equipamento, data_cancelamento, competencia, caminho_xml)
      VALUES (@chave_venda, @chave, @cliente_id, @numero, @equipamento, @data_cancelamento, @competencia, @caminho_xml)`),
    cupons: db.prepare(`SELECT c.*, k.chave AS chave_cancelamento, k.data_cancelamento, k.caminho_xml AS caminho_xml_canc
      FROM cupons c LEFT JOIN cupons_cancelamentos k ON k.chave_venda = c.chave
      WHERE c.cliente_id = ? AND c.competencia = ? ORDER BY c.data_emissao, c.equipamento, CAST(c.numero AS INTEGER)`),
    cancelamentosDoMes: db.prepare(`SELECT k.*, c.id AS cupom_id FROM cupons_cancelamentos k LEFT JOIN cupons c ON c.chave = k.chave_venda
      WHERE k.cliente_id = ? AND k.competencia = ?`),
    competencias: db.prepare(`SELECT competencia, COUNT(*) n FROM cupons WHERE cliente_id = ? GROUP BY competencia
      UNION SELECT competencia, 0 FROM cupons_cancelamentos WHERE cliente_id = ? ORDER BY competencia DESC`),
    cupom: db.prepare('SELECT c.*, k.caminho_xml AS caminho_xml_canc FROM cupons c LEFT JOIN cupons_cancelamentos k ON k.chave_venda = c.chave WHERE c.id = ?'),
  }

  /**
   * Importa os XMLs (soltos ou em ZIP). Cupom repetido é ignorado; cupom de CNPJ que não é cliente
   * cadastrado não entra e aparece em `foraDaCarteira`.
   */
  function importar(arquivos) {
    const r = { lidos: 0, importados: 0, cancelamentos: 0, repetidos: 0, foraDaCarteira: {}, invalidos: [], porCliente: {} }
    const gravar = db.transaction((c, cliente, xml) => {
      if (c.tipo === 'venda') {
        if (sql.cupomExiste.get(c.chave)) return 'repetido'
        const competencia = c.dataHora.slice(0, 7)
        const caminho = armazenamento.salvar({ cliente, competencia, subpasta: 'cfe', nomeArquivo: `${c.chave}-cfe.xml`, xml })
        sql.inserir.run({
          cliente_id: cliente.id, chave: c.chave, numero: c.numero, equipamento: c.equipamento, caixa: c.caixa,
          data_emissao: c.dataHora, competencia, valor_total: c.valor, destinatario_doc: c.destDoc || null,
          destinatario_nome: c.destNome || null, ambiente: c.ambiente, caminho_xml: caminho,
        })
        return 'importado'
      }
      if (sql.cancExiste.get(c.chaveVenda)) return 'repetido'
      // O cancelamento fica junto da venda (a competência sai da chave dela)
      const competencia = competenciaDaChave(c.chaveVenda)
      const caminho = armazenamento.salvar({ cliente, competencia, subpasta: 'cfe', nomeArquivo: `${c.chaveVenda}-cfe-canc.xml`, xml })
      sql.inserirCanc.run({
        chave_venda: c.chaveVenda, chave: c.chave, cliente_id: cliente.id, numero: c.numero, equipamento: c.equipamento,
        data_cancelamento: c.dataHora, competencia, caminho_xml: caminho,
      })
      return 'cancelamento'
    })

    for (const arq of xmlsDosArquivos(arquivos)) {
      if (arq.erro) {
        r.invalidos.push({ arquivo: arq.nome, erro: arq.erro })
        continue
      }
      r.lidos++
      let c
      try {
        c = lerCupom(arq.conteudo.toString('utf8'))
      } catch (e) {
        r.invalidos.push({ arquivo: arq.nome, erro: e instanceof ErroCupom ? e.message : 'não foi possível ler o arquivo' })
        continue
      }
      const cliente = sql.clientePorCnpj.get(c.cnpj)
      if (!cliente) {
        const f = (r.foraDaCarteira[c.cnpj] ||= { cnpj: c.cnpj, nome: c.nome, cupons: 0 })
        f.cupons++
        continue
      }
      const res = gravar(c, cliente, arq.conteudo.toString('utf8'))
      if (res === 'repetido') {
        r.repetidos++
        continue
      }
      if (res === 'importado') r.importados++
      else r.cancelamentos++
      const pc = (r.porCliente[cliente.cnpj] ||= { cnpj: cliente.cnpj, nome: cliente.apelido || cliente.razao_social, competencias: [] })
      const comp = c.tipo === 'venda' ? c.dataHora.slice(0, 7) : competenciaDaChave(c.chaveVenda)
      if (!pc.competencias.includes(comp)) pc.competencias.push(comp)
    }
    const resultado = { ...r, foraDaCarteira: Object.values(r.foraDaCarteira), porCliente: Object.values(r.porCliente) }
    logger.info('CF-e importados', { lidos: r.lidos, importados: r.importados, cancelamentos: r.cancelamentos, repetidos: r.repetidos, invalidos: r.invalidos.length })
    return resultado
  }

  function cliente(cnpj) {
    const c = sql.clientePorCnpj.get(digitos(cnpj))
    if (!c) throw new ErroCupom(`CNPJ ${digitos(cnpj)} não é um cliente cadastrado.`)
    return c
  }

  const competencias = (cnpj) => {
    const c = cliente(cnpj)
    const vistas = new Map()
    for (const l of sql.competencias.all(c.id, c.id)) vistas.set(l.competencia, (vistas.get(l.competencia) || 0) + l.n)
    return [...vistas].map(([competencia, cupons]) => ({ competencia, cupons }))
  }

  /** Cupons do mês e a conferência: totais, cancelados, números faltando por equipamento e avisos. */
  function mes(cnpj, competencia) {
    const c = cliente(cnpj)
    const cupons = sql.cupons.all(c.id, competencia).map((x) => ({ ...x, cancelado: !!x.chave_cancelamento }))
    const cancelamentos = sql.cancelamentosDoMes.all(c.id, competencia)
    return { cliente: { cnpj: c.cnpj, nome: c.apelido || c.razao_social }, competencia, cupons, conferencia: conferir(cupons, cancelamentos) }
  }

  function xml(id, cancelamento = false) {
    const c = sql.cupom.get(id)
    const rel = c && (cancelamento ? c.caminho_xml_canc : c.caminho_xml)
    return rel ? { relativo: rel, nome: `${c.chave}-cfe${cancelamento ? '-canc' : ''}.xml` } : null
  }

  return { importar, competencias, mes, xml }
}

/** Conferência do mês: o que o contador precisa olhar antes de fechar. */
function conferir(cupons, cancelamentos) {
  const validos = cupons.filter((c) => !c.cancelado)
  const cancelados = cupons.filter((c) => c.cancelado)
  const soma = (l) => Math.round(l.reduce((s, c) => s + (c.valor_total || 0), 0) * 100) / 100
  const porDia = new Map()
  for (const c of validos) {
    const dia = (c.data_emissao || '').slice(0, 10)
    const d = porDia.get(dia) || { dia, cupons: 0, valor: 0 }
    d.cupons++
    d.valor = Math.round((d.valor + (c.valor_total || 0)) * 100) / 100
    porDia.set(dia, d)
  }
  // Números faltando: venda e cancelamento usam a mesma sequência de cada equipamento
  const porEquipamento = new Map()
  const usar = (equip, numero) => {
    const n = Number(numero)
    if (!equip || !Number.isInteger(n) || n <= 0) return
    if (!porEquipamento.has(equip)) porEquipamento.set(equip, new Set())
    porEquipamento.get(equip).add(n)
  }
  for (const c of cupons) usar(c.equipamento, c.numero)
  for (const k of cancelamentos) usar(k.equipamento, k.numero)
  const faltando = []
  for (const [equipamento, nums] of porEquipamento) {
    const lista = [...nums].sort((a, b) => a - b)
    const buracos = []
    for (let i = 1; i < lista.length; i++) for (let n = lista[i - 1] + 1; n < lista[i] && buracos.length < 200; n++) buracos.push(n)
    if (buracos.length) faltando.push({ equipamento, primeiro: lista[0], ultimo: lista[lista.length - 1], numeros: buracos })
  }
  const avisos = []
  const homologacao = cupons.filter((c) => c.ambiente === '2').length
  if (homologacao) avisos.push(`${homologacao} cupom(ns) de teste (homologação, sem validade fiscal)`)
  const semVenda = cancelamentos.filter((k) => !k.cupom_id)
  if (semVenda.length) avisos.push(`${semVenda.length} cancelamento(s) sem o cupom de venda importado: importe o XML da venda`)
  for (const f of faltando) {
    const n = f.numeros.length
    avisos.push(`MFE ${f.equipamento}: ${n}${n === 200 ? '+' : ''} número(s) faltando entre ${f.primeiro} e ${f.ultimo} (ex.: ${f.numeros.slice(0, 5).join(', ')}): confira se todos os XMLs foram enviados`)
  }
  return {
    cupons: cupons.length,
    validos: validos.length,
    valor: soma(validos),
    cancelados: cancelados.length,
    valorCancelado: soma(cancelados),
    porDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    faltando,
    avisos,
  }
}

module.exports = { criarServicoCupons, lerCupom, conferir, ErroCupom }
