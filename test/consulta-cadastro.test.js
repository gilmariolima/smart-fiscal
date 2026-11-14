'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { consultarCadastro, lerRetornoCadastro } = require('../src/sefaz/consultaCadastro')

const retorno = (miolo) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/CadConsultaCadastro4"><retConsCad versao="2.00" xmlns="http://www.portalfiscal.inf.br/nfe"><infCons><verAplic>SVRS</verAplic>${miolo}</infCons></retConsCad></nfeResultMsg></soap:Body></soap:Envelope>`
const umaOcorrencia = retorno('<cStat>111</cStat><xMotivo>Consulta cadastro com uma ocorrencia</xMotivo><UF>CE</UF><CNPJ>43563363000148</CNPJ><dhCons>2026-11-14T10:00:00-03:00</dhCons><cUF>23</cUF><infCad><IE>70297169</IE><CNPJ>43563363000148</CNPJ><UF>CE</UF><cSit>1</cSit><xNome>LEITURA KENNEDY LIVRARIA E PAPELARIA LTDA</xNome></infCad>')

test('lê a IE e completa o zero da IE do Ceará (9 dígitos)', () => {
  assert.deepEqual(lerRetornoCadastro(umaOcorrencia, 'CE'), { ie: '070297169', situacao: '1', nome: 'LEITURA KENNEDY LIVRARIA E PAPELARIA LTDA' })
})

test('mais de uma IE: fica a habilitada', () => {
  const xml = retorno('<cStat>112</cStat><xMotivo>varias</xMotivo><infCad><IE>111</IE><cSit>0</cSit><xNome>A</xNome></infCad><infCad><IE>222</IE><cSit>1</cSit><xNome>A</xNome></infCad>')
  assert.equal(lerRetornoCadastro(xml, 'SC').ie, '222')
})

test('recusas da SEFAZ viram mensagem', () => {
  assert.throws(() => lerRetornoCadastro(retorno('<cStat>259</cStat><xMotivo>Rejeicao: CNPJ da consulta nao cadastrado como contribuinte na UF</xMotivo>'), 'CE'), /não tem inscrição estadual no CE/)
  assert.throws(() => lerRetornoCadastro(retorno('<cStat>999</cStat><xMotivo>Erro nao catalogado</xMotivo>'), 'CE'), /Erro nao catalogado/)
  assert.throws(() => lerRetornoCadastro('<html>fora</html>', 'CE'), /resposta inesperada/i)
})

test('envia o ConsCad para a SVRS', async () => {
  let enviado
  const r = await consultarCadastro({ cnpj: '43563363000148', uf: 'CE', requisitar: async (url, corpo) => ((enviado = { url, corpo }), { status: 200, corpo: umaOcorrencia }) })
  assert.equal(r.ie, '070297169')
  assert.match(enviado.url, /cad\.svrs\.rs\.gov\.br/)
  assert.match(enviado.corpo, /<xServ>CONS-CAD<\/xServ><UF>CE<\/UF><CNPJ>43563363000148<\/CNPJ>/)
})

test('estado fora da SVRS é recusado sem consultar', async () => {
  await assert.rejects(consultarCadastro({ cnpj: '43563363000148', uf: 'SP', requisitar: async () => assert.fail('não devia consultar') }), /SP/)
})
