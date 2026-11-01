'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { criarClienteCte, criarFabricaCte } = require('../src/sefaz/cte')
const { criarCteMock } = require('../src/sefaz/cte-mock')

const CNPJ = '11222333000181'
const zip = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64')

function resposta({ cStat, xMotivo, ultNSU = '000000000000000', maxNSU = '000000000000000', docs = [] }) {
  const lote = docs.length
    ? `<loteDistDFeInt>${docs.map((d) => `<docZip NSU="${d.nsu}" schema="${d.schema}">${zip(d.xml)}</docZip>`).join('')}</loteDistDFeInt>`
    : ''
  return '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
    + '<cteDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe"><cteDistDFeInteresseResult>'
    + `<retDistDFeInt versao="1.00" xmlns="http://www.portalfiscal.inf.br/cte"><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
    + `<dhResp>2026-10-31T13:55:36</dhResp><ultNSU>${ultNSU}</ultNSU><maxNSU>${maxNSU}</maxNSU>${lote}</retDistDFeInt>`
    + '</cteDistDFeInteresseResult></cteDistDFeInteresseResponse></soap:Body></soap:Envelope>'
}

function cliente(corpoResposta, opcoes = {}) {
  const enviados = []
  const requisitar = async (url, corpo, cabecalhos) => {
    enviados.push({ url, corpo, cabecalhos })
    if (opcoes.lancar) throw new Error(opcoes.lancar)
    return { status: opcoes.status || 200, corpo: corpoResposta }
  }
  return { enviados, c: criarClienteCte({ cnpj: CNPJ, uf: 'CE', requisitar, ...opcoes.cliente }) }
}

test('envelope: tpAmb, cUFAutor, CNPJ e ultNSU com 15 dígitos, URL de produção', async () => {
  const { enviados, c } = cliente(resposta({ cStat: '137', xMotivo: 'Nenhum documento localizado.' }))
  await c.consultarLote('39')
  const [e] = enviados
  assert.equal(e.url, 'https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx')
  assert.match(e.corpo, /<tpAmb>1<\/tpAmb>/)
  assert.match(e.corpo, /<cUFAutor>23<\/cUFAutor>/)
  assert.match(e.corpo, new RegExp(`<CNPJ>${CNPJ}</CNPJ>`))
  assert.match(e.corpo, /<ultNSU>000000000000039<\/ultNSU>/)
  assert.match(e.cabecalhos['Content-Type'], /^application\/soap\+xml; charset=utf-8; action="http:\/\/www\.portalfiscal\.inf\.br\/cte\/wsdl\/CTeDistribuicaoDFe\/cteDistDFeInteresse"$/)
})

test('homologação usa hom1 e tpAmb 2; UF do cliente define o cUFAutor', async () => {
  const { enviados, c } = cliente(resposta({ cStat: '137', xMotivo: 'x' }), { cliente: { producao: false, uf: 'SP' } })
  await c.consultarLote('0')
  assert.equal(enviados[0].url, 'https://hom1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx')
  assert.match(enviados[0].corpo, /<tpAmb>2<\/tpAmb>/)
  assert.match(enviados[0].corpo, /<cUFAutor>35<\/cUFAutor>/)
})

test('138 com dois docZip: nsu, schema, xml decodificado, ultNSU e maxNSU', async () => {
  const docs = [
    { nsu: '000000000000040', schema: 'procCTe_v4.00.xsd', xml: '<cteProc><CTe>um</CTe></cteProc>' },
    { nsu: '000000000000041', schema: 'procEventoCTe_v4.00.xsd', xml: '<procEventoCTe>dois ção</procEventoCTe>' },
  ]
  const { c } = cliente(resposta({ cStat: '138', xMotivo: 'Documento localizado', ultNSU: '000000000000041', maxNSU: '000000000000050', docs }))
  const r = await c.consultarLote('39')
  assert.equal(r.ok, true)
  assert.equal(r.cStat, '138')
  assert.equal(r.ultNSU, '000000000000041')
  assert.equal(r.maxNSU, '000000000000050')
  assert.deepEqual(r.documentos, docs.map((d) => ({ nsu: d.nsu, schema: d.schema, xml: d.xml })))
})

test('docZip ilegível vem com erroLeitura e não derruba os outros', async () => {
  const corpo = resposta({ cStat: '138', xMotivo: 'ok', docs: [{ nsu: '1', schema: 'procCTe_v4.00.xsd', xml: '<a/>' }] })
    .replace('</loteDistDFeInt>', '<docZip NSU="2" schema="procCTe_v4.00.xsd">bm9wZQ==</docZip></loteDistDFeInt>')
  const { c } = cliente(corpo)
  const r = await c.consultarLote('0')
  assert.equal(r.documentos[0].xml, '<a/>')
  assert.equal(r.documentos[1].xml, null)
  assert.ok(r.documentos[1].erroLeitura)
})

test('docZip com prefixo de namespace, aspas simples e atributos em outra ordem', async () => {
  const xml = '<cteProc><CTe>prefixo</CTe></cteProc>'
  const corpo = resposta({ cStat: '138', xMotivo: 'ok', ultNSU: '000000000000007', maxNSU: '000000000000007' })
    .replace('<maxNSU>', `<ns2:loteDistDFeInt><ns2:docZip schema='procCTe_v4.00.xsd' NSU = '000000000000007'>${zip(xml)}</ns2:docZip></ns2:loteDistDFeInt><maxNSU>`)
  const { c } = cliente(corpo)
  const r = await c.consultarLote('6')
  assert.deepEqual(r.documentos, [{ nsu: '000000000000007', schema: 'procCTe_v4.00.xsd', xml }])
})

test('137: ok sem documentos', async () => {
  const { c } = cliente(resposta({ cStat: '137', xMotivo: 'Nenhum documento localizado.' }))
  const r = await c.consultarLote('0')
  assert.equal(r.ok, true)
  assert.equal(r.cStat, '137')
  assert.deepEqual(r.documentos, [])
})

test('656: não ok, com o xMotivo no erro', async () => {
  const { c } = cliente(resposta({ cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' }))
  const r = await c.consultarLote('0')
  assert.equal(r.ok, false)
  assert.equal(r.cStat, '656')
  assert.match(r.erro, /Consumo Indevido/)
})

test('HTTP 500 e falha de rede', async () => {
  const a = await cliente('erro interno', { status: 500 }).c.consultarLote('0')
  assert.equal(a.ok, false)
  assert.match(a.erro, /^HTTP 500/)
  const b = await cliente('', { lancar: 'ECONNRESET' }).c.consultarLote('0')
  assert.equal(b.ok, false)
  assert.equal(b.erro, 'Sem conexão com a SEFAZ (CT-e): ECONNRESET')
})

test('resposta que não é SOAP de distribuição', async () => {
  const r = await cliente('<html>oi</html>').c.consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /inválida/)
})

test('fábrica: certificado ilegível devolve cliente que responde Certificado indisponível', async () => {
  const fabrica = criarFabricaCte({ pastaCerts: '/nao/existe', masterKey: 'x', tpAmb: '2' })
  const r = await fabrica({ cnpj: CNPJ, uf: 'CE', cert_arquivo: 'x.pfx', cert_senha_enc: 'a:b:c' }).consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /^Certificado indisponível: /)
})

test('simulado: fila por CNPJ, lotes, 137, responder e falhar', async () => {
  const mock = criarCteMock({ tamanhoLote: 2, documentos: { [CNPJ]: [{ xml: '<a/>' }, { xml: '<b/>' }, { xml: '<c/>', schema: 'procEventoCTe_v4.00.xsd' }] } })
  const c = mock.cliente(CNPJ)
  const l1 = await c.consultarLote('0')
  assert.equal(l1.cStat, '138')
  assert.deepEqual(l1.documentos.map((d) => d.nsu), ['000000000000001', '000000000000002'])
  assert.equal(l1.ultNSU, '000000000000002')
  assert.equal(l1.maxNSU, '000000000000003')
  assert.equal(l1.documentos[0].schema, 'procCTe_v4.00.xsd')
  const l2 = await c.consultarLote(l1.ultNSU)
  assert.equal(l2.documentos.length, 1)
  assert.equal(l2.documentos[0].schema, 'procEventoCTe_v4.00.xsd')
  const l3 = await c.consultarLote(l2.ultNSU)
  assert.equal(l3.cStat, '137')
  assert.equal(l3.ok, true)
  mock.responder(CNPJ, { cStat: '656', xMotivo: 'Consumo Indevido' })
  const r = await c.consultarLote('0')
  assert.equal(r.ok, false)
  assert.equal(r.cStat, '656')
  mock.responder(CNPJ, null)
  mock.falhar(CNPJ, 'caiu')
  assert.equal((await c.consultarLote('0')).erro, 'caiu')
  mock.falhar(CNPJ, null)
  mock.adicionar(CNPJ, [{ xml: '<d/>' }])
  assert.equal((await c.consultarLote('000000000000003')).documentos.length, 1)
  assert.equal(mock.chamadas.length, 6)
})
