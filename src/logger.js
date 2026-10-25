'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Campos que nunca podem aparecer no log, em qualquer nível do objeto.
const SENSIVEIS = /senha|passphrase|password|pfx|master_?key|cert_senha_enc|secret|token/i

function mascarar(valor, profundidade = 0) {
  if (profundidade > 5 || valor === null || typeof valor !== 'object') return valor
  if (Buffer.isBuffer(valor)) return '[buffer]'
  if (valor instanceof Error) return { mensagem: valor.message }
  if (Array.isArray(valor)) return valor.map((v) => mascarar(v, profundidade + 1))
  const saida = {}
  for (const [k, v] of Object.entries(valor)) {
    saida[k] = SENSIVEIS.test(k) ? '***' : mascarar(v, profundidade + 1)
  }
  return saida
}

function formatar(nivel, mensagem, contexto) {
  let linha = `${new Date().toISOString()} [${nivel.toUpperCase()}] ${mensagem}`
  if (contexto !== undefined) {
    try {
      linha += ' ' + JSON.stringify(mascarar(contexto))
    } catch {
      linha += ' [contexto não serializável]'
    }
  }
  return linha
}

const NIVEIS = { info: 1, warn: 2, error: 3 }

/**
 * Cria um logger que escreve no console e em <pasta>/app.log (o arquivo recebe tudo).
 * `console: false` desliga a saída no terminal (útil em testes).
 * `nivelConsole`: nível mínimo mostrado no terminal ('info' | 'warn' | 'error').
 */
function criarLogger({ pasta, console: noConsole = true, nivelConsole = 'info' } = {}) {
  let arquivo = null
  if (pasta) {
    fs.mkdirSync(pasta, { recursive: true })
    arquivo = path.join(pasta, 'app.log')
  }
  const minimo = NIVEIS[nivelConsole] || 1

  function escrever(nivel, mensagem, contexto) {
    const linha = formatar(nivel, mensagem, contexto)
    if (noConsole && NIVEIS[nivel] >= minimo) (nivel === 'error' ? console.error : nivel === 'warn' ? console.warn : console.log)(linha)
    if (arquivo) {
      try {
        fs.appendFileSync(arquivo, linha + '\n', 'utf8')
      } catch (e) {
        console.error(`Falha ao gravar log: ${e.message}`)
      }
    }
  }

  return {
    arquivo,
    info: (m, c) => escrever('info', m, c),
    warn: (m, c) => escrever('warn', m, c),
    error: (m, c) => escrever('error', m, c),
  }
}

module.exports = { criarLogger, mascarar }
