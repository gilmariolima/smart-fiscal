'use strict'

// Leitura de certificado A1 (.pfx/.p12) com node-forge, a mesma biblioteca que o node-mde usa.
// Não usamos tls/crypto do Node: o OpenSSL 3 recusa .pfx com criptografia legada (RC2-40),
// comum em certificados ICP-Brasil, que funcionam normalmente no node-mde.

const forge = require('node-forge')

const OID_CNPJ = '2.16.76.1.3.3' // ICP-Brasil: CNPJ da pessoa jurídica titular (otherName do SAN)

function abrirPfx(pfx, senha) {
  let asn1
  try {
    asn1 = forge.asn1.fromDer(Buffer.from(pfx).toString('binary'))
  } catch {
    throw new Error('Arquivo não é um certificado .pfx/.p12 válido.')
  }
  try {
    // strict = true, igual ao node-mde: o que passa aqui abre lá.
    return forge.pkcs12.pkcs12FromAsn1(asn1, true, senha)
  } catch (e) {
    if (/MAC|password|senha/i.test(e.message)) throw new Error('Senha do certificado incorreta.')
    throw new Error(`Não foi possível abrir o certificado: ${e.message}`)
  }
}

/** CNPJ do otherName 2.16.76.1.3.3 no subjectAltName, se existir. */
function cnpjDoSan(cert) {
  const ext = cert.getExtension('subjectAltName')
  if (!ext || typeof ext.value !== 'string') return null
  try {
    const nomes = forge.asn1.fromDer(ext.value)
    for (const gn of nomes.value || []) {
      // otherName = [0] { type-id OID, [0] EXPLICIT valor }
      if (gn.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || gn.type !== 0 || !Array.isArray(gn.value)) continue
      const [oid, valor] = gn.value
      if (!oid || forge.asn1.derToOid(oid.value) !== OID_CNPJ) continue
      const interno = Array.isArray(valor?.value) ? valor.value[0] : valor
      const digitos = String(interno?.value || '').replace(/\D/g, '')
      if (digitos.length >= 14) return digitos.slice(0, 14)
    }
  } catch {
    return null
  }
  return null
}

/** CNPJ no fim do CN ("RAZAO SOCIAL:11222333000181"), padrão do e-CNPJ. */
function cnpjDoCn(cn) {
  const m = /(\d{14})\s*$/.exec(cn || '')
  return m ? m[1] : null
}

function atributo(nome, campo) {
  const a = nome.getField(campo)
  return a ? String(a.value) : null
}

/**
 * Abre o .pfx e devolve os dados do certificado do titular.
 * Lança Error com mensagem em português se a senha estiver errada ou o arquivo for inválido.
 * @returns {{ titular: string|null, cnpj: string|null, emissor: string|null, validoDe: string, validade: string }}
 */
function lerCertificado(pfx, senha) {
  const p12 = abrirPfx(pfx, senha)
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].map((b) => b.key).filter(Boolean)
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean)
  if (!chaves.length) throw new Error('O arquivo não contém a chave privada do certificado.')
  if (!certs.length) throw new Error('O arquivo não contém nenhum certificado.')

  // Certificado do titular = o que corresponde à chave privada (os demais são da cadeia).
  const chave = chaves[0]
  const cert = certs.find((c) => c.publicKey?.n && chave.n && c.publicKey.n.equals(chave.n)) || certs[0]
  const titular = atributo(cert.subject, 'CN')
  return {
    titular,
    cnpj: cnpjDoSan(cert) || cnpjDoCn(titular),
    emissor: atributo(cert.issuer, 'CN'),
    validoDe: cert.validity.notBefore.toISOString(),
    validade: cert.validity.notAfter.toISOString(),
  }
}

/** Dias até o vencimento (negativo = vencido). */
function diasParaVencer(validadeIso, agora = new Date()) {
  return Math.floor((new Date(validadeIso).getTime() - agora.getTime()) / 86400e3)
}

module.exports = { lerCertificado, diasParaVencer, OID_CNPJ }
