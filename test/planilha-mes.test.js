'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { montarPlanilhaDoMes } = require('../src/services/planilhaMes')
const { lerZip } = require('./apoio/zip')

const fortaleza = fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8')

// Linhas de uma aba como texto (números e datas como estão no XML da planilha).
function linhas(zip, n) {
  const xml = zip.get(`xl/worksheets/sheet${n}.xml`).toString()
  return [...xml.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map(([, r]) => [...r.matchAll(/<c r="[A-Z]+\d+"[^>]*>(?:<is><t>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)].map((m) => m[1] ?? m[2]))
}

const nfe = { modelo: 'nfe', tipo: 'entrada', numero: '190866', serie: '1', data_emissao: '2026-10-27T10:00:00-03:00', emitente_cnpj: '34950246000146', emitente_nome: 'UBIRATAN', destinatario_cnpj: '12138481000185', destinatario_nome: 'INOX', valor_total: 144, status: 'completa', cancelada: 0, chave: '2'.repeat(44), competencia: '2026-10' }
const nfse = { modelo: 'nfse', tipo: 'entrada', numero: '17763', data_emissao: '2026-01-19T15:19:22-03:00', emitente_cnpj: '99888777000166', emitente_nome: 'PRESTADOR', destinatario_cnpj: '11222333000181', destinatario_nome: 'TOMADOR', valor_total: 150, status: 'completa', cancelada: 1, chave: '3'.repeat(50), competencia: '2026-01', caminho_xml: 'x' }

test('abas NF-e, NFS-e e Retenções com os dados de cada nota', async () => {
  const buf = await montarPlanilhaDoMes({ notas: [nfe, nfse], lerXml: (n) => (n.modelo === 'nfse' ? fortaleza : null) })
  const zip = lerZip(buf)
  assert.match(zip.get('xl/workbook.xml').toString(), /name="NF-e".*name="NFS-e".*name="Retenções"/)

  const [cabNfe, l1] = linhas(zip, 1)
  assert.deepEqual(cabNfe, ['Tipo', 'Número', 'Série', 'Emissão', 'CNPJ emitente', 'Emitente', 'CNPJ destinatário', 'Destinatário', 'Valor', 'Situação', 'Cancelada', 'Chave'])
  assert.deepEqual(l1.filter((_, i) => i !== 3), ['Entrada', '190866', '1', '34.950.246/0001-46', 'UBIRATAN', '12.138.481/0001-85', 'INOX', '144', 'XML completo', 'Não', '2'.repeat(44)])

  const [cabNfse, l2] = linhas(zip, 2)
  assert.deepEqual(cabNfse, ['Tipo', 'Número', 'Competência', 'Emissão', 'CNPJ prestador', 'Prestador', 'CNPJ tomador', 'Tomador', 'Valor do serviço', 'Cancelada', 'Chave'])
  assert.equal(l2[2], '01/2026')
  assert.equal(l2[9], 'Sim')

  const [cabRet, l3] = linhas(zip, 3)
  assert.deepEqual(cabRet, ['Tipo', 'Número', 'Competência', 'CNPJ prestador', 'Prestador', 'CNPJ tomador', 'Tomador', 'Valor do serviço', 'ISS', 'ISS retido', 'IRRF', 'CSLL', 'INSS', 'PIS', 'COFINS', 'Total retido', 'Valor líquido'])
  assert.deepEqual(l3.slice(7), ['150', '7.5', 'Não', '0', '0', '0', '0', '0', '0', '150'])
})

test('NFS-e sem XML no disco fica fora das retenções', async () => {
  const zip = lerZip(await montarPlanilhaDoMes({ notas: [nfse], lerXml: () => null }))
  assert.equal(linhas(zip, 3).length, 1, 'só o cabeçalho')
})

test('texto que parece fórmula continua texto', async () => {
  const zip = lerZip(await montarPlanilhaDoMes({ notas: [{ ...nfe, emitente_nome: '=HYPERLINK("http://x")' }], lerXml: () => null }))
  assert.match(zip.get('xl/worksheets/sheet1.xml').toString(), /t="inlineStr"><is><t>=HYPERLINK\(&quot;http:\/\/x&quot;\)<\/t>/)
  assert.doesNotMatch(zip.get('xl/worksheets/sheet1.xml').toString(), /<f>/)
})
