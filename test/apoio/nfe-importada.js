'use strict'

// nfeProc e procEventoNFe para os testes do Importar (mesmo formato do mock da SEFAZ).

const { gerarChave } = require('../../src/sefaz/mock-client')

const NS = 'http://www.portalfiscal.inf.br/nfe'

const chaveNfe = (cnpjEmit, n = 1) => gerarChave({ data: new Date(Date.UTC(2026, 9, 8)), cnpjEmit, nNF: n, cNF: 12345678 })

function nfeProc({ chave, emit, dest, nNF = '1', dhEmi = '2026-10-08T10:00:00-03:00', tpAmb = '1', cStat = '100', mod = '55', vNF = '100.00', semProtocolo = false } = {}) {
  chave = chave || chaveNfe(emit, nNF)
  const prot = semProtocolo
    ? ''
    : `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><chNFe>${chave}</chNFe><dhRecbto>${dhEmi}</dhRecbto><nProt>123260000000001</nProt><cStat>${cStat}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="4.00"><NFe xmlns="${NS}"><infNFe Id="NFe${chave}" versao="4.00">` +
    `<ide><cUF>23</cUF><cNF>12345678</cNF><natOp>VENDA</natOp><mod>${mod}</mod><serie>1</serie><nNF>${nNF}</nNF><dhEmi>${dhEmi}</dhEmi><tpNF>1</tpNF><tpAmb>${tpAmb}</tpAmb></ide>` +
    `<emit><CNPJ>${emit}</CNPJ><xNome>EMITENTE ${emit}</xNome><IE>060000001</IE></emit>` +
    `<dest><CNPJ>${dest}</CNPJ><xNome>DESTINATARIO ${dest}</xNome></dest>` +
    `<total><ICMSTot><vNF>${vNF}</vNF></ICMSTot></total></infNFe></NFe>${prot}</nfeProc>`
}

function procEventoNfe({ chave, emit, tpEvento = '110111', nSeq = '1', dhEvento = '2026-10-09T09:00:00-03:00' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="${NS}" versao="1.00"><evento versao="1.00"><infEvento Id="ID${tpEvento}${chave}0${nSeq}">` +
    `<cOrgao>23</cOrgao><tpAmb>1</tpAmb><CNPJ>${emit}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dhEvento}</dhEvento>` +
    `<tpEvento>${tpEvento}</tpEvento><nSeqEvento>${nSeq}</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>123260000000001</nProt><xJust>Nota emitida com erro de digitacao</xJust></detEvento></infEvento></evento>` +
    `<retEvento versao="1.00"><infEvento><tpAmb>1</tpAmb><cOrgao>23</cOrgao><cStat>135</cStat><xMotivo>Evento registrado</xMotivo>` +
    `<chNFe>${chave}</chNFe><tpEvento>${tpEvento}</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>${nSeq}</nSeqEvento><dhRegEvento>${dhEvento}</dhRegEvento><nProt>123260000000009</nProt></infEvento></retEvento></procEventoNFe>`
}

module.exports = { chaveNfe, nfeProc, procEventoNfe }
