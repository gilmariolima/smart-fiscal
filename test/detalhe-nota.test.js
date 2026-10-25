'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { detalharNfe } = require('../src/services/detalheNota')

const CHAVE = '42260705125498000132550010000316551000877213'
const NS = 'http://www.portalfiscal.inf.br/nfe'

function nfeProc({ det, transp = '', cobr = '', pag = '', infAdic = '', total = '', dest } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="4.00"><NFe xmlns="${NS}"><infNFe Id="NFe${CHAVE}" versao="4.00">
<ide><cUF>42</cUF><natOp>Venda de producao</natOp><mod>55</mod><serie>1</serie><nNF>31655</nNF><dhEmi>2026-07-29T08:29:19-03:00</dhEmi><dhSaiEnt>2026-07-29T09:00:00-03:00</dhSaiEnt><tpNF>1</tpNF><finNFe>1</finNFe><tpAmb>1</tpAmb></ide>
<emit><CNPJ>05125498000132</CNPJ><xNome>CERAMICA EXEMPLO LTDA</xNome><xFant>Exemplo</xFant><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><xMun>Morro da Fumaca</xMun><UF>SC</UF><CEP>88830000</CEP><fone>4834340000</fone></enderEmit><IE>250000000</IE></emit>
${dest ?? `<dest><CNPJ>10966475000190</CNPJ><xNome>LUNA MATERIAIS LTDA</xNome><enderDest><xLgr>Av B</xLgr><nro>S/N</nro><xBairro>Bairro</xBairro><xMun>Fortaleza</xMun><UF>CE</UF><CEP>60000000</CEP></enderDest><indIEDest>1</indIEDest><IE>060000000</IE></dest>`}
${det}
<total><ICMSTot><vBC>2390.00</vBC><vICMS>286.80</vICMS><vBCST>0.00</vBCST><vST>0.00</vST><vProd>2390.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vIPI>0.00</vIPI><vPIS>15.54</vPIS><vCOFINS>71.70</vCOFINS><vOutro>0.00</vOutro><vNF>2390.00</vNF><vTotTrib>500.10</vTotTrib></ICMSTot>${total}</total>
${transp}${cobr}${pag}${infAdic}
</infNFe></NFe><protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${CHAVE}</chNFe><dhRecbto>2026-07-29T08:29:30-03:00</dhRecbto><nProt>342260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`
}

const item = (n, { icms = '<ICMS00><orig>0</orig><CST>00</CST><vBC>100.00</vBC><pICMS>12.00</pICMS><vICMS>12.00</vICMS></ICMS00>', ipi = '' } = {}) =>
  `<det nItem="${n}"><prod><cProd>P${n}</cProd><cEAN>SEM GTIN</cEAN><xProd>TELHA ${n}</xProd><NCM>69052000</NCM><CFOP>6101</CFOP><uCom>MIL</uCom><qCom>2.5000</qCom><vUnCom>40.0000000000</vUnCom><vProd>100.00</vProd><vDesc>1.50</vDesc></prod><imposto><ICMS>${icms}</ICMS>${ipi}</imposto></det>`

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
