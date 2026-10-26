'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DistribuicaoDFe, RecepcaoEvento } = require('node-mde')
const { dadosUf } = require('./uf')
const { descriptografar } = require('../crypto')

/**
 * Tipo do documento pelo prefixo do schema do docZip.
 * 'resNFe' | 'procNFe' | 'resEvento' | 'procEventoNFe' | 'desconhecido'
 */
function tipoDocumento(schema) {
  const s = String(schema || '')
  for (const tipo of ['resNFe', 'procNFe', 'resEvento', 'procEventoNFe']) {
    if (s.startsWith(tipo + '_')) return tipo
  }
  return 'desconhecido'
}

// Página HTML no lugar do SOAP (ex.: 403 do IIS quando a SEFAZ recusa o certificado):
// guarda só o título, com uma explicação, em vez do HTML inteiro.
function resumirErro(texto) {
  const t = String(texto)
  if (!/<html[\s>]|<!doctype html/i.test(t)) return t.slice(0, 1000)
  const titulo = (/<title>([^<]*)<\/title>/i.exec(t)?.[1] || '').replace(/\s+/g, ' ').trim()
  const antes = t.slice(0, t.search(/<!doctype|<html/i)).trim()
  if (/\b403\b/.test(titulo)) {
    return `A SEFAZ recusou o certificado (HTTP 403: ${titulo}). Use o certificado A1 ICP-Brasil válido do próprio cliente; certificado de teste ou de outra autoridade não é aceito.`
  }
  return `${antes ? `${antes} ` : ''}Resposta inesperada da SEFAZ (página HTML${titulo ? `: ${titulo}` : ''}).`.slice(0, 1000)
}

// O node-mde lança exceção em validação e no parse; aqui tudo vira { error }.
async function semExcecao(fn) {
  try {
    const r = await fn()
    if (!r) return { error: 'Resposta vazia da SEFAZ', data: {} }
    const saida = { status: r.status, data: r.data || {} }
    if (r.error) saida.error = resumirErro(typeof r.error === 'string' ? r.error : JSON.stringify(r.error))
    return saida
  } catch (e) {
    return { error: resumirErro(e.message || String(e)), data: {} }
  }
}

/**
 * Cliente real da SEFAZ para um CNPJ.
 * Todos os métodos devolvem { error?, status, data } no formato do node-mde e nunca lançam exceção.
 * `opcoesHttp` (opcional) vai para o node-mde como options.requestOptions; usado nos testes.
 */
function criarClienteSefaz({ cnpj, uf, pfx, passphrase, tpAmb, opcoesHttp }) {
  const { codigo, fuso } = dadosUf(uf)
  const options = opcoesHttp ? { requestOptions: opcoesHttp } : undefined
  let dist = null
  let rec = null

  // Construção preguiçosa: abrir o .pfx custa caro e pode falhar (senha errada).
  function distribuicao() {
    if (!dist) dist = new DistribuicaoDFe({ pfx, passphrase, cnpj, cUFAutor: codigo, tpAmb: String(tpAmb), options })
    return dist
  }
  function recepcao() {
    if (!rec) rec = new RecepcaoEvento({ pfx, passphrase, cnpj, tpAmb: String(tpAmb), timezone: fuso, options })
    return rec
  }

  return {
    cnpj,
    consultaUltNSU: (ultNSU) => semExcecao(() => distribuicao().consultaUltNSU(ultNSU)),
    consultaNSU: (nsu) => semExcecao(() => distribuicao().consultaNSU(nsu)),
    consultaChNFe: (chave) => semExcecao(() => distribuicao().consultaChNFe(chave)),
    /** lote: [{ chNFe, tipoEvento, justificativa? }] (máx. 20) */
    enviarEvento: ({ idLote, lote }) => semExcecao(() => recepcao().enviarEvento({ idLote: String(idLote), lote })),
  }
}

let mockCompartilhado = null

/**
 * Fábrica usada pelos serviços: recebe a linha da tabela `clientes` e devolve o cliente da SEFAZ.
 * Com SEFAZ_MOCK=1, todos os CNPJs usam a mesma SEFAZ simulada (estado em memória do processo).
 */
function criarFabricaSefaz(config) {
  if (config.sefazMock) {
    if (!mockCompartilhado) mockCompartilhado = require('./mock-client').criarSefazMock({ cienciaDoDono: true })
    return (cliente) => mockCompartilhado.cliente(cliente.cnpj)
  }
  return (cliente) => {
    try {
      const pfx = fs.readFileSync(path.join(config.pastaCerts, cliente.cert_arquivo))
      return criarClienteSefaz({
        cnpj: cliente.cnpj,
        uf: cliente.uf,
        pfx,
        passphrase: descriptografar(cliente.cert_senha_enc, config.masterKey),
        tpAmb: config.tpAmb,
      })
    } catch (e) {
      return clienteComErro(cliente.cnpj, `Certificado indisponível: ${e.message}`)
    }
  }
}

// Cliente que só devolve erro: certificado ausente, senha que não abre, UF inválida.
function clienteComErro(cnpj, mensagem) {
  const falha = async () => ({ error: mensagem, data: {} })
  return { cnpj, consultaUltNSU: falha, consultaNSU: falha, consultaChNFe: falha, enviarEvento: falha }
}

module.exports = { criarClienteSefaz, criarFabricaSefaz, tipoDocumento }
