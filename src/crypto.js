'use strict'

const crypto = require('node:crypto')

const ALGORITMO = 'aes-256-gcm'

function chaveBuffer(chaveHex) {
  const chave = Buffer.from(String(chaveHex || ''), 'hex')
  if (chave.length !== 32) throw new Error('Chave de criptografia inválida (esperado 32 bytes em hex)')
  return chave
}

/** Criptografa um texto. Saída: "iv:tag:dados", cada parte em base64. */
function criptografar(texto, chaveHex) {
  const iv = crypto.randomBytes(12)
  const cifra = crypto.createCipheriv(ALGORITMO, chaveBuffer(chaveHex), iv)
  const dados = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()])
  const tag = cifra.getAuthTag()
  return [iv, tag, dados].map((b) => b.toString('base64')).join(':')
}

/** Desfaz criptografar(). Lança erro se a chave estiver errada ou o dado adulterado. */
function descriptografar(enc, chaveHex) {
  const partes = String(enc || '').split(':')
  if (partes.length !== 3) throw new Error('Texto criptografado em formato inválido')
  const [iv, tag, dados] = partes.map((p) => Buffer.from(p, 'base64'))
  const decifra = crypto.createDecipheriv(ALGORITMO, chaveBuffer(chaveHex), iv)
  decifra.setAuthTag(tag)
  try {
    return Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8')
  } catch {
    throw new Error('Falha ao descriptografar: chave errada ou dado adulterado')
  }
}

module.exports = { criptografar, descriptografar }
