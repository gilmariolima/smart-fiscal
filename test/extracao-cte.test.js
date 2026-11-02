'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { dadosCte, papelDoCliente, dadosEventoCte } = require('../src/services/extracaoCte')
const { cteProc, procEventoCte, chaveCte, cteAquaviario, TRANSP, REM, DEST, EXPED, RECEB } = require('./apoio/cte')
const { nfeProc, item } = require('./apoio/nfe')

const NFE1 = '42261011111111000191550010000000011000000011'
const NFE2 = '42261011111111000191550010000000021000000022'

test('chaveCte: 44 dígitos, modelo 57 e dígito verificador mod 11', () => {
  const c = chaveCte(TRANSP, 5)
  assert.match(c, /^\d{44}$/)
  assert.equal(c.slice(20, 22), '57')
  let soma = 0
  let peso = 2
  for (let i = 42; i >= 0; i--) {
    soma += Number(c[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const resto = soma % 11
  assert.equal(Number(c[43]), resto < 2 ? 0 : 11 - resto)
})

test('dadosCte lê identificação, valores, carga, documentos e protocolo', () => {
  const chave = chaveCte(TRANSP, 77)
  const d = dadosCte(cteProc({ chave, nfes: [NFE1, NFE2] }))
  assert.equal(d.chave, chave)
  assert.equal(d.numero, '77')
  assert.equal(d.serie, '1')
  assert.equal(d.modelo, '57')
  assert.equal(d.dataEmissao, '2026-10-08T10:00:00-03:00')
  assert.equal(d.competencia, '2026-10')
  assert.equal(d.cfop, '6353')
  assert.equal(d.modal, '01')
  assert.equal(d.tipoCte, '0')
  assert.equal(d.tipoServico, '0')
  assert.deepEqual(d.origem, { municipio: 'Blumenau', uf: 'SC' })
  assert.deepEqual(d.destino, { municipio: 'Fortaleza', uf: 'CE' })
  assert.equal(d.emitente.documento, TRANSP)
  assert.equal(d.emitente.nome, 'TRANSPORTADORA EXEMPLO LTDA')
  assert.equal(d.emitente.endereco.municipio, 'Blumenau')
  assert.equal(d.remetente.documento, REM)
  assert.equal(d.destinatario.documento, DEST)
  assert.equal(d.expedidor, null)
  assert.equal(d.recebedor, null)
  assert.equal(d.valorPrestacao, 1234.56)
  assert.equal(d.valorReceber, 1234.56)
  assert.deepEqual(d.componentes, [{ nome: 'FRETE VALOR', valor: 1000 }, { nome: 'PEDAGIO', valor: 234.56 }])
  assert.deepEqual(d.icms, { cst: '00', base: 1234.56, aliquota: 12, valor: 148.15 })
  assert.equal(d.carga.valor, 50000)
  assert.equal(d.carga.produto, 'TELHAS')
  assert.equal(d.carga.outras, 'PALETIZADA')
  assert.deepEqual(d.carga.quantidades, [
    { unidade: '01', tipo: 'PESO BRUTO', quantidade: 1500 },
    { unidade: '03', tipo: 'VOLUMES', quantidade: 30 },
  ])
  assert.deepEqual(d.documentos, [{ tipo: 'nfe', chave: NFE1 }, { tipo: 'nfe', chave: NFE2 }])
  assert.equal(d.observacoes, 'Observacao do transporte')
  assert.equal(d.rntrc, '12345678')
  assert.deepEqual(d.protocolo, { numero: '342260000000001', data: '2026-10-08T10:00:30-03:00', cStat: '100' })
  assert.equal(d.ambiente, 'producao')
})

test('dadosCte com uma só NF-e e em homologação', () => {
  const d = dadosCte(cteProc({ nfes: [NFE1], tpAmb: '2' }))
  assert.deepEqual(d.documentos, [{ tipo: 'nfe', chave: NFE1 }])
  assert.equal(d.ambiente, 'homologacao')
})

test('dadosCte sem documentos devolve lista vazia', () => {
  assert.deepEqual(dadosCte(cteProc()).documentos, [])
})

test('tomador por toma3 (0 a 3) aponta o participante certo', () => {
  const args = { rem: REM, dest: DEST, exped: EXPED, receb: RECEB }
  assert.equal(dadosCte(cteProc({ ...args, toma3: 0 })).tomador.documento, REM)
  assert.equal(dadosCte(cteProc({ ...args, toma3: 1 })).tomador.documento, EXPED)
  assert.equal(dadosCte(cteProc({ ...args, toma3: 2 })).tomador.documento, RECEB)
  assert.equal(dadosCte(cteProc({ ...args, toma3: 3 })).tomador.documento, DEST)
})

test('tomador aceita os nomes toma03 do layout 3.00', () => {
  assert.equal(dadosCte(cteProc({ toma3: 0, tag3: 'toma03' })).tomador.documento, REM)
})

test('tomador por toma4 é a pessoa explícita, inclusive CPF', () => {
  const d = dadosCte(cteProc({ toma4: '12345678909' }))
  assert.equal(d.tomador.documento, '12345678909')
  assert.equal(d.tomador.nome, 'TOMADOR EXEMPLO')
  assert.equal(d.tomador.endereco.uf, 'SC')
})

test('papelDoCliente: emitente é saída', () => {
  assert.equal(papelDoCliente(dadosCte(cteProc()), TRANSP), 'saida')
})

test('papelDoCliente: tomador é entrada em toma3 0, 1, 2 e 3', () => {
  const args = { exped: EXPED, receb: RECEB }
  assert.equal(papelDoCliente(dadosCte(cteProc({ ...args, toma3: 0 })), REM), 'entrada')
  assert.equal(papelDoCliente(dadosCte(cteProc({ ...args, toma3: 3 })), DEST), 'entrada')
  assert.equal(papelDoCliente(dadosCte(cteProc({ ...args, toma3: 1 })), EXPED), 'entrada')
  assert.equal(papelDoCliente(dadosCte(cteProc({ ...args, toma3: 2 })), RECEB), 'entrada')
})

test('papelDoCliente: toma4 com CNPJ do cliente é entrada', () => {
  assert.equal(papelDoCliente(dadosCte(cteProc({ toma4: '66666666000191' })), '66.666.666/0001-91'), 'entrada')
})

test('papelDoCliente: remetente que não é tomador é outro', () => {
  assert.equal(papelDoCliente(dadosCte(cteProc({ toma3: 3 })), REM), 'outro')
  assert.equal(papelDoCliente(dadosCte(cteProc({ toma3: 3, exped: EXPED })), EXPED), 'outro')
})

test('papelDoCliente: emitente e tomador ao mesmo tempo é saída', () => {
  assert.equal(papelDoCliente(dadosCte(cteProc({ rem: TRANSP, toma3: 0 })), TRANSP), 'saida')
  assert.equal(papelDoCliente(dadosCte(cteProc({ toma4: TRANSP })), TRANSP), 'saida')
})

test('papelDoCliente: toma4 com CPF e sem expedidor/recebedor não lança e compara por dígitos', () => {
  const d = dadosCte(cteProc({ toma4: '12345678909', exped: null, receb: null }))
  assert.equal(papelDoCliente(d, '123.456.789-09'), 'entrada')
  assert.equal(papelDoCliente(d, '99999999000191'), null)
})

test('papelDoCliente: CNPJ ausente do CT-e é null', () => {
  assert.equal(papelDoCliente(dadosCte(cteProc()), '99999999000191'), null)
  assert.equal(papelDoCliente(dadosCte(cteProc()), ''), null)
})

test('dadosEventoCte lê um cancelamento 110111', () => {
  const chave = chaveCte(TRANSP, 77)
  const e = dadosEventoCte(procEventoCte({ chave, tpEvento: '110111', nSeq: '1' }))
  assert.equal(e.chave, chave)
  assert.equal(e.tpEvento, '110111')
  assert.equal(e.nSeq, '1')
  assert.equal(e.descricao, 'Cancelamento')
  assert.equal(e.dataEvento, '2026-10-09T09:00:00-03:00')
  assert.equal(e.protocolo, '942260000000001')
})

test('dadosCte recusa XML que não é CT-e', () => {
  assert.throws(() => dadosCte(nfeProc({ det: item(1) })), /não é um CT-e/)
  assert.throws(() => dadosCte('<a/>'), /não é um CT-e/)
})

test('dadosCte aquaviário: NF-e do contêiner, CT-e anterior, navio e observações do contribuinte', () => {
  const { xml, nfe, anterior } = cteAquaviario()
  const d = dadosCte(xml)
  assert.deepEqual(d.documentos, [{ tipo: 'nfe', chave: nfe }, { tipo: 'cte', chave: anterior }])
  assert.deepEqual(d.aquaviario, { navio: 'NAVIO EXEMPLO', viagem: '641', conteineres: ['ABCU1234567'] })
  assert.match(d.observacoes, /Observacao do transporte/)
  assert.match(d.observacoes, /Booking: 6AIBK914N/)
})

