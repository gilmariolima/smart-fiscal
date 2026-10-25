'use strict'

// Certificados de teste: mesmo gerador do modo demonstração, com chave menor para ser rápido.
const { gerarPfx: gerar } = require('../../src/sefaz/mock-certificado')

const gerarPfx = (opcoes = {}) => gerar({ bits: 1024, ...opcoes })

module.exports = { gerarPfx }
