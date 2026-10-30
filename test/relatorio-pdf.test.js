'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { montarRelatorioPdf } = require('../src/services/relatorioPdf')

const fortaleza = fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8')
const cliente = { cnpj: '12138481000185', nome: 'INOX' }
const nota = (i, extra = {}) => ({ modelo: 'nfe', tipo: 'entrada', numero: String(i), data_emissao: '2026-10-27T10:00:00-03:00', emitente_cnpj: '34950246000146', emitente_nome: 'UBIRATAN', destinatario_cnpj: cliente.cnpj, destinatario_nome: 'INOX', valor_total: 100, status: 'completa', cancelada: 0, chave: String(i).padStart(44, '0'), competencia: '2026-10', ...extra })
const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length

test('PDF do mês de um modelo: uma página com poucas notas, várias quando a lista é longa', async () => {
  const curto = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'nfe', lerXml: () => null, notas: [nota(1), nota(2, { tipo: 'saida' })] })
  assert.equal(curto.subarray(0, 5).toString(), '%PDF-')
  assert.equal(paginas(curto), 1)

  const longo = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'nfe', lerXml: () => null, notas: Array.from({ length: 80 }, (_, i) => nota(i + 1)) })
  assert.ok(paginas(longo) >= 3, `esperava 3+ páginas, veio ${paginas(longo)}`)
})

test('NFS-e lê as retenções do XML; mês sem notas ainda gera o PDF', async () => {
  const nfse = nota(9, { modelo: 'nfse', caminho_xml: 'x' })
  const pdf = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'nfse', lerXml: () => fortaleza, notas: [nfse] })
  assert.equal(paginas(pdf), 1)
  const vazio = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'nfse', lerXml: () => null, notas: [] })
  assert.equal(paginas(vazio), 1)
})
