'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
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

// Texto das páginas: abre os streams e junta os trechos hex de cada TJ (fontes padrão em WinAnsi).
function textoDoPdf(pdf) {
  const partes = []
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let conteudo
    try { conteudo = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { continue }
    for (const tj of conteudo.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      partes.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''))
    }
  }
  return partes.join('\n')
}

test('CT-e: uma página com Entradas, Saídas e Outros; mês só com outros gera PDF sem erro', async () => {
  const { cteProc } = require('./apoio/cte')
  const cte = nota(5, { modelo: 'cte', caminho_xml: 'x' })
  const pdf = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'cte', lerXml: () => cteProc({}), notas: [cte, nota(6, { modelo: 'cte', tipo: 'saida' }), nota(7, { modelo: 'cte', tipo: 'outro' })] })
  assert.equal(paginas(pdf), 1)
  const texto = textoDoPdf(pdf)
  for (const s of ['Entradas (1)', 'Saídas (1)', 'Outros (1)']) assert.ok(texto.includes(s), `faltou "${s}"`)
  assert.ok(!textoDoPdf(await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'nfe', lerXml: () => null, notas: [nota(1)] })).includes('Outros'), 'NF-e sem a seção Outros')
  const outros = await montarRelatorioPdf({ cliente, competencia: '2026-10', modelo: 'cte', lerXml: () => null, notas: [nota(8, { modelo: 'cte', tipo: 'outro' })] })
  assert.equal(outros.subarray(0, 5).toString(), '%PDF-')
})
