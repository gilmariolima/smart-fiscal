'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { criarClienteAdn } = require('../src/sefaz/adn')
const { criarAdnMock, xmlNfse, chaveNfse } = require('../src/sefaz/adn-mock')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const zip = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const resposta = (status, corpo) => async () => ({ status, corpo: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) })

test('lote com documentos: descompacta, decodifica e devolve NSU como texto', async () => {
  const xml = xmlNfse({ chave: chaveNfse('99888777000166', 1), prestador: '99888777000166', tomador: CNPJ_MOCK_OK })
  const urls = []
  const requisitar = async (url) => {
    urls.push(url)
    return resposta(200, { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', Erros: [], LoteDFe: [{ NSU: 7, ChaveAcesso: 'x', TipoDocumento: 'NFSE', ArquivoXml: zip(xml), DataHoraGeracao: '2026-10-27T10:00:00' }] })()
  }
  const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar }).consultarLote('6')
  assert.equal(urls[0], 'https://adn.nfse.gov.br/contribuintes/DFe/6?lote=true')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'DOCUMENTOS_LOCALIZADOS')
  assert.deepEqual(r.documentos.map((d) => [d.nsu, d.tipo, d.xml]), [['7', 'NFSE', xml]])
})

test('homologação usa a produção restrita', async () => {
  const urls = []
  const requisitar = async (url) => (urls.push(url), { status: 200, corpo: '{"StatusProcessamento":"NENHUM_DOCUMENTO_LOCALIZADO"}' })
  await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, producao: false, requisitar }).consultarLote('0')
  assert.equal(urls[0], 'https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/0?lote=true')
})

test('nenhum documento (200 ou 404) não é erro', async () => {
  for (const status of [200, 404]) {
    const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar: resposta(status, { StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] }) }).consultarLote('9')
    assert.deepEqual({ ok: r.ok, documentos: r.documentos, erro: r.erro }, { ok: true, documentos: [], erro: null })
  }
})

test('erros viram ok:false sem lançar', async () => {
  const casos = [
    [resposta(403, 'Forbidden'), /HTTP 403/],
    [resposta(200, { StatusProcessamento: 'REJEICAO', Erros: [{ Codigo: 'E1', Descricao: 'Certificado inválido' }] }), /Certificado inválido/],
    [async () => { throw new Error('ETIMEDOUT') }, /ETIMEDOUT/],
    [resposta(200, '<html>manutenção</html>'), /resposta inválida/i],
  ]
  for (const [requisitar, msg] of casos) {
    const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar }).consultarLote('0')
    assert.equal(r.ok, false)
    assert.match(r.erro, msg)
  }
})

test('certificado que não abre vira erro na consulta', async () => {
  const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, pfx: Buffer.from('lixo'), passphrase: 'x' }).consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /Certificado indisponível/)
})

test('simulador entrega em lotes a partir do NSU pedido', async () => {
  const mock = criarAdnMock({ tamanhoLote: 2 })
  const c = mock.cliente(CNPJ_MOCK_OK)
  const l1 = await c.consultarLote('0')
  const l2 = await c.consultarLote(l1.documentos.at(-1).nsu)
  const l3 = await c.consultarLote(l2.documentos.at(-1).nsu)
  assert.deepEqual([l1, l2].map((l) => l.documentos.map((d) => d.nsu)), [['1', '2'], ['3', '4']])
  assert.deepEqual(l3, { ok: true, status: 'NENHUM_DOCUMENTO_LOCALIZADO', documentos: [], erro: null })
  assert.deepEqual(mock.chamadas.map((ch) => ch.nsu), ['0', '2', '4'])
})

test('fábrica: simulado com SEFAZ_MOCK e erro claro sem certificado', async () => {
  const { criarFabricaAdn } = require('../src/sefaz/adn')
  const simulado = criarFabricaAdn({ sefazMock: true })({ cnpj: CNPJ_MOCK_OK })
  assert.equal((await simulado.consultarLote('0')).ok, true)
  const semCert = criarFabricaAdn({ sefazMock: false, pastaCerts: '/nao/existe', masterKey: '0'.repeat(64) })({ cnpj: CNPJ_MOCK_OK, cert_arquivo: 'x.pfx', cert_senha_enc: 'a:b:c' })
  const r = await semCert.consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /Certificado indisponível/)
})

test('um documento com gzip quebrado não derruba o lote', async () => {
  const xml = xmlNfse({ chave: chaveNfse('99888777000166', 1), prestador: '99888777000166', tomador: CNPJ_MOCK_OK })
  const requisitar = resposta(200, { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [
    { NSU: 1, TipoDocumento: 'NFSE', ArquivoXml: 'nao-e-gzip' },
    { NSU: 2, TipoDocumento: 'NFSE', ArquivoXml: zip(xml) },
  ] })
  const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar }).consultarLote('0')
  assert.equal(r.ok, true)
  assert.equal(r.documentos[0].xml, null)
  assert.match(r.documentos[0].erroLeitura, /.+/)
  assert.equal(r.documentos[1].xml, xml)
})

test('429: espera e tenta de novo até dar certo', async () => {
  const respostas = [{ status: 429, corpo: '' }, { status: 429, corpo: '' }, { status: 200, corpo: '{"StatusProcessamento":"NENHUM_DOCUMENTO_LOCALIZADO"}' }]
  const esperas = []
  const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar: async () => respostas.shift(), dormir: async (ms) => esperas.push(ms) }).consultarLote('0')
  assert.equal(r.ok, true)
  assert.deepEqual(esperas, [5000, 15000])
})

test('429 insistente: desiste com mensagem clara depois de 3 esperas', async () => {
  let pedidos = 0
  const esperas = []
  const r = await criarClienteAdn({ cnpj: CNPJ_MOCK_OK, requisitar: async () => (pedidos++, { status: 429, corpo: '' }), dormir: async (ms) => esperas.push(ms) }).consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /ADN pediu para esperar/)
  assert.equal(pedidos, 4)
  assert.deepEqual(esperas, [5000, 15000, 30000])
})
