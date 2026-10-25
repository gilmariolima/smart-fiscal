'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { criarLogger, mascarar } = require('../src/logger')

test('senha e pfx não aparecem no arquivo de log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-log-'))
  const log = criarLogger({ pasta: dir, console: false })
  log.info('cadastro', { cnpj: '12345678000199', senha: 'segredo123', pfx: Buffer.from('conteudo'), opcoes: { passphrase: 'outra' } })
  const texto = fs.readFileSync(log.arquivo, 'utf8')
  assert.match(texto, /12345678000199/)
  assert.doesNotMatch(texto, /segredo123|outra|conteudo/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mascarar trata buffer, erro e campos aninhados', () => {
  const r = mascarar({ a: { MASTER_KEY: 'k', cert_senha_enc: 'e' }, b: Buffer.from('x'), c: new Error('falhou') })
  assert.deepEqual(r, { a: { MASTER_KEY: '***', cert_senha_enc: '***' }, b: '[buffer]', c: { mensagem: 'falhou' } })
})
