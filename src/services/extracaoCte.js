'use strict'

const { xmlParaJson } = require('../sefaz/xml')
const { texto, pegar, competenciaDe } = require('./extracao')

// Extração do CT-e (cteProc e procEventoCTe, MOC 4.00; tolera o 3.00). Campo ausente vira null.

const textoEm = (obj, caminho) => texto(pegar(obj, caminho))

function numero(v) {
  const t = texto(v)
  const n = Number(t)
  return t !== null && Number.isFinite(n) ? n : null
}

/** O parser devolve objeto para um nó e array para vários: sempre array. */
const lista = (no) => (no === null || no === undefined ? [] : Array.isArray(no) ? no : [no])

const soDigitos = (v) => String(v || '').replace(/\D/g, '')

const chaveValida = (c) => (/^\d{44}$/.test(c || '') ? c : null)

function pessoa(no, tagEndereco) {
  if (!no || typeof no !== 'object') return null
  const e = pegar(no, tagEndereco) || {}
  return {
    documento: textoEm(no, 'CNPJ') || textoEm(no, 'CPF'),
    nome: textoEm(no, 'xNome'),
    ie: textoEm(no, 'IE'),
    endereco: {
      logradouro: textoEm(e, 'xLgr'),
      numero: textoEm(e, 'nro'),
      bairro: textoEm(e, 'xBairro'),
      municipio: textoEm(e, 'xMun'),
      uf: textoEm(e, 'UF'),
      cep: textoEm(e, 'CEP'),
      telefone: textoEm(no, 'fone') || textoEm(e, 'fone'),
    },
  }
}

/** Tomador: toma3 (0 remetente, 1 expedidor, 2 recebedor, 3 destinatário) ou toma4 (pessoa explícita). */
function tomadorDe(ide, partes) {
  const toma4 = pegar(ide, 'toma4') || pegar(ide, 'toma04')
  if (toma4) return pessoa(toma4, 'enderToma')
  const toma3 = pegar(ide, 'toma3') || pegar(ide, 'toma03')
  const quem = { 0: 'remetente', 1: 'expedidor', 2: 'recebedor', 3: 'destinatario' }[textoEm(toma3, 'toma')]
  return quem ? partes[quem] : null
}

function icmsDe(inf) {
  const grupo = pegar(inf, 'imp.ICMS') || {}
  const g = Object.values(grupo).find((v) => v && typeof v === 'object') || {}
  return {
    cst: textoEm(g, 'CST') || textoEm(g, 'indSN'),
    base: numero(pegar(g, 'vBC') ?? pegar(g, 'vBCOutraUF')),
    aliquota: numero(pegar(g, 'pICMS') ?? pegar(g, 'pICMSOutraUF')),
    valor: numero(pegar(g, 'vICMS') ?? pegar(g, 'vICMSOutraUF')),
  }
}

function docsDe(doc = {}) {
  return [
    ...lista(doc.infNFe).map((d) => ({ tipo: 'nfe', chave: textoEm(d, 'chave') })),
    ...lista(doc.infNF).map((d) => ({ tipo: 'nf', numero: textoEm(d, 'nDoc') })),
    ...lista(doc.infOutros).map((d) => ({ tipo: 'outro', numero: textoEm(d, 'nDoc') || textoEm(d, 'descOutros') })),
  ]
}

// Documentos originários: infDoc, os de cada contêiner do aquaviário e os CT-e anteriores (docAnt).
function documentosDe(inf) {
  const norm = pegar(inf, 'infCTeNorm') || {}
  const conteineres = lista(pegar(norm, 'infModal.aquav.detCont'))
  const anteriores = lista(pegar(norm, 'docAnt.emiDocAnt')).flatMap((e) =>
    lista(e.idDocAnt).flatMap((id) => lista(id.idDocAntEle).map((el) => ({ tipo: 'cte', chave: textoEm(el, 'chCTe') }))),
  )
  const todos = [...docsDe(norm.infDoc), ...conteineres.flatMap((c) => docsDe(c.infDoc)), ...anteriores]
  const vistos = new Set()
  return todos.filter((d) => {
    const id = `${d.tipo}:${d.chave || d.numero}`
    if (vistos.has(id)) return false
    vistos.add(id)
    return true
  })
}

function aquaviarioDe(inf) {
  const aq = pegar(inf, 'infCTeNorm.infModal.aquav')
  if (!aq) return null
  return { navio: textoEm(aq, 'xNavio'), viagem: textoEm(aq, 'nViag'), conteineres: lista(aq.detCont).map((c) => textoEm(c, 'nCont')).filter(Boolean) }
}

// xObs seguido das observações do contribuinte (ObsCont).
function observacoesDe(inf) {
  const cont = lista(pegar(inf, 'compl.ObsCont')).map((o) => textoEm(o, 'xTexto')).filter(Boolean)
  return [textoEm(inf, 'compl.xObs'), cont.join(' ')].filter(Boolean).join(' / ') || null
}

