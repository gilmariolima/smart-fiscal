'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { xmlParaJson } = require('../src/sefaz/xml')
const { dadosResNFe, dadosNfeProc, dadosEvento, competenciaDe, serieNumeroDaChave, texto } = require('../src/services/extracao')
const { criarArmazenamento, pastaDoCliente, nomes, slug } = require('../src/services/armazenamento')

const CHAVE = '23261012345678000195550010000010011000070071'

test('resNFe: campos completos', () => {
  const xml = `<resNFe versao="1.01"><chNFe>${CHAVE}</chNFe><CNPJ>12345678000195</CNPJ><xNome>Alfa</xNome><IE>06</IE><dhEmi>2026-10-08T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1500.00</vNF><cSitNFe>1</cSitNFe></resNFe>`
  assert.deepEqual(dadosResNFe(xmlParaJson(xml)), {
    chave: CHAVE, emitente_cnpj: '12345678000195', emitente_nome: 'Alfa', emitente_ie: '06', numero: '1001', serie: '1',
    data_emissao: '2026-10-08T10:00:00-03:00', valor_total: 1500, tipo_nf: '1', situacao_sefaz: '1', competencia: '2026-10',
  })
})

test('resNFe: emitente pessoa física (CPF)', () => {
  const xml = `<resNFe><chNFe>${CHAVE}</chNFe><CPF>12345678901</CPF></resNFe>`
  assert.equal(dadosResNFe(xmlParaJson(xml)).emitente_cnpj, '12345678901')
})

test('extração defensiva: campos ausentes viram null, nunca exceção', () => {
  for (const entrada of [{}, null, undefined, 'lixo', { resNFe: null }, { resNFe: { vNF: 'abc' } }]) {
    const d = dadosResNFe(entrada)
    assert.equal(d.chave, null)
    assert.equal(d.valor_total, null)
    assert.equal(d.competencia, null)
  }
  for (const entrada of [{}, null, { nfeProc: { NFe: 'x' } }]) assert.equal(dadosNfeProc(entrada).chave, null)
  for (const entrada of [{}, null, { procEventoNFe: {} }]) assert.equal(dadosEvento(entrada).chave, null)
})

test('nfeProc: lê a chave do protocolo ou do Id e aceita dEmi (layout antigo)', () => {
  const xml = `<nfeProc versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00"><ide><serie>2</serie><nNF>77</nNF><dEmi>2025-12-31</dEmi><tpNF>1</tpNF></ide>` +
    `<emit><CNPJ>12345678000195</CNPJ><xNome>Alfa &amp; Cia</xNome></emit><total><ICMSTot><vNF>10.5</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`
  const d = dadosNfeProc(xmlParaJson(xml))
  assert.equal(d.chave, CHAVE)
  assert.equal(d.numero, '77')
  assert.equal(d.serie, '2')
  assert.equal(d.competencia, '2025-12')
  assert.equal(d.emitente_nome, 'Alfa & Cia')
  assert.equal(d.valor_total, 10.5)
  assert.equal(d.emitente_ie, null)
})

test('nfeProc traz o destinatário (CNPJ, CPF ou ausente)', () => {
  const nfe = (dest) => `<nfeProc versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00">${dest}</infNFe></NFe></nfeProc>`
  const cnpj = dadosNfeProc(xmlParaJson(nfe('<dest><CNPJ>11222333000181</CNPJ><xNome>CLIENTE SIMULADO</xNome></dest>')))
  assert.equal(cnpj.destinatario_cnpj, '11222333000181')
  assert.equal(cnpj.destinatario_nome, 'CLIENTE SIMULADO')
  const cpf = dadosNfeProc(xmlParaJson(nfe('<dest><CPF>12345678909</CPF></dest>')))
  assert.equal(cpf.destinatario_cnpj, '12345678909')
  assert.equal(cpf.destinatario_nome, null)
  const ausente = dadosNfeProc(xmlParaJson(nfe('')))
  assert.equal(ausente.destinatario_cnpj, null)
  assert.equal(ausente.destinatario_nome, null)
})

