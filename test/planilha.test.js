'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { montarXlsx } = require('../src/services/planilha')
const { lerZip } = require('./apoio/zip')

test('xlsx com abas, cabeçalho, texto, número e data', async () => {
  const buf = await montarXlsx([
    { nome: 'NF-e', colunas: ['Número', 'Valor', 'Emissão'], linhas: [['190866', 144.5, '2026-10-27T10:00:00-03:00'], ['<A&B>', null, '']] },
    { nome: 'Retenções', colunas: ['Total'], linhas: [] },
  ])
  const zip = lerZip(buf)
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(zip.has(n), n)
  }
  const wb = zip.get('xl/workbook.xml').toString()
  assert.match(wb, /<sheet name="NF-e" sheetId="1"/)
  assert.match(wb, /<sheet name="Retenções" sheetId="2"/)
  const s1 = zip.get('xl/worksheets/sheet1.xml').toString()
  assert.match(s1, /<is><t>Número<\/t><\/is>/)
  assert.match(s1, /<is><t>190866<\/t><\/is>/, 'número da nota fica como texto')
  assert.match(s1, /<c r="B2" s="1"><v>144.5<\/v><\/c>/, 'valor como número com formato de moeda')
  assert.match(s1, /<c r="C2" s="2"><v>46322\.\d+<\/v><\/c>/, 'data como número de série do Excel')
  assert.match(s1, /&lt;A&amp;B&gt;/, 'texto escapado')
  assert.match(s1, /<autoFilter ref="A1:C3"\/>/)
})

test('nome de aba inválido ou longo é ajustado', async () => {
  const zip = lerZip(await montarXlsx([{ nome: 'Notas/de:Outubro*2026 com nome comprido demais', colunas: ['a'], linhas: [] }]))
  const nome = /<sheet name="([^"]+)"/.exec(zip.get('xl/workbook.xml').toString())[1]
  assert.ok(nome.length <= 31)
  assert.doesNotMatch(nome, /[\\/:*?[\]]/)
})
