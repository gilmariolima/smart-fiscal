'use strict'

// PDF de cada nota, gerado do XML: DANFE (NF-e), DANFSe (NFS-e) ou DACTE (CT-e).
// Usado pelo "Baixar selecionados" e pela tela Exportar.

const { gerarDanfse, situacaoDanfse } = require('./danfse/gerar')
const { gerarDanfe } = require('./danfe/gerar')
const { gerarDacte } = require('./dacte/gerar')

/** @param {(chave: string) => string[]} tiposDeEvento códigos dos eventos da nota (a situação do DANFSe depende deles) */
function pdfsDasNotas(tiposDeEvento) {
  return [
    { chave: 'danfe', rotulo: 'DANFE', doModelo: (n) => n.modelo !== 'nfse' && n.modelo !== 'cte', gerar: (xml, n) => gerarDanfe(xml, { situacao: n.cancelada ? 'cancelada' : 'autorizada' }) },
    { chave: 'danfse', rotulo: 'DANFSe', doModelo: (n) => n.modelo === 'nfse', gerar: (xml, n) => gerarDanfse(xml, { situacao: situacaoDanfse(n, tiposDeEvento(n.chave)) }) },
    { chave: 'dacte', rotulo: 'DACTE', doModelo: (n) => n.modelo === 'cte', gerar: (xml, n) => gerarDacte(xml, { situacao: n.cancelada ? 'cancelado' : 'autorizado' }) },
  ]
}

module.exports = { pdfsDasNotas }