test('eventos: procEventoNFe e resEvento', () => {
  const proc = `<procEventoNFe><evento><infEvento Id="x"><chNFe>${CHAVE}</chNFe><dhEvento>2026-10-09T08:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento></infEvento></evento><retEvento><infEvento><nProt>123</nProt></infEvento></retEvento></procEventoNFe>`
  assert.deepEqual(dadosEvento(xmlParaJson(proc)), {
    chave: CHAVE, tp_evento: '110111', n_seq: '1', descricao: 'Cancelamento', data_evento: '2026-10-09T08:00:00-03:00', protocolo: '123', completo: true,
  })
  const res = `<resEvento><chNFe>${CHAVE}</chNFe><tpEvento>110110</tpEvento><xEvento>Carta de Correcao</xEvento><nProt>9</nProt></resEvento>`
  const e = dadosEvento(xmlParaJson(res))
  assert.equal(e.tp_evento, '110110')
  assert.equal(e.n_seq, '1', 'nSeqEvento ausente vira 1')
  assert.equal(e.completo, false)
})

test('auxiliares', () => {
  assert.equal(competenciaDe('2026-01-31T23:59:59-03:00'), '2026-01')
  assert.equal(competenciaDe('31/01/2026'), null)
  assert.deepEqual(serieNumeroDaChave(CHAVE), { serie: '1', numero: '1001' })
  assert.deepEqual(serieNumeroDaChave('123'), { serie: null, numero: null })
  assert.equal(texto({ value: ' x ', '@_a': '1' }), 'x')
  assert.equal(texto(''), null)
})

test('nomes de pasta e arquivo', () => {
  assert.equal(slug('Padaria São João & Filhos'), 'Padaria_Sao_Joao_Filhos')
  assert.equal(pastaDoCliente({ cnpj: '11222333000181', apelido: '', razao_social: 'Açaí Ltda' }), '11222333000181_Acai_Ltda')
  assert.equal(pastaDoCliente({ cnpj: '11222333000181', apelido: '***' }), '11222333000181')
  assert.equal(nomes.evento('../../x', '../1', null), 'sem-chave-evento-1-1.xml')
  assert.equal(nomes.evento(CHAVE, '110111', '2'), `${CHAVE}-evento-110111-2.xml`)
})

test('armazenamento grava com declaração XML, é idempotente e devolve caminho relativo', (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-arm-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const arm = criarArmazenamento({ pastaXmls: pasta })
  const cliente = { cnpj: '11222333000181', apelido: 'Teste' }
  const rel = arm.salvar({ cliente, competencia: '2026-10', nomeArquivo: 'a.xml', xml: '<a/>' })
  assert.equal(rel, path.join('11222333000181_Teste', '2026-10', 'a.xml'))
  assert.equal(fs.readFileSync(arm.absoluto(rel), 'utf8'), '<?xml version="1.0" encoding="UTF-8"?><a/>')

  const mtime = fs.statSync(arm.absoluto(rel)).mtimeMs
  arm.salvar({ cliente, competencia: '2026-10', nomeArquivo: 'a.xml', xml: '<a/>' })
  assert.equal(fs.statSync(arm.absoluto(rel)).mtimeMs, mtime, 'mesmo conteúdo não reescreve')

  arm.salvar({ cliente, competencia: null, nomeArquivo: 'b.xml', xml: '<?xml version="1.0"?><b/>' })
  assert.equal(fs.readFileSync(path.join(pasta, '11222333000181_Teste', 'sem-data', 'b.xml'), 'utf8'), '<?xml version="1.0"?><b/>')
  assert.deepEqual(fs.readdirSync(path.join(pasta, '11222333000181_Teste', '2026-10')), ['a.xml'], 'sem temporários sobrando')
})
