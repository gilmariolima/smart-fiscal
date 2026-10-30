'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { gerarDanfe } = require('../src/services/danfe/gerar')
const { barrasC } = require('../src/services/danfe/code128')
const { nfeProc, item } = require('./apoio/nfe')

const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length

test('DANFE de uma NF-e: PDF de uma folha', async () => {
  const pdf = await gerarDanfe(nfeProc({ det: item(1) + item(2) }))
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.equal(paginas(pdf), 1)
})

test('muitos itens continuam nas folhas seguintes; cancelada também gera', async () => {
  const det = Array.from({ length: 90 }, (_, i) => item(i + 1)).join('')
  const pdf = await gerarDanfe(nfeProc({ det }), { situacao: 'cancelada' })
  assert.equal(paginas(pdf), 2, "a folha 1 leva parte dos itens, a 2 o resto")
})

test('XML que não é NF-e é recusado', async () => {
  await assert.rejects(gerarDanfe('<CompNfse/>'), /não é uma NF-e/)
})

test('código de barras Code 128 C da chave: início C, verificador e parada', () => {
  const b = barrasC('42260705125498000132550010000316551000877213')
  assert.ok(b.barras.length > 0)
  // 10 de margem + 11 módulos por símbolo (início, 22 pares, verificador) + 13 da parada + 10 de margem
  assert.equal(b.largura, 10 + 11 * 24 + 13 + 10)
  assert.equal(barrasC('123'), null)
})
