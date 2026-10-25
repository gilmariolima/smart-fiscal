'use strict'

// Exercita o node-mde de verdade (montagem, assinatura, gzip e parse) contra um
// servidor HTTP local que responde como a SEFAZ.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { criarClienteSefaz, criarFabricaSefaz } = require('../src/sefaz/client')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')
const { criptografar } = require('../src/crypto')
const { gerarPfx } = require('./apoio/certificado')

const { pfx, senha } = gerarPfx()
const CHAVE = '23261012345678000195550010000010011000070071'

function envelope(corpo) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${corpo}</soap:Body></soap:Envelope>`
}

function respostaDistribuicao() {
  const resumo = `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${CHAVE}</chNFe><CNPJ>12345678000195</CNPJ><xNome>Fornecedor Alfa Ltda</xNome><IE>061234567</IE><dhEmi>2026-10-08T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1500.00</vNF><cSitNFe>1</cSitNFe></resNFe>`
  const zip = zlib.gzipSync(resumo).toString('base64')
  return envelope(`<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>` +
    `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>2</tpAmb><verAplic>1.0</verAplic><cStat>138</cStat><xMotivo>Documento localizado</xMotivo>` +
    `<dhResp>2026-10-09T10:00:00-03:00</dhResp><ultNSU>000000000000001</ultNSU><maxNSU>000000000000001</maxNSU>` +
    `<loteDistDFeInt><docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${zip}</docZip></loteDistDFeInt></retDistDFeInt>` +
    `</nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse>`)
}

function respostaEvento() {
  return envelope(`<nfeRecepcaoEventoNFResult xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">` +
    `<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>7</idLote><tpAmb>2</tpAmb><verAplic>1.0</verAplic><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo>` +
    `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>1.0</verAplic><cOrgao>91</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${CHAVE}</chNFe><tpEvento>210210</tpEvento><xEvento>Ciencia da Operacao</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>2026-10-09T10:00:00-03:00</dhRegEvento><nProt>891260000000001</nProt></infEvento></retEvento>` +
    `</retEnvEvento></nfeRecepcaoEventoNFResult>`)
}

let servidor
let baseURL
const recebidos = []
let proximoStatus = 200
let corpoErro = 'erro interno'

