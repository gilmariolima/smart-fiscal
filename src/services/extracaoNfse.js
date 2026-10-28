'use strict'

// Leitura do XML da NFS-e Nacional (NFSe/infNFSe) e dos eventos (evento/infEvento) entregues pelo ADN.

const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

/** Texto do XML respeitando o encoding da declaração (ISO-8859-1/latin1 ou, por padrão, UTF-8). */
function decodificarXml(buffer) {
  const cabecalho = buffer.subarray(0, 200).toString('latin1')
  const encoding = /encoding\s*=\s*["']([^"']+)/i.exec(cabecalho)?.[1] || ''
  return buffer.toString(/^(iso-8859-1|latin-?1|windows-1252)$/i.test(encoding) ? 'latin1' : 'utf8')
}

/**
 * O sistema municipal (ambGer=1, como o ISS Fortaleza) grava a hora local com "-00:00" ou "Z".
 * Nesses casos a hora é de Brasília.
 */
function ajustarFuso(dh, ambGer) {
  if (!dh || String(ambGer) !== '1') return dh || null
  return String(dh).replace(/(-00:00|Z)$/, '-03:00')
}

const texto = (v) => (v === undefined || v === null || v === '' ? null : String(typeof v === 'object' ? v['#text'] ?? '' : v) || null)
const cnpjOuCpf = (p) => texto(p?.CNPJ) || texto(p?.CPF)
const numero = (v) => {
  const n = Number(texto(v))
  return Number.isFinite(n) && texto(v) !== null ? n : null
}

function dadosNfse(xml) {
  const inf = parser.parse(xml)?.NFSe?.infNFSe || {}
  const dps = inf.DPS?.infDPS || {}
  const ambGer = texto(inf.ambGer)
  const dCompet = texto(dps.dCompet)
  return {
    chave: String(inf['@_Id'] || '').replace(/^NFS/, '') || null,
    numero: texto(inf.nNFSe),
    prestadorCnpj: cnpjOuCpf(inf.emit) || cnpjOuCpf(dps.prest),
    prestadorNome: texto(inf.emit?.xNome) || texto(dps.prest?.xNome),
    tomadorCnpj: cnpjOuCpf(dps.toma),
    tomadorNome: texto(dps.toma?.xNome),
    intermediarioCnpj: cnpjOuCpf(dps.interm),
    valor: numero(dps.valores?.vServPrest?.vServ) ?? numero(inf.valores?.vLiq),
    dataEmissao: ajustarFuso(texto(dps.dhEmi) || texto(inf.dhProc), ambGer),
    competencia: dCompet ? dCompet.slice(0, 7) : null,
    municipio: texto(inf.xLocEmi),
    ambGer,
    descricaoServico: texto(dps.serv?.cServ?.xDescServ),
  }
}

/**
 * Retenções da NFS-e para o relatório do mês. O total retido oficial é o vTotalRet do ADN
 * (nas notas reais ele inclui PIS/COFINS mesmo sem tpRetPisCofins); os demais vêm como estão no XML.
 * ISS só conta como retido com tpRetISSQN 2 (pelo tomador) ou 3 (pelo intermediário).
 */
function retencoesNfse(xml) {
  const inf = parser.parse(xml)?.NFSe?.infNFSe || {}
  const valores = inf.DPS?.infDPS?.valores || {}
  const fed = valores.trib?.tribFed || {}
  const zero = (v) => numero(v) ?? 0
  return {
    valorServico: zero(valores.vServPrest?.vServ),
    issRetido: ['2', '3'].includes(texto(valores.trib?.tribMun?.tpRetISSQN)),
    iss: zero(inf.valores?.vISSQN),
    irrf: zero(fed.vRetIRRF),
    csll: zero(fed.vRetCSLL),
    inss: zero(fed.vRetCP),
    pis: zero(fed.piscofins?.vPis),
    cofins: zero(fed.piscofins?.vCofins),
    totalRetido: zero(inf.valores?.vTotalRet),
    valorLiquido: zero(inf.valores?.vLiq),
  }
}

function dadosEventoNfse(xml) {
  const inf = parser.parse(xml)?.evento?.infEvento || {}
  const ped = inf.pedRegEvento?.infPedReg || {}
  const tag = Object.keys(ped).find((k) => /^e\d{6}$/.test(k))
  const ambGer = texto(inf.ambGer)
  return {
    chave: texto(ped.chNFSe),
    tp_evento: tag ? tag.slice(1) : null,
    n_seq: texto(inf.nSeqEvento) || '1',
    descricao: tag ? texto(ped[tag]?.xDesc) : null,
    data_evento: ajustarFuso(texto(ped.dhEvento) || texto(inf.dhProc), ambGer),
    protocolo: texto(inf.nDFSe),
    completo: true,
  }
}

module.exports = { decodificarXml, ajustarFuso, dadosNfse, dadosEventoNfse, retencoesNfse }
