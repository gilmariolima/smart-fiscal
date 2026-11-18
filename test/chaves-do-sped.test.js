'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lerChavesDoSped } = require('../src/services/chavesDoSped')
const { chaveNfe } = require('./apoio/nfe-importada')

const CLIENTE = '11222333000181'
const FORN = '66777888000199'
const saida = chaveNfe(CLIENTE, 1)
const entrada = chaveNfe(FORN, 2)
// C100: REG|IND_OPER|IND_EMIT|COD_PART|COD_MOD|COD_SIT|SER|NUM_DOC|CHV_NFE|DT_DOC|...
const c100 = (oper, emit, mod, chave) => `|C100|${oper}|${emit}|P1|${mod}|00|1|123|${chave}|10102025|10102025|100,00|`
const sped = (linhas) =>
  [`|0000|019|0|01102025|31102025|EMPRESA AÇÚCAR LTDA|${CLIENTE}||CE|060000001|2304400|||A|1|`, '|0001|0|', '|C001|0|', ...linhas, '|C990|5|', '|9999|10|'].join('\r\n') + '\r\n'

test('lê CNPJ, período e as chaves com a direção', () => {
  const r = lerChavesDoSped(Buffer.from(sped([c100(1, 0, 55, saida), c100(0, 1, 55, entrada)]), 'latin1'))
  assert.equal(r.cnpj, CLIENTE)
  assert.equal(r.periodo, '2025-10')
  assert.deepEqual(r.chaves, [{ chave: saida, direcao: 'saida' }, { chave: entrada, direcao: 'entrada' }])
})

test('ignora NFC-e, chave vazia e repetida', () => {
  const r = lerChavesDoSped(Buffer.from(sped([c100(1, 0, 65, saida.slice(0, 20) + '65' + saida.slice(22)), c100(0, 1, 55, ''), c100(1, 0, 55, saida), c100(1, 0, 55, saida)]), 'latin1'))
  assert.deepEqual(r.chaves, [{ chave: saida, direcao: 'saida' }])
})

test('arquivo sem 0000 não é SPED', () => {
  assert.throws(() => lerChavesDoSped(Buffer.from('qualquer coisa\r\n')), /não é um SPED Fiscal/)
})
