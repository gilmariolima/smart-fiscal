'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { montarPlanilhaDoMes, COLUNAS_CTE, linhaCte } = require('../src/services/planilhaMes')
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
  assert.doesNotMatch(zip.get('xl/workbook.xml').toString(), /name="CT-e"/, 'sem CT-e no mês, sem a aba CT-e')

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

test('com modelo: abas Entradas e Saídas só daquele modelo; NFS-e com as retenções na linha', async () => {
  const saida = { ...nfse, tipo: 'saida', numero: '9', cancelada: 0 }
  const zip = lerZip(await montarPlanilhaDoMes({ notas: [nfe, nfse, saida], modelo: 'nfse', lerXml: (n) => (n.numero === '17763' ? fortaleza : null) }))
  assert.match(zip.get('xl/workbook.xml').toString(), /name="Entradas".*name="Saídas"/)
  const [cab, entrada, ...resto] = linhas(zip, 1)
  assert.deepEqual(cab.slice(0, 3), ['Número', 'Competência', 'Emissão'])
  assert.equal(resto.length, 0, 'a NF-e não entra')
  assert.equal(entrada[0], '17763')
  assert.deepEqual(entrada.slice(7, 17), ['150', '7.5', 'Não', '0', '0', '0', '0', '0', '0', '150'])
  const [, s] = linhas(zip, 2)
  assert.equal(s[0], '9')

  const soNfe = lerZip(await montarPlanilhaDoMes({ notas: [nfe, nfse], modelo: 'nfe', lerXml: () => null }))
  assert.equal(linhas(soNfe, 1)[1][0], '190866')
  assert.equal(linhas(soNfe, 2).length, 1, 'Saídas só com o cabeçalho')
})

const { cteProc } = require('./apoio/cte')
const cte = { modelo: 'cte', tipo: 'entrada', numero: '77', serie: '1', data_emissao: '2026-10-08T10:00:00-03:00', emitente_cnpj: '99888777000166', emitente_nome: 'TRANSPORTADORA', destinatario_cnpj: '11222333000181', destinatario_nome: 'DEST', valor_total: 1234.56, status: 'completa', cancelada: 0, chave: '4'.repeat(44), competencia: '2026-10', caminho_xml: 'x' }

test('CT-e: abas Entradas e Saídas com dados do XML; outros ficam fora; sem XML usa o banco', async () => {
  const saida = { ...cte, tipo: 'saida', numero: '8', caminho_xml: null }
  const outro = { ...cte, tipo: 'outro', numero: '99' }
  const zip = lerZip(await montarPlanilhaDoMes({ notas: [cte, saida, outro, nfe], modelo: 'cte', lerXml: () => cteProc({}) }))
  assert.match(zip.get('xl/workbook.xml').toString(), /name="Entradas".*name="Saídas"/)
  const [cab, entrada, ...resto] = linhas(zip, 1)
  assert.deepEqual(cab, COLUNAS_CTE)
  assert.equal(resto.length, 0)
  assert.equal(entrada[cab.indexOf('Valor do frete')], '1234.56')
  assert.equal(entrada[cab.indexOf('Origem')], 'Blumenau/SC')
  assert.equal(entrada[cab.indexOf('Destino')], 'Fortaleza/CE')
  assert.equal(entrada[cab.indexOf('Valor da carga')], '50000')
  const [, s, ...r2] = linhas(zip, 2)
  assert.equal(r2.length, 0)
  assert.equal(s[0], '8')
  assert.equal(linhaCte(saida, () => null)[cab.indexOf('Valor do frete')], 1234.56)
  assert.equal(linhaCte(saida, () => null)[cab.indexOf('Origem')], '')
})

test('planilha mista: aba CT-e só quando há CT-e de entrada ou saída', async () => {
  const comCte = lerZip(await montarPlanilhaDoMes({ notas: [nfe, cte], lerXml: () => null }))
  assert.match(comCte.get('xl/workbook.xml').toString(), /name="NF-e".*name="NFS-e".*name="Retenções".*name="CT-e"/)
  assert.equal(linhas(comCte, 4).length, 2)
  const soOutro = lerZip(await montarPlanilhaDoMes({ notas: [nfe, { ...cte, tipo: 'outro' }], lerXml: () => null }))
  assert.doesNotMatch(soOutro.get('xl/workbook.xml').toString(), /name="CT-e"/)
})

test('CT-e: mês só com outros gera as abas só com o cabeçalho', async () => {
  const zip = lerZip(await montarPlanilhaDoMes({ notas: [{ ...cte, tipo: 'outro' }], modelo: 'cte', lerXml: () => null }))
  assert.equal(linhas(zip, 1).length, 1)
  assert.equal(linhas(zip, 2).length, 1)
})
