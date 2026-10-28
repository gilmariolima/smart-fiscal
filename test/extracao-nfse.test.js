'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { decodificarXml, dadosNfse, dadosEventoNfse, ajustarFuso } = require('../src/services/extracaoNfse')

const fixture = (nome) => fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', nome), 'utf8')

test('NFS-e de Fortaleza (ISS municipal): fuso, competência, valor e papéis', () => {
  const d = dadosNfse(fixture('fortaleza.xml'))
  assert.equal(d.chave, '23044001299888777000166000000001776326010683819470')
  assert.equal(d.numero, '17763')
  assert.equal(d.prestadorCnpj, '99888777000166')
  assert.equal(d.tomadorCnpj, '11222333000181')
  assert.equal(d.intermediarioCnpj, null)
  assert.equal(d.valor, 150)
  assert.equal(d.dataEmissao, '2026-01-19T15:19:22-03:00')
  assert.equal(d.competencia, '2026-01')
  assert.equal(d.municipio, 'FORTALEZA')
  assert.equal(d.ambGer, '1')
})

test('NFS-e nacional de São Paulo: competência de dezembro emitida em janeiro', () => {
  const d = dadosNfse(fixture('nacional-sp.xml'))
  assert.equal(d.dataEmissao, '2026-01-02T17:45:40-03:00')
  assert.equal(d.competencia, '2025-12')
  assert.equal(d.valor, 1719.65)
  assert.equal(d.prestadorNome, 'TESTE XNOME')
  assert.equal(d.municipio, 'São Paulo')
})

test('intermediário', () => {
  const xml = fixture('fortaleza.xml').replace('</toma>', '</toma><interm><CNPJ>44333222000111</CNPJ></interm>')
  assert.equal(dadosNfse(xml).intermediarioCnpj, '44333222000111')
})

test('decodificarXml respeita a declaração ISO-8859-1', () => {
  const texto = fixture('nacional-sp.xml').replace('encoding="utf-8"', 'encoding="ISO-8859-1"')
  const buffer = Buffer.from(texto, 'latin1')
  assert.equal(dadosNfse(decodificarXml(buffer)).municipio, 'São Paulo')
  assert.equal(decodificarXml(Buffer.from(fixture('nacional-sp.xml'), 'utf8')).includes('São Paulo'), true)
})

test('evento de cancelamento', () => {
  const e = dadosEventoNfse(fixture('evento-cancelamento.xml'))
  assert.equal(e.chave, '23044001266555444000133000008390496526030732355071')
  assert.equal(e.tp_evento, '101101')
  assert.equal(e.n_seq, '001')
  assert.equal(e.descricao, 'Cancelamento de NFS-e')
  assert.equal(e.data_evento, '2026-03-02T23:02:18-03:00')
  assert.equal(e.completo, true)
})

test('evento de confirmação do tomador', () => {
  const e = dadosEventoNfse(fixture('evento-confirmacao.xml'))
  assert.equal(e.tp_evento, '203202')
  assert.equal(e.chave.length, 50)
})

test('ajustarFuso só mexe no -00:00/Z do sistema municipal', () => {
  assert.equal(ajustarFuso('2026-01-19T15:19:22-00:00', '1'), '2026-01-19T15:19:22-03:00')
  assert.equal(ajustarFuso('2026-01-19T15:19:22Z', '1'), '2026-01-19T15:19:22-03:00')
  assert.equal(ajustarFuso('2026-01-19T15:19:22-00:00', '2'), '2026-01-19T15:19:22-00:00')
  assert.equal(ajustarFuso('2026-01-02T17:45:40-03:00', '1'), '2026-01-02T17:45:40-03:00')
  assert.equal(ajustarFuso(null, '1'), null)
})

test('retenções: valores federais, ISS retido e total retido oficial (vTotalRet)', () => {
  const { retencoesNfse } = require('../src/services/extracaoNfse')
  const xml = fixture('fortaleza.xml')
    .replace('<vTotalRet>0.00</vTotalRet>', '<vTotalRet>101.70</vTotalRet>')
    .replace('<tpRetISSQN>1</tpRetISSQN>', '<tpRetISSQN>2</tpRetISSQN>')
    .replace(/<vPis>0\.00<\/vPis>\s*<vCofins>0\.00<\/vCofins>\s*<\/piscofins>/, '<vPis>0.98</vPis><vCofins>4.50</vCofins></piscofins><vRetCP>16.50</vRetCP><vRetIRRF>2.25</vRetIRRF><vRetCSLL>1.50</vRetCSLL>')
  assert.match(xml, /<vRetIRRF>2\.25/, 'fixture alterada')
  assert.deepEqual(retencoesNfse(xml), { valorServico: 150, issRetido: true, iss: 7.5, irrf: 2.25, csll: 1.5, inss: 16.5, pis: 0.98, cofins: 4.5, totalRetido: 101.7, valorLiquido: 150 })
})

test('retenções: nota sem retenção', () => {
  const { retencoesNfse } = require('../src/services/extracaoNfse')
  assert.deepEqual(retencoesNfse(fixture('nacional-sp.xml')), { valorServico: 1719.65, issRetido: false, iss: 49.86, irrf: 0, csll: 0, inss: 0, pis: 0, cofins: 0, totalRetido: 0, valorLiquido: 1719.65 })
})