test.before(async () => {
  servidor = http.createServer((req, res) => {
    let corpo = ''
    req.on('data', (c) => (corpo += c))
    req.on('end', () => {
      recebidos.push(corpo)
      res.writeHead(proximoStatus, { 'Content-Type': 'application/soap+xml; charset=utf-8' })
      res.end(proximoStatus !== 200 ? corpoErro : corpo.includes('distDFeInt') ? respostaDistribuicao() : respostaEvento())
    })
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  baseURL = `http://127.0.0.1:${servidor.address().port}`
})

test.after(() => servidor.close())

const novoCliente = (extra = {}) =>
  criarClienteSefaz({ cnpj: CNPJ_MOCK_OK, uf: 'CE', pfx, passphrase: senha, tpAmb: '2', opcoesHttp: { baseURL, timeout: 5000 }, ...extra })

test('consultaUltNSU: monta o pedido e descompacta o docZip', async () => {
  proximoStatus = 200
  const r = await novoCliente().consultaUltNSU('0')
  assert.equal(r.error, undefined)
  assert.equal(r.data.cStat, '138')
  assert.equal(r.data.docZip.length, 1)
  assert.equal(r.data.docZip[0].nsu, '000000000000001')
  assert.equal(r.data.docZip[0].json.resNFe.chNFe, CHAVE)
  assert.equal(r.data.docZip[0].json.resNFe.vNF, '1500.00')

  const pedido = recebidos.at(-1)
  assert.match(pedido, /<cUFAutor>23<\/cUFAutor>/)
  assert.match(pedido, /<CNPJ>11222333000181<\/CNPJ>/)
  assert.match(pedido, /<ultNSU>000000000000000<\/ultNSU>/)
  assert.ok(!('reqXml' in r) && !('resXml' in r))
})

test('enviarEvento: assina o evento e lê o retorno', async () => {
  proximoStatus = 200
  const r = await novoCliente().enviarEvento({ idLote: 7, lote: [{ chNFe: CHAVE, tipoEvento: 210210 }] })
  assert.equal(r.error, undefined)
  assert.equal(r.data.cStat, '128')
  assert.equal(r.data.infEvento[0].cStat, '135')
  assert.equal(r.data.infEvento[0].nProt, '891260000000001')

  const pedido = recebidos.at(-1)
  assert.match(pedido, /<tpEvento>210210<\/tpEvento>/)
  assert.match(pedido, /<descEvento>Ciencia da Operacao<\/descEvento>/)
  assert.match(pedido, /<SignatureValue>[^<]+<\/SignatureValue>/)
  assert.match(pedido, /<dhEvento>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-03:00<\/dhEvento>/)
})

test('HTTP de erro vira { error } sem exceção', async () => {
  proximoStatus = 500
  const r = await novoCliente().consultaChNFe(CHAVE)
  proximoStatus = 200
  assert.match(r.error, /erro interno/)
})

test('página HTML de 403 (certificado recusado) vira mensagem curta', async () => {
  proximoStatus = 403
  corpoErro = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>403 - Forbidden: Access is denied.</title><style>body{margin:0}</style></head><body><h1>Server Error</h1></body></html>'
  const r = await novoCliente().consultaUltNSU('0')
  proximoStatus = 200
  corpoErro = 'erro interno'
  assert.match(r.error, /^A SEFAZ recusou o certificado \(HTTP 403: 403 - Forbidden: Access is denied\.\)/)
  assert.doesNotMatch(r.error, /<|style/)
})

test('validações do node-mde viram { error } sem exceção', async () => {
  const c = novoCliente()
  assert.match((await c.consultaChNFe('123')).error, /tamanho incorreto/)
  const lote21 = Array.from({ length: 21 }, () => ({ chNFe: CHAVE, tipoEvento: 210210 }))
  assert.match((await c.enviarEvento({ idLote: 1, lote: lote21 })).error, /20 eventos/)
})

test('senha errada ou pfx inválido viram { error }', async () => {
  assert.ok((await novoCliente({ passphrase: 'errada' }).consultaUltNSU('0')).error)
  assert.ok((await novoCliente({ pfx: Buffer.from('lixo') }).consultaUltNSU('0')).error)
})

test('UF inválida lança erro na criação', () => {
  assert.throws(() => novoCliente({ uf: 'XX' }), /UF inválida/)
})

test('fábrica real: certificado ausente vira cliente que só devolve error', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-certs-'))
  const chave = 'b'.repeat(64)
  const fabrica = criarFabricaSefaz({ sefazMock: false, pastaCerts: pasta, masterKey: chave, tpAmb: '2' })
  const r = await fabrica({ cnpj: CNPJ_MOCK_OK, uf: 'CE', cert_arquivo: 'naoexiste.pfx', cert_senha_enc: criptografar(senha, chave) }).consultaUltNSU('0')
  assert.match(r.error, /Certificado indisponível/)

  fs.writeFileSync(path.join(pasta, 'ok.pfx'), pfx)
  const c = fabrica({ cnpj: CNPJ_MOCK_OK, uf: 'CE', cert_arquivo: 'ok.pfx', cert_senha_enc: criptografar(senha, chave) })
  assert.equal(typeof c.consultaUltNSU, 'function')
  fs.rmSync(pasta, { recursive: true, force: true })
})

test('fábrica com SEFAZ_MOCK usa a SEFAZ simulada com estado compartilhado', async () => {
  const fabrica = criarFabricaSefaz({ sefazMock: true })
  const r = await fabrica({ cnpj: CNPJ_MOCK_OK }).consultaUltNSU('0')
  assert.equal(r.data.cStat, '138')
  assert.equal(r.data.verAplic, 'MOCK_1.0')
  // Outra fábrica no mesmo processo enxerga a mesma fila.
  const r2 = await criarFabricaSefaz({ sefazMock: true })({ cnpj: CNPJ_MOCK_OK }).consultaUltNSU(r.data.ultNSU)
  assert.equal(r2.data.docZip[0].nsu, '000000000000003')
})
