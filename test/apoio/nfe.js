'use strict'

// NF-e de exemplo (nfeProc) para os testes do detalhe da nota e do DANFE: dados fictícios, montados por parâmetro.

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

module.exports = { CHAVE, NS, nfeProc, item }
