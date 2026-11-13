'use strict'

// Agente HTTPS com o certificado A1 do cliente (TLS de cliente).
// O .pfx é aberto pelo node-forge e passado ao https em PEM (o OpenSSL 3 recusa o RC2 de certificados antigos).

const https = require('node:https')
const forge = require('node-forge')

/** @param {{ ca?: string[] }} [opcoes] `ca` para verificar servidores da cadeia ICP-Brasil. */
function agenteDoCertificado(pfx, passphrase, { ca } = {}) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(pfx).toString('binary')), true, passphrase)
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].map((b) => b.key).filter(Boolean)
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean)
  if (!chaves.length || !certs.length) throw new Error('o arquivo não tem a chave e o certificado')
  const cert = certs.find((c) => c.publicKey?.n && c.publicKey.n.equals(chaves[0].n)) || certs[0]
  return new https.Agent({ key: forge.pki.privateKeyToPem(chaves[0]), cert: forge.pki.certificateToPem(cert), ...(ca ? { ca } : {}), keepAlive: false })
}

module.exports = { agenteDoCertificado }
