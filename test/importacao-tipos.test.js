'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lerDocumento, donos, nomeArquivo, CANCELAMENTOS } = require('../src/services/importacaoTipos')
const { chaveNfe, nfeProc, procEventoNfe } = require('./apoio/nfe-importada')
const { cteProc, procEventoCte, chaveCte, TRANSP, REM, DEST } = require('./apoio/cte')
const { xmlNfse, xmlEventoNfse, chaveNfse, PRESTADOR_MOCK } = require('../src/sefaz/adn-mock')

const A = '11222333000181'
const B = '99888777000100'
const lerTexto = (t) => lerDocumento(Buffer.from(t))
const cli = (cnpj, id) => ({ id, cnpj })

test('NF-e autorizada é lida como nota', () => {
  const r = lerTexto(nfeProc({ emit: A, dest: B, nNF: '7' }))
  assert.equal(r.tipo, 'nota')
  assert.equal(r.modelo, 'nfe')
  assert.equal(r.d.chave, chaveNfe(A, '7'))
  assert.equal(r.d.competencia, '2026-10')
  assert.equal(r.d.emitente_cnpj, A)
  assert.equal(r.d.destinatario_cnpj, B)
  assert.equal(r.d.valor_total, 100)
})

test('CT-e e NFS-e são lidos como nota', () => {
  const c = lerTexto(cteProc({}))
  assert.deepEqual([c.tipo, c.modelo, c.d.chave], ['nota', 'cte', chaveCte(TRANSP, '77')])
  assert.equal(c.d.emitente_cnpj, TRANSP)
  const chave = chaveNfse(PRESTADOR_MOCK, 1)
  const n = lerTexto(xmlNfse({ chave, prestador: PRESTADOR_MOCK, tomador: A }))
  assert.deepEqual([n.tipo, n.modelo, n.d.chave, n.d.competencia], ['nota', 'nfse', chave, '2026-10'])
})

test('eventos dos três tipos', () => {
  const chave = chaveNfe(A, 1)
  const e1 = lerTexto(procEventoNfe({ chave, emit: A }))
  assert.deepEqual([e1.tipo, e1.modelo, e1.e.chave, e1.e.tp_evento, e1.e.n_seq], ['evento', 'nfe', chave, '110111', '1'])
  const cte = chaveCte(TRANSP, 3)
  const e2 = lerTexto(procEventoCte({ chave: cte }))
  assert.deepEqual([e2.tipo, e2.modelo, e2.e.chave, e2.e.tp_evento], ['evento', 'cte', cte, '110111'])
  const nfse = chaveNfse(PRESTADOR_MOCK, 1)
  const e3 = lerTexto(xmlEventoNfse({ chave: nfse }))
  assert.deepEqual([e3.tipo, e3.modelo, e3.e.chave, e3.e.tp_evento], ['evento', 'nfse', nfse, '101101'])
})

test('tipos fora do app são não suportados', () => {
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, mod: '65' })).motivo, 'nao-suportado')
  assert.equal(lerTexto(cteProc({}).replace('<mod>57</mod>', '<mod>67</mod>')).motivo, 'nao-suportado')
  const soNfe = nfeProc({ emit: A, dest: B }).replace(/^.*?<NFe /, '<NFe ').replace(/<protNFe[\s\S]*$/, '')
  assert.equal(lerTexto(soNfe).motivo, 'nao-suportado')
  assert.equal(lerTexto('<resNFe xmlns="http://www.portalfiscal.inf.br/nfe"><chNFe>1</chNFe></resNFe>').motivo, 'nao-suportado')
  assert.equal(lerTexto('<qualquer/>').motivo, 'nao-suportado')
})

test('nota sem autorização', () => {
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, cStat: '110' })).motivo, 'sem-protocolo')
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, semProtocolo: true })).motivo, 'sem-protocolo')
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, cStat: '150' })).tipo, 'nota')
  assert.equal(lerTexto(cteProc({ cancelado: true })).motivo, 'sem-protocolo')
})

test('homologação', () => {
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, tpAmb: '2' })).motivo, 'homologacao')
  assert.equal(lerTexto(cteProc({ tpAmb: '2' })).motivo, 'homologacao')
})

test('chave inválida e XML ilegível', () => {
  const chave = chaveNfe(A, 1)
  assert.equal(lerTexto(nfeProc({ emit: A, dest: B, chave: chave.slice(1) })).motivo, 'invalido')
  assert.equal(lerTexto('isto não é xml <').motivo, 'invalido')
})

test('BOM, declaração e prefixo de namespace', () => {
  const xml = nfeProc({ emit: A, dest: B }).replace(/<(\/?)nfeProc/g, '<$1nfe:nfeProc').replace('xmlns="http://www.portalfiscal.inf.br/nfe" versao', 'xmlns:nfe="http://www.portalfiscal.inf.br/nfe" versao')
  const r = lerDocumento(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]))
  assert.equal(r.tipo, 'nota')
  assert.equal(r.modelo, 'nfe')
})

test('donos da NF-e', () => {
  const { d } = lerTexto(nfeProc({ emit: A, dest: B }))
  const a = cli(A, 1)
  const b = cli(B, 2)
  assert.deepEqual(donos('nfe', d, new Map([[A, a]])), [[a, 'saida']])
  assert.deepEqual(donos('nfe', d, new Map([[B, b]])), [[b, 'entrada']])
  assert.deepEqual(donos('nfe', d, new Map([[A, a], [B, b]])), [[a, 'saida'], [b, 'entrada']])
  assert.deepEqual(donos('nfe', d, new Map()), [])
})

test('donos do CT-e', () => {
  const { d } = lerTexto(cteProc({ rem: REM, dest: DEST, toma3: 3 }))
  const tom = cli(DEST, 1)
  const rem = cli(REM, 2)
  assert.deepEqual(donos('cte', d, new Map([[DEST, tom]])), [[tom, 'entrada']])
  assert.deepEqual(donos('cte', d, new Map([[REM, rem]])), [[rem, 'outro']])
  assert.deepEqual(donos('cte', d, new Map([[DEST, tom], [REM, rem]])), [[tom, 'entrada'], [rem, 'outro']])
})

test('donos da NFS-e, com o intermediário em último caso', () => {
  const chave = chaveNfse(PRESTADOR_MOCK, 1)
  const { d } = lerTexto(xmlNfse({ chave, prestador: PRESTADOR_MOCK, tomador: A }))
  const a = cli(A, 1)
  const p = cli(PRESTADOR_MOCK, 2)
  assert.deepEqual(donos('nfse', d, new Map([[A, a], [PRESTADOR_MOCK, p]])), [[p, 'saida'], [a, 'entrada']])
  const comInterm = lerTexto(xmlNfse({ chave, prestador: PRESTADOR_MOCK, tomador: B }).replace('</toma>', `</toma><interm><CNPJ>${A}</CNPJ></interm>`))
  assert.deepEqual(donos('nfse', comInterm.d, new Map([[A, a]])), [[a, 'entrada']])
})

test('nome do arquivo e cancelamentos', () => {
  const chave = chaveNfe(A, 1)
  assert.equal(nomeArquivo('nfe', chave), `${chave}-nfe.xml`)
  assert.equal(nomeArquivo('cte', chave), `${chave}-cte.xml`)
  assert.deepEqual(CANCELAMENTOS, { nfe: ['110111'], cte: ['110111'], nfse: ['101101', '105102'] })
})
