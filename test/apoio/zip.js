'use strict'

// Leitor mínimo de ZIP para os testes (diretório central + deflate). Não serve para ZIP64.
const zlib = require('node:zlib')

function lerZip(buf) {
  let fim = buf.length - 22
  while (fim >= 0 && buf.readUInt32LE(fim) !== 0x06054b50) fim--
  if (fim < 0) throw new Error('ZIP inválido: fim do diretório central não encontrado')
  const total = buf.readUInt16LE(fim + 10)
  let p = buf.readUInt32LE(fim + 16)
  const arquivos = new Map()
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP inválido: entrada do diretório central')
    const metodo = buf.readUInt16LE(p + 10)
    const tamCompactado = buf.readUInt32LE(p + 20)
    const tamNome = buf.readUInt16LE(p + 28)
    const tamExtra = buf.readUInt16LE(p + 30)
    const tamComentario = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const nome = buf.toString('utf8', p + 46, p + 46 + tamNome)
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const dados = buf.subarray(inicio, inicio + tamCompactado)
    arquivos.set(nome, metodo === 8 ? zlib.inflateRawSync(dados) : Buffer.from(dados))
    p += 46 + tamNome + tamExtra + tamComentario
  }
  return arquivos
}

module.exports = { lerZip }
