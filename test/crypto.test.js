'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { criptografar, descriptografar } = require('../src/crypto')

const CHAVE = crypto.randomBytes(32).toString('hex')

test('criptografa e descriptografa de volta', () => {
  const enc = criptografar('senha-do-certificado', CHAVE)
  assert.equal(descriptografar(enc, CHAVE), 'senha-do-certificado')
  assert.equal(enc.split(':').length, 3)
  assert.ok(!enc.includes('senha-do-certificado'))
})

test('usa IV diferente a cada chamada', () => {
  assert.notEqual(criptografar('abc', CHAVE), criptografar('abc', CHAVE))
})

test('chave errada lança erro', () => {
  const enc = criptografar('abc', CHAVE)
  assert.throws(() => descriptografar(enc, crypto.randomBytes(32).toString('hex')), /descriptografar/)
})

test('dado adulterado lança erro', () => {
  const [iv, tag, dados] = criptografar('abcdef', CHAVE).split(':')
  const buf = Buffer.from(dados, 'base64')
  buf[0] ^= 1
  assert.throws(() => descriptografar([iv, tag, buf.toString('base64')].join(':'), CHAVE), /descriptografar/)
})

test('chave com tamanho errado lança erro', () => {
  assert.throws(() => criptografar('abc', 'abcd'), /Chave/)
})
