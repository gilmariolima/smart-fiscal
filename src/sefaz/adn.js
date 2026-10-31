'use strict'

// Cliente do ADN (Ambiente de Dados Nacional da NFS-e): distribuição por NSU com o certificado A1 do
// próprio CNPJ. O mesmo lote traz as notas em que o CNPJ é prestador, tomador ou intermediário.
// Desde 31/10/2026 o ADN recusa a consulta só pelo certificado (HTTP 400, REJEICAO, sem mensagem):
// é preciso mandar o CNPJ em `cnpjConsulta` (a resposta vem com TipoConsulta CnpjBase).
// O .pfx é aberto pelo node-forge e passado ao https em PEM (o OpenSSL 3 recusa o RC2 de certificados antigos).

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const zlib = require('node:zlib')
const forge = require('node-forge')
const { descriptografar } = require('../crypto')
const { decodificarXml } = require('../services/extracaoNfse')

const PRODUCAO = 'https://adn.nfse.gov.br'
const HOMOLOGACAO = 'https://adn.producaorestrita.nfse.gov.br'
const TIMEOUT_MS = 60e3
// HTTP 429: o ADN limita as consultas. Espera e tenta de novo; depois disso desiste até a próxima captura.
const ESPERAS_429_MS = [5000, 15000, 30000]
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))

function agenteDoCertificado(pfx, passphrase) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(pfx).toString('binary')), true, passphrase)
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].map((b) => b.key).filter(Boolean)
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean)
  if (!chaves.length || !certs.length) throw new Error('o arquivo não tem a chave e o certificado')
  const cert = certs.find((c) => c.publicKey?.n && c.publicKey.n.equals(chaves[0].n)) || certs[0]
  return new https.Agent({ key: forge.pki.privateKeyToPem(chaves[0]), cert: forge.pki.certificateToPem(cert), keepAlive: false })
}

function requisitarHttps(agent) {
  return (url) =>
    new Promise((resolve, reject) => {
      const req = https.get(url, { agent, headers: { Accept: 'application/json' }, timeout: TIMEOUT_MS }, (res) => {
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }))
      })
      req.on('timeout', () => req.destroy(new Error(`timeout de ${TIMEOUT_MS / 1000} s`)))
      req.on('error', reject)
    })
}

const mensagensDeErro = (erros) =>
  (Array.isArray(erros) ? erros : []).map((e) => [e?.Codigo, e?.Descricao || e?.Mensagem].filter(Boolean).join(' ')).filter(Boolean)

/**
 * @param {object} opcoes
 * @param {Function} [opcoes.requisitar] (url) => Promise<{ status, corpo }>, injetável nos testes
 * @returns {{ cnpj: string, consultarLote(nsu: string): Promise<{ ok, status, documentos, erro }> }}
 */
function criarClienteAdn({ cnpj, pfx, passphrase, producao = true, requisitar, dormir = dormirPadrao }) {
  const base = producao ? PRODUCAO : HOMOLOGACAO
  let pedir = requisitar
  const falha = (erro) => ({ ok: false, status: null, documentos: [], erro })

  async function consultarLote(nsu) {
    if (!pedir) {
      try {
        pedir = requisitarHttps(agenteDoCertificado(pfx, passphrase))
      } catch (e) {
        return falha(`Certificado indisponível: ${e.message}`)
      }
    }
    let r
    for (let tentativa = 0; ; tentativa++) {
      try {
        r = await pedir(`${base}/contribuintes/DFe/${Number(nsu) || 0}?lote=true&cnpjConsulta=${cnpj}`)
      } catch (e) {
        return falha(`Sem conexão com o ADN: ${e.message}`)
      }
      if (r.status !== 429) break
      if (tentativa >= ESPERAS_429_MS.length) return falha('ADN pediu para esperar (HTTP 429): consultas demais. Tenta de novo na próxima captura.')
      await dormir(ESPERAS_429_MS[tentativa])
    }
    let json = null
    try {
      json = JSON.parse(r.corpo)
    } catch {
      json = null
    }
    if (json?.StatusProcessamento === 'NENHUM_DOCUMENTO_LOCALIZADO') return { ok: true, status: json.StatusProcessamento, documentos: [], erro: null }
    const erros = mensagensDeErro(json?.Erros)
    if (r.status !== 200) {
      const recusada = json?.StatusProcessamento === 'REJEICAO' && !erros.length ? ': o ADN recusou a consulta sem dizer o motivo' : ''
      return falha(`HTTP ${r.status}${erros.length ? `: ${erros.join('; ')}` : recusada}`)
    }
    if (!json) return falha('Resposta inválida do ADN')
    if (erros.length) return falha(erros.join('; '))
    // Documento a documento: um XML ilegível não pode impedir os outros nem travar a fila.
    const documentos = (json.LoteDFe || []).map((d) => {
      const doc = { nsu: String(d.NSU), chave: d.ChaveAcesso || null, tipo: d.TipoDocumento, xml: null, geradoEm: d.DataHoraGeracao || null }
      try {
        doc.xml = decodificarXml(zlib.gunzipSync(Buffer.from(d.ArquivoXml, 'base64')))
      } catch (e) {
        doc.erroLeitura = e.message
      }
      return doc
    })
    return { ok: true, status: json.StatusProcessamento || null, documentos, erro: null }
  }

  return { cnpj, consultarLote }
}

let mockCompartilhado = null

/** Fábrica usada pelos serviços: linha de `clientes` → cliente do ADN (ou o simulado, com SEFAZ_MOCK=1). */
function criarFabricaAdn(config) {
  if (config.sefazMock) {
    if (!mockCompartilhado) mockCompartilhado = require('./adn-mock').criarAdnMock()
    return (cliente) => mockCompartilhado.cliente(cliente.cnpj)
  }
  return (cliente) => {
    try {
      return criarClienteAdn({
        cnpj: cliente.cnpj,
        pfx: fs.readFileSync(path.join(config.pastaCerts, cliente.cert_arquivo)),
        passphrase: descriptografar(cliente.cert_senha_enc, config.masterKey),
        producao: config.tpAmb === '1',
      })
    } catch (e) {
      return { cnpj: cliente.cnpj, consultarLote: async () => ({ ok: false, status: null, documentos: [], erro: `Certificado indisponível: ${e.message}` }) }
    }
  }
}

module.exports = { criarClienteAdn, criarFabricaAdn }
