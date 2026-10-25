'use strict'

// Gera um .pfx autoassinado no formato do e-CNPJ (CN "RAZAO:CNPJ" + otherName 2.16.76.1.3.3).
// Só para testes e para o modo demonstração (SEFAZ_MOCK=1): não vale na SEFAZ real.

const forge = require('node-forge')
const { OID_CNPJ } = require('../certificado')

function sanComCnpj(cnpj) {
  const { asn1 } = forge
  const otherName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_CNPJ).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, cnpj)]),
  ])
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [otherName])).getBytes()
}

/**
 * @param {object} [o]
 * @param {string} [o.cnpj] vai no CN e no SAN
 * @param {string} [o.razao]
 * @param {string} [o.senha]
 * @param {number} [o.diasValidade] negativo gera certificado vencido
 * @param {boolean} [o.comSan] incluir o otherName do CNPJ (padrão true)
 * @param {boolean} [o.comCnpjNoCn] incluir ":CNPJ" no CN (padrão true)
 * @param {number} [o.bits]
 */
function gerarPfx({ cnpj = '11222333000181', razao = 'EMPRESA TESTE LTDA', senha = 'senha-teste', diasValidade = 365, comSan = true, comCnpjNoCn = true, bits = 2048 } = {}) {
  const chaves = forge.pki.rsa.generateKeyPair(bits)
  const cert = forge.pki.createCertificate()
  cert.publicKey = chaves.publicKey
  cert.serialNumber = '01'
  const fim = new Date(Date.now() + diasValidade * 86400e3)
  cert.validity.notBefore = new Date(Math.min(Date.now(), fim.getTime()) - 365 * 86400e3)
  cert.validity.notAfter = fim
  cert.setSubject([{ name: 'commonName', value: comCnpjNoCn ? `${razao}:${cnpj}` : razao }, { name: 'countryName', value: 'BR' }])
  cert.setIssuer([{ name: 'commonName', value: 'AC SIMULADA PARA TESTES' }, { name: 'countryName', value: 'BR' }])
  if (comSan) cert.setExtensions([{ id: '2.5.29.17', value: sanComCnpj(cnpj) }])
  cert.sign(chaves.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(chaves.privateKey, [cert], senha, { algorithm: '3des' })
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), senha }
}

module.exports = { gerarPfx }
