'use strict'

// Perguntas no terminal: senha sem eco e confirmação.
// Fora de um terminal (entrada por pipe), lê uma linha do stdin.

const readline = require('node:readline')

function lerLinhaDoPipe() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin })
    let respondeu = false
    rl.once('line', (linha) => {
      respondeu = true
      rl.close()
      resolve(linha)
    })
    rl.once('close', () => {
      if (!respondeu) resolve('')
    })
  })
}

/** Pede um valor sem mostrar o que é digitado. Ctrl+C cancela. */
function perguntarOculto(mensagem) {
  const entrada = process.stdin
  if (!entrada.isTTY) {
    process.stderr.write(mensagem)
    return lerLinhaDoPipe().then((v) => {
      process.stderr.write('\n')
      return v
    })
  }
  return new Promise((resolve, reject) => {
    let valor = ''
    process.stdout.write(mensagem)
    entrada.setRawMode(true)
    entrada.setEncoding('utf8')
    entrada.resume()
    const terminar = (erro) => {
      entrada.setRawMode(false)
      entrada.pause()
      entrada.removeListener('data', aoDigitar)
      process.stdout.write('\n')
      erro ? reject(erro) : resolve(valor)
    }
    function aoDigitar(pedaco) {
      for (const c of pedaco) {
        if (c === '\r' || c === '\n') return terminar()
        if (c === '\u0003') return terminar(new Error('Cancelado.'))
        if (c === '\u007f' || c === '\b') valor = valor.slice(0, -1)
        else if (c >= ' ') valor += c
      }
    }
    entrada.on('data', aoDigitar)
  })
}

/** Pergunta e devolve o texto digitado. */
function perguntarTexto(mensagem) {
  if (!process.stdin.isTTY) {
    process.stderr.write(mensagem)
    return lerLinhaDoPipe()
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(mensagem, (r) => {
    rl.close()
    resolve(r)
  }))
}

module.exports = { perguntarOculto, perguntarTexto }
