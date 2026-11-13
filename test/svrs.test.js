'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lerRespostaSvrs, criarClienteSvrs, criarFabricaSvrs } = require('../src/sefaz/svrs')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')
const { chaveNfe, nfeProc } = require('./apoio/nfe-importada')

const CHAVE = chaveNfe(CNPJ_MOCK_OK, 9)
const pagina = (miolo) => `<html><body><div class="row"><i>Consulta realizada em : 12/11/2026 14:03:21</i></div>${miolo}<div>Entrar com Janela de Manutenção As manutenções programadas...</div></body></html>`

test('lê o XML do stringJson', () => {
  const xml = nfeProc({ emit: CNPJ_MOCK_OK, dest: '66777888000199' })
  const html = `<script type="text/javascript">\n\n        var stringJson = {\n  "xml": ${JSON.stringify(xml)}\n};\n    function downloadXml() {}</script>${pagina('<input type="button" value="Download XML" />')}`
  assert.deepEqual(lerRespostaSvrs(html), { xml })
})

test('motivos da recusa', () => {
  const difere = lerRespostaSvrs(pagina('CNPJ base do certificado digital (CNPJ8) informado difere do CNPJ base dos envolvidos (CNPJ8). CNPJ8 Certificado : 12138481'))
  assert.equal(difere.motivo, 'nao-envolvido')
  assert.match(difere.mensagem, /^CNPJ base do certificado digital/)
  assert.equal(lerRespostaSvrs(pagina('IP não autorizado devido múltiplas consultas')).motivo, 'bloqueado')
  assert.deepEqual(lerRespostaSvrs(pagina('<span>NF-e inexistente na base</span>')), { motivo: 'erro', mensagem: 'NF-e inexistente na base', repetir: true })
  const vazia = lerRespostaSvrs('<html><body>Serviço indisponível</body></html>')
  assert.equal(vazia.motivo, 'erro')
  assert.equal(vazia.repetir, true)
})

test('envia o formulário da SVRS', async () => {
  let enviado = null
  const svrs = criarClienteSvrs({ requisitar: async (corpo) => ((enviado = corpo), { status: 200, html: pagina('IP não autorizado devido múltiplas consultas') }) })
  assert.equal((await svrs.baixarNfe(CHAVE)).motivo, 'bloqueado')
  assert.equal(enviado, `sistema=Nfe&OrigemSite=0&Ambiente=1&ChaveAcessoDfe=${CHAVE}`)
})

test('HTTP 5xx e erro de rede repetem', async () => {
  const fora = criarClienteSvrs({ requisitar: async () => ({ status: 503, html: 'manutenção' }) })
  assert.deepEqual({ ...(await fora.baixarNfe(CHAVE)), mensagem: undefined }, { motivo: 'erro', repetir: true, semResposta: true, mensagem: undefined })
  const caiu = criarClienteSvrs({ requisitar: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) } })
  const r = await caiu.baixarNfe(CHAVE)
  assert.deepEqual([r.motivo, r.repetir], ['erro', true])
  assert.match(r.mensagem, /socket hang up/)
})

test('SVRS simulada: entrega a nota do emitente e recusa as outras', async () => {
  const fabrica = criarFabricaSvrs({ sefazMock: true })
  const svrs = fabrica({ cnpj: CNPJ_MOCK_OK })
  const r = await svrs.baixarNfe(CHAVE)
  assert.match(r.xml, /<nfeProc/)
  assert.match(r.xml, new RegExp(`<chNFe>${CHAVE}</chNFe>`))
  assert.equal((await svrs.baixarNfe(chaveNfe('66777888000199', 3))).motivo, 'nao-envolvido')
})

test('bloqueio reconhecido com acento em código HTML ou sem acento', () => {
  assert.equal(lerRespostaSvrs(pagina('IP n&#227;o autorizado devido m&#250;ltiplas consultas')).motivo, 'bloqueado')
  assert.equal(lerRespostaSvrs(pagina('IP nao autorizado devido multiplas consultas')).motivo, 'bloqueado')
  assert.equal(lerRespostaSvrs(pagina('IP n&atilde;o autorizado devido m&uacute;ltiplas consultas')).motivo, 'bloqueado')
})

test('sem resposta da SVRS é marcado como tal', async () => {
  const fora = criarClienteSvrs({ requisitar: async () => ({ status: 503, html: '' }) })
  assert.equal((await fora.baixarNfe(CHAVE)).semResposta, true)
  const caiu = criarClienteSvrs({ requisitar: async () => { throw new Error('getaddrinfo ENOTFOUND') } })
  assert.equal((await caiu.baixarNfe(CHAVE)).semResposta, true)
  assert.equal(lerRespostaSvrs(pagina('NF-e inexistente na base')).semResposta, undefined)
})

test('mensagem sem o CSS da página', () => {
  const html = pagina('CNPJ base do certificado digital (CNPJ8) informado difere do CNPJ base dos envolvidos (CNPJ8). CNPJ8 Certificado : 10699246 <style>.rounded-button { background-color: #f5f5f5; color: #1351b4; }</style> <button class="rounded-button">Voltar</button>')
  const r = lerRespostaSvrs(html)
  assert.equal(r.motivo, 'nao-envolvido')
  assert.doesNotMatch(r.mensagem, /rounded-button|background-color/)
  assert.match(r.mensagem, /CNPJ8 Certificado : 10699246/)
})
