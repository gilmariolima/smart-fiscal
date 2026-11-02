'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { gerarDacte } = require('../src/services/dacte/gerar')
const zlib = require('node:zlib')
const { cteProc, cteAquaviario, chaveCte, TRANSP } = require('./apoio/cte')

const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length
// Texto das páginas: abre os streams e junta os trechos hex de cada TJ (fontes padrão em WinAnsi).
function textoDoPdf(pdf) {
  const bruto = pdf.toString('latin1')
  const partes = []
  for (const m of bruto.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let conteudo
    try { conteudo = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') } catch { continue }
    for (const tj of conteudo.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      partes.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''))
    }
  }
  return partes.join('\n')
}
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

test('DACTE aquaviário mostra NF-e do contêiner, CT-e anterior e dados do navio', async () => {
  const { xml, nfe, anterior } = cteAquaviario()
  const texto = textoDoPdf(await gerarDacte(xml))
  assert.match(texto, new RegExp(`NF-e ${nfe}`))
  assert.match(texto, new RegExp(`CT-e ${anterior}`))
  assert.match(texto, /MODAL AQUAVIÁRIO/)
  assert.doesNotMatch(texto, /MODAL RODOVIÁRIO/)
  assert.match(texto, /NAVIO EXEMPLO/)
  assert.match(texto, /ABCU1234567/)
})
