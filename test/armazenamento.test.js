'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { caminhoDa, direcaoPelaChave, modeloPelaChave, nomes } = require('../src/services/armazenamento')

const cliente = { cnpj: '12138481000185', apelido: 'INOX' }
const escritorio = { cnpj: '01904741000160', apelido: 'escritorio' }
const p = (...partes) => path.join(...partes)

test('caminhoDa: nota, resumo e evento por ano, mês, modelo e direção', () => {
  const base = { cliente, competencia: '2026-10', nomeArquivo: 'x.xml' }
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada', categoria: 'nota' }), p('12138481000185_INOX', '2026', '10', 'NF-e', 'Entradas', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada', categoria: 'resumo' }), p('12138481000185_INOX', '2026', '10', 'NF-e', 'Entradas', 'Resumos', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfse', direcao: 'saida', categoria: 'evento' }), p('12138481000185_INOX', '2026', '10', 'NFS-e', 'Saidas', 'Eventos', 'x.xml'))
})

test('caminhoDa: fora da carteira e sem competência', () => {
  assert.equal(
    caminhoDa({ cliente: escritorio, foraDaCarteira: true, competencia: '2026-10', modelo: 'nfe', direcao: 'entrada', categoria: 'nota', nomeArquivo: 'x.xml' }),
    p('01904741000160_escritorio', 'fora-da-carteira', '2026', '10', 'NF-e', 'Entradas', 'x.xml'),
  )
  assert.equal(
    caminhoDa({ cliente, competencia: null, modelo: 'nfe', direcao: 'entrada', categoria: 'nota', nomeArquivo: 'x.xml' }),
    p('12138481000185_INOX', 'sem-data', 'NF-e', 'Entradas', 'x.xml'),
  )
})

test('direção e modelo pela chave', () => {
  const nfeDaInox = '23261012138481000185550010000157371500405319'
  const nfseDaInox = `230440012${cliente.cnpj}${'0'.repeat(27)}`
  assert.equal(nfseDaInox.length, 50)
  assert.equal(direcaoPelaChave(nfeDaInox, cliente.cnpj), 'saida')
  assert.equal(direcaoPelaChave(nfseDaInox, cliente.cnpj), 'saida')
  assert.equal(direcaoPelaChave(nfeDaInox, '10966475000190'), 'entrada')
  assert.equal(direcaoPelaChave(`230440012${'9'.repeat(14)}${'0'.repeat(27)}`, cliente.cnpj), 'entrada')
  assert.equal(modeloPelaChave(nfeDaInox), 'nfe')
  assert.equal(modeloPelaChave(nfseDaInox), 'nfse')
})

test('nome do arquivo da NFS-e', () => {
  assert.equal(nomes.nfse('1'.repeat(50)), `${'1'.repeat(50)}-nfse.xml`)
})

test('salvar regrava a declaração ISO-8859-1 como UTF-8', (t) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const { criarArmazenamento } = require('../src/services/armazenamento')
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-arm-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const arm = criarArmazenamento({ pastaXmls: pasta })
  const rel = arm.salvar({ cliente, competencia: '2026-01', modelo: 'nfse', nomeArquivo: 'x.xml', xml: "<?xml version='1.0' encoding='ISO-8859-1'?><a>São Paulo</a>" })
  const gravado = fs.readFileSync(arm.absoluto(rel), 'utf8')
  assert.equal(gravado, "<?xml version='1.0' encoding=\"UTF-8\"?><a>São Paulo</a>")
})
