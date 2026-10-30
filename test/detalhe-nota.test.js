'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { detalharNfe } = require('../src/services/detalheNota')
const { CHAVE, nfeProc, item } = require('./apoio/nfe')

test('nota completa: cabeçalho, emitente, destinatário, protocolo', () => {
  const d = detalharNfe(nfeProc({ det: item(1) }))
  assert.deepEqual(d.ide, {
    chave: CHAVE, numero: '31655', serie: '1', modelo: '55', naturezaOperacao: 'Venda de producao',
    dataEmissao: '2026-07-29T08:29:19-03:00', dataSaida: '2026-07-29T09:00:00-03:00', tipo: 'saida', finalidade: 'Normal', ambiente: 'producao',
  })
  assert.deepEqual(d.protocolo, { numero: '342260000000001', data: '2026-07-29T08:29:30-03:00', cStat: '100', motivo: 'Autorizado o uso da NF-e' })
  assert.deepEqual(d.emitente, {
    nome: 'CERAMICA EXEMPLO LTDA', fantasia: 'Exemplo', documento: '05125498000132', ie: '250000000',
    endereco: { logradouro: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', municipio: 'Morro da Fumaca', uf: 'SC', cep: '88830000', telefone: '4834340000' },
  })
  assert.equal(d.destinatario.documento, '10966475000190')
  assert.equal(d.destinatario.ie, '060000000')
  assert.equal(d.destinatario.endereco.municipio, 'Fortaleza')
})

test('itens: um ou vários, com ICMS normal, Simples (CSOSN) e IPI', () => {
  const um = detalharNfe(nfeProc({ det: item(1) }))
  assert.equal(um.itens.length, 1)
  assert.deepEqual(um.itens[0], {
    numero: '1', codigo: 'P1', descricao: 'TELHA 1', ncm: '69052000', cfop: '6101', cst: '000', unidade: 'MIL',
    quantidade: 2.5, valorUnitario: 40, valorTotal: 100, desconto: 1.5, baseIcms: 100, aliquotaIcms: 12, valorIcms: 12, valorIpi: null, aliquotaIpi: null,
  })

  const sn = '<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>'
  const ipi = '<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>100.00</vBC><pIPI>5.00</pIPI><vIPI>5.00</vIPI></IPITrib></IPI>'
  const varios = detalharNfe(nfeProc({ det: item(1) + item(2, { icms: sn, ipi }) + item(3) }))
  assert.deepEqual(varios.itens.map((i) => i.numero), ['1', '2', '3'])
  assert.equal(varios.itens[1].cst, '0102')
  assert.equal(varios.itens[1].valorIcms, null)
  assert.equal(varios.itens[1].valorIpi, 5)
  assert.equal(varios.itens[1].aliquotaIpi, 5)
})

test('totais', () => {
  const d = detalharNfe(nfeProc({ det: item(1) }))
  assert.deepEqual(d.totais, {
    baseIcms: 2390, icms: 286.8, baseSt: 0, st: 0, produtos: 2390, frete: 0, seguro: 0, desconto: 0, outras: 0,
    ipi: 0, pis: 15.54, cofins: 71.7, total: 2390, tributosAproximados: 500.1,
  })
})

test('transporte, cobrança, pagamento e informações adicionais', () => {
  const transp = `<transp><modFrete>0</modFrete><transporta><CNPJ>02427026000146</CNPJ><xNome>TRANSPORTES EXEMPLO</xNome><IE>123</IE><xEnder>Rua C</xEnder><xMun>Itajai</xMun><UF>SC</UF></transporta><veicTransp><placa>ABC1D23</placa><UF>SC</UF></veicTransp><vol><qVol>10</qVol><esp>PALETE</esp><pesoL>1000.000</pesoL><pesoB>1050.000</pesoB></vol><vol><qVol>2</qVol><esp>CAIXA</esp></vol></transp>`
  const cobr = `<cobr><fat><nFat>31655</nFat><vOrig>2390.00</vOrig><vDesc>0.00</vDesc><vLiq>2390.00</vLiq></fat><dup><nDup>001</nDup><dVenc>2026-08-28</dVenc><vDup>1195.00</vDup></dup><dup><nDup>002</nDup><dVenc>2026-09-27</dVenc><vDup>1195.00</vDup></dup></cobr>`
  const pag = `<pag><detPag><tPag>15</tPag><vPag>2390.00</vPag></detPag></pag>`
  const infAdic = `<infAdic><infAdFisco>Fisco diz</infAdFisco><infCpl>Pedido 123</infCpl></infAdic>`
  const d = detalharNfe(nfeProc({ det: item(1), transp, cobr, pag, infAdic }))
  assert.deepEqual(d.transporte, {
    modalidade: '0 - Por conta do emitente',
    transportadora: { nome: 'TRANSPORTES EXEMPLO', documento: '02427026000146', ie: '123', endereco: 'Rua C', municipio: 'Itajai', uf: 'SC' },
    veiculo: { placa: 'ABC1D23', uf: 'SC' },
    volumes: [
      { quantidade: 10, especie: 'PALETE', marca: null, numeracao: null, pesoLiquido: 1000, pesoBruto: 1050 },
      { quantidade: 2, especie: 'CAIXA', marca: null, numeracao: null, pesoLiquido: null, pesoBruto: null },
    ],
  })
  assert.deepEqual(d.cobranca, {
    fatura: { numero: '31655', valorOriginal: 2390, desconto: 0, valorLiquido: 2390 },
    duplicatas: [
      { numero: '001', vencimento: '2026-08-28', valor: 1195 },
      { numero: '002', vencimento: '2026-09-27', valor: 1195 },
    ],
  })
  assert.deepEqual(d.pagamentos, [{ forma: 'Boleto bancário', valor: 2390 }])
  assert.deepEqual(d.informacoes, { complementar: 'Pedido 123', fisco: 'Fisco diz' })
})

test('sem transporte, cobrança e destinatário: blocos vazios, sem exceção', () => {
  const d = detalharNfe(nfeProc({ det: item(1), dest: '' }))
  assert.equal(d.destinatario, null)
  assert.deepEqual(d.transporte, { modalidade: null, transportadora: null, veiculo: null, volumes: [] })
  assert.deepEqual(d.cobranca, { fatura: null, duplicatas: [] })
  assert.deepEqual(d.pagamentos, [])
  assert.deepEqual(d.informacoes, { complementar: null, fisco: null })
})

test('XML que não é NF-e devolve null', () => {
  assert.equal(detalharNfe('<resNFe><chNFe>1</chNFe></resNFe>'), null)
  assert.equal(detalharNfe(''), null)
  assert.equal(detalharNfe('lixo <<<'), null)
})

test('detalharNfse com o XML de Fortaleza', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { detalharNfse } = require('../src/services/detalheNota')
  const d = detalharNfse(fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8'))
  assert.deepEqual(d.prestador, { cnpj: '99888777000166', nome: 'TESTE XNOME' })
  assert.equal(d.tomador.cnpj, '11222333000181')
  assert.equal(d.valor, 150)
  assert.equal(d.numero, '17763')
  assert.equal(d.competencia, '2026-01')
  assert.equal(detalharNfse('<lixo'), null)
})
