'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { gerarDacte } = require('../src/services/dacte/gerar')
const { cteProc, chaveCte, TRANSP } = require('./apoio/cte')

const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length
const chaveNfe = (i) => `42261${String(i).padStart(39, '0')}`

test('DACTE de 1 folha com 2 NF-e', async () => {
  const pdf = await gerarDacte(cteProc({ nfes: [chaveNfe(1), chaveNfe(2)] }))
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.equal(paginas(pdf), 1)
})

test('DACTE com 200 chaves continua em outras folhas', async () => {
  const nfes = Array.from({ length: 200 }, (_, i) => chaveNfe(i + 1))
  const pdf = await gerarDacte(cteProc({ nfes }))
  assert.ok(paginas(pdf) >= 2)
})

test('DACTE cancelado e de homologação são gerados', async () => {
  const a = await gerarDacte(cteProc({ nfes: [chaveNfe(1)] }), { situacao: 'cancelado' })
  const b = await gerarDacte(cteProc({ tpAmb: '2', chave: chaveCte(TRANSP, 5) }))
  assert.equal(a.subarray(0, 5).toString(), '%PDF-')
  assert.equal(b.subarray(0, 5).toString(), '%PDF-')
})

test('XML de NF-e é recusado', async () => {
  await assert.rejects(gerarDacte('<nfeProc><NFe><infNFe Id="NFe1"/></NFe></nfeProc>'), /não é um CT-e/)
})
