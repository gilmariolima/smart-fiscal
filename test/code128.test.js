'use strict'

// O módulo é do painel (ESM); o pacote é CommonJS, então o teste importa uma cópia .mjs.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function carregar(t) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'code128-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const destino = path.join(pasta, 'code128.mjs')
  fs.copyFileSync(path.join(__dirname, '..', 'painel', 'src', 'code128.js'), destino)
  return import(pathToFileURL(destino).href)
}

test('tabela de padrões: 107 símbolos distintos, 11 módulos (parada 13), barras somam par', async (t) => {
  const { PADROES } = await carregar(t)
  assert.equal(PADROES.length, 107)
  assert.equal(new Set(PADROES).size, 107)
  PADROES.forEach((p, i) => {
    const w = [...p].map(Number)
    assert.equal(w.reduce((a, b) => a + b), i === 106 ? 13 : 11, `símbolo ${i}`)
    const barras = w.filter((_, j) => j % 2 === 0).reduce((a, b) => a + b)
    assert.equal(barras % 2, 0, `símbolo ${i}: soma das barras deve ser par`)
  })
})

test('conjunto C: início 105, pares, verificador módulo 103 e parada', async (t) => {
  const { simbolosC, barrasC } = await carregar(t)
  // 105 + 12*1 + 34*2 = 185 → 185 % 103 = 82
  assert.deepEqual(simbolosC('1234'), [105, 12, 34, 82, 106])
  assert.equal(simbolosC('123'), null)
  assert.equal(simbolosC('12a4'), null)

  const chave = '42260705125498000132550010000316551000877213'
  const { barras, largura } = barrasC(chave)
  // início + 22 pares + verificador = 24 símbolos de 11 módulos, parada 13, margens 10+10
  assert.equal(largura, 24 * 11 + 13 + 20)
  assert.equal(barras.length, 24 * 3 + 4)
})
