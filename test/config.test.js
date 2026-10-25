'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { carregarConfig } = require('../src/config')

const CHAVE = 'a'.repeat(64)

test('aceita a configuração padrão com MASTER_KEY válida', () => {
  const c = carregarConfig({ MASTER_KEY: CHAVE })
  assert.equal(c.tpAmb, '2')
  assert.equal(c.painelHost, '127.0.0.1')
  assert.equal(c.painelPorta, 3030)
  assert.equal(c.maxConsultasChavePorCiclo, 20)
  assert.equal(c.sefazMock, false)
  assert.ok(Object.isFrozen(c))
})

test('recusa MASTER_KEY vazia', () => {
  assert.throws(() => carregarConfig({}), /MASTER_KEY/)
})

test('recusa MASTER_KEY curta ou não hex', () => {
  assert.throws(() => carregarConfig({ MASTER_KEY: 'abc' }), /MASTER_KEY/)
  assert.throws(() => carregarConfig({ MASTER_KEY: 'z'.repeat(64) }), /MASTER_KEY/)
})

test('recusa painel exposto na rede sem senha', () => {
  assert.throws(() => carregarConfig({ MASTER_KEY: CHAVE, PAINEL_HOST: '0.0.0.0' }), /PAINEL_SENHA/)
})

test('aceita painel exposto com senha', () => {
  const c = carregarConfig({ MASTER_KEY: CHAVE, PAINEL_HOST: '0.0.0.0', PAINEL_SENHA: 'x' })
  assert.equal(c.painelHost, '0.0.0.0')
})

test('recusa TP_AMB inválido e números inválidos', () => {
  assert.throws(() => carregarConfig({ MASTER_KEY: CHAVE, TP_AMB: '3' }), /TP_AMB/)
  assert.throws(() => carregarConfig({ MASTER_KEY: CHAVE, PAINEL_PORTA: 'abc' }), /PAINEL_PORTA/)
})

test('PASTA_BACKUP: vazia desliga o backup; relativa vira caminho absoluto', () => {
  assert.equal(carregarConfig({ MASTER_KEY: CHAVE }).pastaBackup, null)
  assert.equal(carregarConfig({ MASTER_KEY: CHAVE, PASTA_BACKUP: '  ' }).pastaBackup, null)
  const c = carregarConfig({ MASTER_KEY: CHAVE, PASTA_BACKUP: './bkp' })
  assert.ok(require('node:path').isAbsolute(c.pastaBackup))
  assert.match(c.pastaBackup, /bkp$/)
})

test('SMARTDOC_DADOS muda a base do .env e das pastas relativas; caminhos absolutos continuam valendo', () => {
  const path = require('node:path')
  const { RAIZ } = require('../src/config')
  const padrao = carregarConfig({ MASTER_KEY: CHAVE })
  assert.equal(padrao.raiz, RAIZ)
  assert.equal(padrao.caminhoBanco, path.join(RAIZ, 'data', 'nfe.db'))

  const dados = path.resolve('/tmp/smartdoc-dados')
  const fora = path.resolve('/tmp/outro-lugar/xmls')
  const c = carregarConfig({ MASTER_KEY: CHAVE, SMARTDOC_DADOS: dados, PASTA_XMLS: fora })
  assert.equal(c.raiz, dados)
  assert.equal(c.caminhoBanco, path.join(dados, 'data', 'nfe.db'))
  assert.equal(c.pastaCerts, path.join(dados, 'certs'))
  assert.equal(c.pastaLogs, path.join(dados, 'logs'))
  assert.equal(c.pastaXmls, fora)
})
