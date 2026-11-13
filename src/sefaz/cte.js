'use strict'

// Cliente do CTeDistribuicaoDFe (distribuição de CT-e por NSU, SOAP 1.2) com o certificado A1 do próprio CNPJ.
// Verificado na homologação: POST no .asmx, Content-Type application/soap+xml com a action, resposta retDistDFeInt.
// O .pfx é aberto pelo node-forge e passado ao https em PEM (o OpenSSL 3 recusa o RC2 de certificados antigos).
// A conexão sempre verifica o servidor: `ca` = raízes do Node + cadeia ICP-Brasil do node-mde.

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const tls = require('node:tls')
const zlib = require('node:zlib')
const { agenteDoCertificado: agenteComCertificado } = require('./certificado')
const { descriptografar } = require('../crypto')
const { decodificarXml } = require('../services/extracaoNfse')
const { dadosUf } = require('./uf')

const CAMINHO = '/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx'
const PRODUCAO = `https://www1.cte.fazenda.gov.br${CAMINHO}`
const HOMOLOGACAO = `https://hom1.cte.fazenda.gov.br${CAMINHO}`
const ACAO = 'http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe/cteDistDFeInteresse'
const TIMEOUT_MS = 60e3
const UF_PADRAO = '23'

const agenteDoCertificado = (pfx, passphrase) => agenteComCertificado(pfx, passphrase, { ca: [...tls.rootCertificates, ...require('node-mde/lib/env').CA] })

function requisitarHttps(agent) {
  return (url, corpo, cabecalhos) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', agent, headers: cabecalhos, timeout: TIMEOUT_MS }, (res) => {
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }))
      })
      req.on('timeout', () => req.destroy(new Error(`timeout de ${TIMEOUT_MS / 1000} s`)))
      req.on('error', reject)
      req.end(corpo)
    })
}

function envelope({ tpAmb, cUFAutor, cnpj, ultNSU }) {
  return '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>'
    + '<cteDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDadosMsg>'
    + `<distDFeInt versao="1.00" xmlns="http://www.portalfiscal.inf.br/cte"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cUFAutor}</cUFAutor><CNPJ>${cnpj}</CNPJ>`
    + `<distNSU><ultNSU>${ultNSU}</ultNSU></distNSU></distDFeInt></cteDadosMsg></cteDistDFeInteresse></soap12:Body></soap12:Envelope>`
}

// Elementos com ou sem prefixo de namespace (ns2:docZip); atributos com aspas simples ou duplas, em qualquer ordem.
const tag = (xml, nome) => xml.match(new RegExp(`<(?:\\w+:)?${nome}>([^<]*)</(?:\\w+:)?${nome}>`))?.[1] ?? null
const atributo = (atributos, nome) => atributos.match(new RegExp(`(?:^|\\s)${nome}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? null
const nsu15 = (n) => String(n || '0').replace(/\D/g, '').padStart(15, '0')

/**
 * @param {object} opcoes
 * @param {string} [opcoes.uf] sigla da UF do cliente (cUFAutor); sem ela ou inválida, 23 (CE)
 * @param {Function} [opcoes.requisitar] (url, corpo, cabecalhos) => Promise<{ status, corpo }>, injetável nos testes
 * @returns {{ cnpj: string, consultarLote(ultNSU: string): Promise<{ ok, cStat, xMotivo, ultNSU, maxNSU, documentos, erro }> }}
 */
function criarClienteCte({ cnpj, uf, pfx, passphrase, producao = true, requisitar }) {
  const url = producao ? PRODUCAO : HOMOLOGACAO
  let cUFAutor = UF_PADRAO
  try {
    cUFAutor = dadosUf(uf).codigo
  } catch {
    cUFAutor = UF_PADRAO
  }
  let pedir = requisitar
  const falha = (erro, extra = {}) => ({ ok: false, cStat: null, xMotivo: null, ultNSU: null, maxNSU: null, documentos: [], erro, ...extra })

  async function consultarLote(ultNSU) {
    if (!pedir) {
      try {
        pedir = requisitarHttps(agenteDoCertificado(pfx, passphrase))
      } catch (e) {
        return falha(`Certificado indisponível: ${e.message}`)
      }
    }
    const corpo = envelope({ tpAmb: producao ? '1' : '2', cUFAutor, cnpj, ultNSU: nsu15(ultNSU) })
    const cabecalhos = { 'Content-Type': `application/soap+xml; charset=utf-8; action="${ACAO}"` }
    let r
    try {
      r = await pedir(url, corpo, cabecalhos)
    } catch (e) {
      return falha(`Sem conexão com a SEFAZ (CT-e): ${e.message}`)
    }
    const xml = String(r.corpo || '')
    if (r.status !== 200) {
      const motivo = xml.match(/<(?:\w+:)?Text[^>]*>([^<]*)</)?.[1]
      return falha(`HTTP ${r.status}${motivo ? `: ${motivo}` : ''}`)
    }
    const ret = xml.match(/<(?:\w+:)?retDistDFeInt\b[^>]*>([\s\S]*?)<\/(?:\w+:)?retDistDFeInt>/)?.[1]
    const cStat = ret && tag(ret, 'cStat')
    if (!cStat) return falha('Resposta inválida da SEFAZ (CT-e)')
    const xMotivo = tag(ret, 'xMotivo')
    const retorno = { cStat, xMotivo, ultNSU: tag(ret, 'ultNSU'), maxNSU: tag(ret, 'maxNSU') }
    if (cStat !== '137' && cStat !== '138') return falha(`${cStat} ${xMotivo || ''}`.trim(), retorno)
    // Documento a documento: um XML ilegível não pode impedir os outros nem travar a fila.
    const documentos = [...ret.matchAll(/<(?:\w+:)?docZip\b([^>]*)>([^<]*)<\/(?:\w+:)?docZip>/g)].map(([, atributos, conteudo]) => {
      const doc = { nsu: atributo(atributos, 'NSU'), schema: atributo(atributos, 'schema'), xml: null }
      try {
        doc.xml = decodificarXml(zlib.gunzipSync(Buffer.from(conteudo.trim(), 'base64')))
      } catch (e) {
        doc.erroLeitura = e.message
      }
      return doc
    })
    return { ok: true, ...retorno, documentos, erro: null }
  }

  return { cnpj, consultarLote }
}

let mockCompartilhado = null

/** Fábrica usada pelos serviços: linha de `clientes` → cliente do CT-e (ou o simulado, com SEFAZ_MOCK=1). */
function criarFabricaCte(config) {
  if (config.sefazMock) {
    if (!mockCompartilhado) mockCompartilhado = require('./cte-mock').criarCteMock()
    return (cliente) => mockCompartilhado.cliente(cliente.cnpj)
  }
  return (cliente) => {
    try {
      return criarClienteCte({
        cnpj: cliente.cnpj,
        uf: cliente.uf,
        pfx: fs.readFileSync(path.join(config.pastaCerts, cliente.cert_arquivo)),
        passphrase: descriptografar(cliente.cert_senha_enc, config.masterKey),
        producao: config.tpAmb === '1',
      })
    } catch (e) {
      const erro = `Certificado indisponível: ${e.message}`
      return { cnpj: cliente.cnpj, consultarLote: async () => ({ ok: false, cStat: null, xMotivo: null, ultNSU: null, maxNSU: null, documentos: [], erro }) }
    }
  }
}

module.exports = { criarClienteCte, criarFabricaCte }
