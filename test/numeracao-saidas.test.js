'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classificar, acharUltimo, acharPeriodo, ErroDeConsulta, FOLGA_FURO } = require('../src/services/numeracaoSaidas')

// SEFAZ falsa: cada número existente tem um AAMM ou 'antiga' (526); os demais dão 217.
function sefaz(faixas, { sem = [] } = {}) {
  const numeros = new Map()
  for (const [de, ate, mes] of faixas) for (let n = de; n <= ate; n++) numeros.set(n, mes)
  for (const n of sem) numeros.delete(n)
  const chamadas = []
  const consultar = async (n) => {
    chamadas.push(n)
    const mes = numeros.get(n)
    if (!mes) return { tipo: 'nao-existe' }
    if (mes === 'antiga') return { tipo: 'antiga' }
    return { tipo: 'existe', aamm: mes }
  }
  return { consultar, chamadas }
}

test('classificar: 613, 526, 217, 656 e erro de rede', () => {
  const chave = '23260611222333000181550010000001011999999990'
  assert.deepEqual(classificar({ cStat: '613', chaveVerdadeira: chave }), { tipo: 'existe', aamm: '2606', chave })
  assert.equal(classificar({ cStat: '526' }).tipo, 'antiga')
  assert.equal(classificar({ cStat: '217' }).tipo, 'nao-existe')
  assert.equal(classificar({ cStat: '656', xMotivo: 'Consumo Indevido' }).tipo, 'parar')
  const erro = classificar({ erro: 'ECONNRESET' })
  assert.equal(erro.tipo, 'erro')
  assert.match(erro.mensagem, /ECONNRESET/)
  assert.equal(FOLGA_FURO, 5)
})

test('acharUltimo sem partida acha o fim', async () => {
  const { consultar } = sefaz([[1, 1351, '2606']])
  assert.equal(await acharUltimo(consultar), 1351)
})

test('acharUltimo atravessa furo perto do fim', async () => {
  const s = sefaz([[1, 1351, '2606']], { sem: [1349, 1350] })
  assert.equal(await acharUltimo(s.consultar), 1351)
  assert.equal(await acharUltimo(s.consultar, { partida: 1000 }), 1351)
})

test('acharUltimo de série vazia', async () => {
  const { consultar, chamadas } = sefaz([])
  assert.equal(await acharUltimo(consultar), 0)
  assert.ok(chamadas.length <= 6, `fez ${chamadas.length} consultas`)
})

test('acharUltimo com notas antigas', async () => {
  const { consultar } = sefaz([[1, 500, 'antiga'], [501, 600, '2606']])
  assert.equal(await acharUltimo(consultar), 600)
})

const quatroMeses = [[1, 100, '2605'], [101, 220, '2606'], [221, 300, '2607'], [301, 350, '2608']]

test('acharPeriodo de 1 e de 3 meses', async () => {
  const { consultar } = sefaz(quatroMeses)
  assert.deepEqual(await acharPeriodo(consultar, { de: '2606', ate: '2606', ultimo: 350 }), { primeiro: 101, ultimo: 220, foraDaJanela: false })
  assert.deepEqual(await acharPeriodo(consultar, { de: '2606', ate: '2608', ultimo: 350 }), { primeiro: 101, ultimo: 350, foraDaJanela: false })
})

test('acharPeriodo com furo na ponta', async () => {
  const { consultar } = sefaz(quatroMeses, { sem: [101, 220] })
  assert.deepEqual(await acharPeriodo(consultar, { de: '2606', ate: '2606', ultimo: 350 }), { primeiro: 102, ultimo: 219, foraDaJanela: false })
})

test('acharPeriodo na borda do 526', async () => {
  const { consultar } = sefaz([[1, 80, 'antiga'], [81, 200, '2606']])
  assert.deepEqual(await acharPeriodo(consultar, { de: '2606', ate: '2606', ultimo: 200 }), { primeiro: 81, ultimo: 200, foraDaJanela: true })
})

test('acharPeriodo sem nota no mês', async () => {
  const { consultar } = sefaz([[1, 100, '2605'], [101, 200, '2607']])
  assert.equal(await acharPeriodo(consultar, { de: '2606', ate: '2606', ultimo: 200 }), null)
})

test('furo grande no meio da busca binária para com erro', async () => {
  // 1 a 200 existem, menos 90 a 110: o ponto do meio (100) e os 5 vizinhos de cada lado faltam.
  const { consultar } = sefaz([[1, 200, '2606']], { sem: Array.from({ length: 21 }, (_, i) => 90 + i) })
  await assert.rejects(acharPeriodo(consultar, { de: '2606', ate: '2606', ultimo: 200 }), (e) => e instanceof ErroDeConsulta && /furo grande perto do nº/.test(e.message))
})

test('656 e erro viram ErroDeConsulta (o 656 com parar)', async () => {
  const parar = async () => classificar({ cStat: '656', xMotivo: 'Consumo Indevido' })
  await assert.rejects(acharUltimo(parar), (e) => e instanceof ErroDeConsulta && e.parar === true)
  const caiu = async () => classificar({ erro: 'ECONNRESET' })
  await assert.rejects(acharUltimo(caiu), (e) => e instanceof ErroDeConsulta && e.parar === false && /ECONNRESET/.test(e.message))
})
