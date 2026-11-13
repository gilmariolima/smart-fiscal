'use strict'

// Download de NF-e pela chave no portal DF-e da SVRS, com o certificado A1 de quem participou da nota.
// Serve para nota fora da janela de ~90 dias da distribuição (cStat 632). Sem captcha, sem token e sem cookie:
// um POST do formulário devolve a página com o XML dentro de `var stringJson = { "xml": ... }`.
// A SVRS bloqueia o IP com consultas seguidas ("múltiplas consultas"): quem chama controla o ritmo.

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { descriptografar } = require('../crypto')
const { agenteDoCertificado } = require('./certificado')

const ENDERECO = 'https://dfe-portal.svrs.rs.gov.br/NfeSSL/DownloadXmlDfe'
const TIMEOUT_MS = 60e3
// Entidades HTML que a SVRS usa nos acentos (a página mistura UTF-8 direto e &#244;, &atilde;...).
const ENTIDADES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', atilde: 'ã', otilde: 'õ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', acirc: 'â', ecirc: 'ê', ocirc: 'ô', ccedil: 'ç', agrave: 'à' }
const decodificar = (t) =>
  t
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m)
const semTags = (html) =>
  decodificar(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
// Sem depender do acento: "IP não autorizado devido múltiplas consultas".
const BLOQUEIO = /IP n\S{1,8}o autorizado|m\S{1,8}ltiplas consultas/i

/** Lê a página de resposta: o XML do stringJson ou o motivo da recusa. */
function lerRespostaSvrs(html) {
  const m = /var\s+stringJson\s*=\s*(\{[\s\S]*?\});/.exec(html || '')
  if (m) {
    try {
      const xml = JSON.parse(m[1]).xml
      if (typeof xml === 'string' && xml.includes('<')) return { xml }
    } catch {}
  }
  const texto = semTags(html)
  if (/difere do CNPJ base dos envolvidos/i.test(texto)) return { motivo: 'nao-envolvido', mensagem: mensagemDe(texto) }
  if (BLOQUEIO.test(texto)) return { motivo: 'bloqueado', mensagem: mensagemDe(texto) }
  return { motivo: 'erro', mensagem: mensagemDe(texto) || 'Resposta inesperada da SVRS', repetir: true }
}

// O que a SVRS escreveu depois de "Consulta realizada em : <data hora>", sem o rodapé da página.
function mensagemDe(texto) {
  const depois = /Consulta realizada em\s*:\s*[\d/]+\s+[\d:]+\s*(.*)$/i.exec(texto)?.[1]
  if (!depois) return ''
  return depois.split(/Entrar com|Janela de Manuten/i)[0].trim().slice(0, 300)
}

function requisitarHttps(agent) {
  return (corpo) =>
    new Promise((resolve, reject) => {
      const req = https.request(ENDERECO, { method: 'POST', agent, timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo) } }, (res) => {
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(partes).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('A SVRS não respondeu em 60 s')))
      req.on('error', reject)
      req.end(corpo)
    })
}

/**
 * @param {{ pfx?: Buffer, passphrase?: string, requisitar?: (corpo: string) => Promise<{ status: number, html: string }> }} opcoes
 */
function criarClienteSvrs({ pfx, passphrase, requisitar } = {}) {
  const enviar = requisitar || requisitarHttps(agenteDoCertificado(pfx, passphrase))
  /** @returns {Promise<{ xml: string } | { motivo: 'nao-envolvido' | 'bloqueado' | 'erro', mensagem: string, repetir?: boolean }>} */
  async function baixarNfe(chave) {
    const corpo = new URLSearchParams({ sistema: 'Nfe', OrigemSite: '0', Ambiente: '1', ChaveAcessoDfe: chave }).toString()
    let r
    try {
      r = await enviar(corpo)
    } catch (e) {
      return { motivo: 'erro', mensagem: `Sem resposta da SVRS: ${e.message}`, repetir: true, semResposta: true }
    }
    if (r.status >= 500) return { motivo: 'erro', mensagem: `A SVRS respondeu ${r.status}`, repetir: true, semResposta: true }
    return lerRespostaSvrs(r.html)
  }
  return { baixarNfe }
}

// SVRS simulada (SEFAZ_MOCK): entrega a NF-e cujo emitente na chave é o cliente; nas outras, o certificado não é de envolvido.
function svrsSimulada(cliente) {
  const html = (miolo) => `<i>Consulta realizada em : 01/01/2026 00:00:00</i> ${miolo}`
  return criarClienteSvrs({
    requisitar: async (corpo) => {
      const chave = new URLSearchParams(corpo).get('ChaveAcessoDfe')
      if (chave.slice(6, 20) !== cliente.cnpj) return { status: 200, html: html('CNPJ base do certificado digital (CNPJ8) informado difere do CNPJ base dos envolvidos (CNPJ8).') }
      return { status: 200, html: `<script>var stringJson = {"xml": ${JSON.stringify(xmlSimulado(chave))}};</script>${html('')}` }
    },
  })
}

function xmlSimulado(chave) {
  const ns = 'http://www.portalfiscal.inf.br/nfe'
  const ano = `20${chave.slice(2, 4)}`
  const mes = chave.slice(4, 6)
  const dh = `${ano}-${mes}-10T10:00:00-03:00`
  const numero = String(Number(chave.slice(25, 34)))
  return `<nfeProc xmlns="${ns}" versao="4.00"><NFe xmlns="${ns}"><infNFe Id="NFe${chave}" versao="4.00">` +
    `<ide><cUF>${chave.slice(0, 2)}</cUF><natOp>VENDA</natOp><mod>55</mod><serie>${Number(chave.slice(22, 25))}</serie><nNF>${numero}</nNF><dhEmi>${dh}</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb></ide>` +
    `<emit><CNPJ>${chave.slice(6, 20)}</CNPJ><xNome>EMITENTE SIMULADO</xNome><IE>060000001</IE></emit>` +
    `<dest><CNPJ>55666777000181</CNPJ><xNome>DESTINATARIO SIMULADO</xNome></dest>` +
    `<total><ICMSTot><vNF>150.00</vNF></ICMSTot></total></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>${dh}</dhRecbto><nProt>123000000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`
}

/** (linha de clientes) => cliente da SVRS com o certificado dela. */
function criarFabricaSvrs(config) {
  if (config.sefazMock) return svrsSimulada
  return (cliente) =>
    criarClienteSvrs({ pfx: fs.readFileSync(path.join(config.pastaCerts, cliente.cert_arquivo)), passphrase: descriptografar(cliente.cert_senha_enc, config.masterKey) })
}

module.exports = { lerRespostaSvrs, criarClienteSvrs, criarFabricaSvrs }
