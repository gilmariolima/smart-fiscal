'use strict'

// Consulta cadastro da SEFAZ (CadConsultaCadastro4) pela SVRS: a inscrição estadual de um CNPJ, com qualquer
// certificado A1. Testado em 14/11/2026: a SVRS atende o Ceará (o endereço próprio do CE derruba a conexão).
// UFs com SEFAZ própria têm serviço próprio e ficam de fora.

const https = require('node:https')
const tls = require('node:tls')
const { XMLParser } = require('fast-xml-parser')
const { agenteDoCertificado } = require('./certificado')

const ENDERECO = 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx'
const TIMEOUT_MS = 30e3
const SEFAZ_PROPRIA = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP']
// Tamanho da IE por UF quando a SEFAZ devolve sem os zeros da frente.
const TAMANHO_IE = { CE: 9 }
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: true })
const lista = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])

function envelope(cnpj, uf) {
  return '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/CadConsultaCadastro4"><ConsCad xmlns="http://www.portalfiscal.inf.br/nfe" versao="2.00">' +
    `<infCons><xServ>CONS-CAD</xServ><UF>${uf}</UF><CNPJ>${cnpj}</CNPJ></infCons></ConsCad></nfeDadosMsg></soap12:Body></soap12:Envelope>`
}

/** Lê o retConsCad: { ie, situacao, nome } ou lança Error com a mensagem para a pessoa. */
function lerRetornoCadastro(xml, uf) {
  let inf
  try {
    inf = parser.parse(xml)?.Envelope?.Body?.nfeResultMsg?.retConsCad?.infCons
  } catch {
    inf = null
  }
  if (!inf?.cStat) throw new Error('A SEFAZ deu uma resposta inesperada na consulta da inscrição estadual')
  if (inf.cStat === '259') throw new Error(`Este CNPJ não tem inscrição estadual no ${uf}`)
  if (inf.cStat !== '111' && inf.cStat !== '112') throw new Error(`SEFAZ: ${inf.xMotivo || inf.cStat}`)
  const cadastros = lista(inf.infCad)
  const escolhido = cadastros.find((c) => c.cSit === '1') || cadastros[0]
  if (!escolhido?.IE) throw new Error(`Este CNPJ não tem inscrição estadual no ${uf}`)
  const ie = String(escolhido.IE).replace(/\D/g, '')
  return { ie: TAMANHO_IE[uf] ? ie.padStart(TAMANHO_IE[uf], '0') : ie, situacao: escolhido.cSit ?? null, nome: escolhido.xNome || null }
}

function requisitarHttps(agent) {
  return (url, corpo) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', agent, timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) } }, (res) => {
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('a SEFAZ não respondeu em 30 s')))
      req.on('error', reject)
      req.end(corpo)
    })
}

/**
 * @param {{ cnpj: string, uf: string, pfx?: Buffer, passphrase?: string, requisitar?: Function }} opcoes
 * @returns {Promise<{ ie: string, situacao: string|null, nome: string|null }>}
 */
async function consultarCadastro({ cnpj, uf, pfx, passphrase, requisitar }) {
  uf = String(uf || '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(uf)) throw new Error('Preencha a UF para consultar a inscrição estadual')
  if (SEFAZ_PROPRIA.includes(uf)) throw new Error(`A consulta da inscrição estadual de ${uf} não está disponível (estado com SEFAZ própria)`)
  const enviar = requisitar || requisitarHttps(agenteDoCertificado(pfx, passphrase, { ca: [...tls.rootCertificates, ...require('node-mde/lib/env').CA] }))
  let r
  try {
    r = await enviar(ENDERECO, envelope(cnpj, uf))
  } catch (e) {
    throw new Error(`Sem resposta da SEFAZ na consulta da inscrição estadual: ${e.message}`)
  }
  return lerRetornoCadastro(r.corpo, uf)
}

module.exports = { consultarCadastro, lerRetornoCadastro }