function dadosCte(xml) {
  const json = xmlParaJson(xml)
  const proc = pegar(json, 'cteProc') || json
  const inf = pegar(proc, 'CTe.infCte')
  if (!inf || typeof inf !== 'object') throw new Error('XML não é um CT-e')
  const prot = pegar(proc, 'protCTe.infProt')
  const ide = pegar(inf, 'ide') || {}
  const idChave = (textoEm(inf, '@_Id') || '').replace(/^CTe/, '')
  const partes = {
    remetente: pessoa(pegar(inf, 'rem'), 'enderReme'),
    destinatario: pessoa(pegar(inf, 'dest'), 'enderDest'),
    expedidor: pessoa(pegar(inf, 'exped'), 'enderExped'),
    recebedor: pessoa(pegar(inf, 'receb'), 'enderReceb'),
  }
  const carga = pegar(inf, 'infCTeNorm.infCarga') || {}
  const dataEmissao = textoEm(ide, 'dhEmi')
  return {
    chave: chaveValida(textoEm(prot, 'chCTe')) || chaveValida(idChave),
    numero: textoEm(ide, 'nCT'),
    serie: textoEm(ide, 'serie'),
    modelo: textoEm(ide, 'mod'),
    dataEmissao,
    competencia: competenciaDe(dataEmissao),
    cfop: textoEm(ide, 'CFOP'),
    natureza: textoEm(ide, 'natOp'),
    modal: textoEm(ide, 'modal'),
    tipoCte: textoEm(ide, 'tpCTe'),
    tipoServico: textoEm(ide, 'tpServ'),
    origem: { municipio: textoEm(ide, 'xMunIni'), uf: textoEm(ide, 'UFIni') },
    destino: { municipio: textoEm(ide, 'xMunFim'), uf: textoEm(ide, 'UFFim') },
    emitente: pessoa(pegar(inf, 'emit'), 'enderEmit'),
    ...partes,
    tomador: tomadorDe(ide, partes),
    valorPrestacao: numero(pegar(inf, 'vPrest.vTPrest')),
    valorReceber: numero(pegar(inf, 'vPrest.vRec')),
    componentes: lista(pegar(inf, 'vPrest.Comp')).map((c) => ({ nome: textoEm(c, 'xNome'), valor: numero(pegar(c, 'vComp')) })),
    icms: icmsDe(inf),
    carga: {
      valor: numero(pegar(carga, 'vCarga')),
      produto: textoEm(carga, 'proPred'),
      outras: textoEm(carga, 'xOutCat'),
      quantidades: lista(carga.infQ).map((q) => ({
        unidade: textoEm(q, 'cUnid'),
        tipo: textoEm(q, 'tpMed'),
        quantidade: numero(pegar(q, 'qCarga')),
      })),
    },
    documentos: documentosDe(inf),
    observacoes: observacoesDe(inf),
    rntrc: textoEm(inf, 'infCTeNorm.infModal.rodo.RNTRC'),
    aquaviario: aquaviarioDe(inf),
    protocolo: prot ? { numero: textoEm(prot, 'nProt'), data: textoEm(prot, 'dhRecbto'), cStat: textoEm(prot, 'cStat') } : null,
    ambiente: textoEm(ide, 'tpAmb') === '2' ? 'homologacao' : 'producao',
  }
}

/** Papel do cliente no CT-e: emitente → saída; tomador → entrada; demais participantes → outro; senão null. */
function papelDoCliente(dados, cnpjCliente) {
  const alvo = soDigitos(cnpjCliente)
  if (!alvo) return null
  const e = (p) => !!p && soDigitos(p.documento) === alvo
  if (e(dados.emitente)) return 'saida'
  if (e(dados.tomador)) return 'entrada'
  if ([dados.remetente, dados.destinatario, dados.expedidor, dados.recebedor].some(e)) return 'outro'
  return null
}

function dadosEventoCte(xml) {
  const json = xmlParaJson(xml)
  const inf = pegar(json, 'procEventoCTe.eventoCTe.infEvento') || {}
  const ret = pegar(json, 'procEventoCTe.retEventoCTe.infEvento') || {}
  return {
    chave: chaveValida(textoEm(inf, 'chCTe')),
    tpEvento: textoEm(inf, 'tpEvento'),
    nSeq: textoEm(inf, 'nSeqEvento') || '1',
    descricao: textoEm(inf, 'detEvento.evCancCTe.descEvento') || textoEm(inf, 'detEvento.descEvento') || textoEm(ret, 'xEvento'),
    dataEvento: textoEm(inf, 'dhEvento'),
    protocolo: textoEm(ret, 'nProt'),
  }
}

module.exports = { dadosCte, papelDoCliente, dadosEventoCte }
