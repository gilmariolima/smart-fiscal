'use strict'

// CT-e de exemplo (cteProc e procEventoCTe) para os testes de extração e captura: dados fictícios, montados por parâmetro.

const NS = 'http://www.portalfiscal.inf.br/cte'
const TRANSP = '11111111000191'
const REM = '22222222000191'
const DEST = '33333333000191'
const EXPED = '44444444000191'
const RECEB = '55555555000191'

const pad = (v, n) => String(v).padStart(n, '0')

function dvChave(base43) {
  let soma = 0
  let peso = 2
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += Number(base43[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

/** Chave de CT-e (modelo 57, posições 21-22) de 44 dígitos com dígito verificador mod 11. */
function chaveCte(cnpjEmit, n = 1) {
  const base = `422610${cnpjEmit}57001${pad(n, 9)}1${pad(n, 8)}`
  return base + dvChave(base)
}

// Documento com 11 dígitos é CPF; com 14, CNPJ.
const idDoc = (doc) => (String(doc).length === 11 ? `<CPF>${doc}</CPF>` : `<CNPJ>${doc}</CNPJ>`)

const ender = (tag, sufixo) =>
  `<${tag}><xLgr>Rua ${sufixo}</xLgr><nro>10</nro><xBairro>Centro</xBairro><cMun>4202008</cMun><xMun>Blumenau</xMun><CEP>89000000</CEP><UF>SC</UF></${tag}>`

function pessoa(tag, doc, nome, enderTag, extra = '') {
  return `<${tag}>${idDoc(doc)}<IE>250000001</IE><xNome>${nome}</xNome>${extra}${ender(enderTag, nome)}</${tag}>`
}

function cteProc({
  chave,
  emit = TRANSP,
  rem = REM,
  dest = DEST,
  exped = null,
  receb = null,
  toma3 = null,
  toma4 = null,
  vTPrest = '1234.56',
  nCT = '77',
  serie = '1',
  dhEmi = '2026-10-08T10:00:00-03:00',
  nfes = [],
  tpAmb = '1',
  cancelado = false,
  tag3 = 'toma3',
} = {}) {
  chave = chave || chaveCte(emit, nCT)
  const toma = toma4
    ? `<toma4><toma>4</toma>${idDoc(toma4)}<IE>250000002</IE><xNome>TOMADOR EXEMPLO</xNome>${ender('enderToma', 'Tomador')}</toma4>`
    : `<${tag3}><toma>${toma3 ?? 3}</toma></${tag3}>`
  const docs = nfes.map((c) => `<infNFe><chave>${c}</chave></infNFe>`).join('')
  const cStat = cancelado ? '101' : '100'
  return `<?xml version="1.0" encoding="UTF-8"?><cteProc xmlns="${NS}" versao="4.00"><CTe xmlns="${NS}"><infCte Id="CTe${chave}" versao="4.00">
<ide><cUF>42</cUF><cCT>00000001</cCT><CFOP>6353</CFOP><natOp>Prestacao de servico de transporte</natOp><mod>57</mod><serie>${serie}</serie><nCT>${nCT}</nCT><dhEmi>${dhEmi}</dhEmi><tpImp>1</tpImp><tpEmis>1</tpEmis><tpAmb>${tpAmb}</tpAmb><tpCTe>0</tpCTe><procEmi>0</procEmi><modal>01</modal><tpServ>0</tpServ><cMunIni>4202008</cMunIni><xMunIni>Blumenau</xMunIni><UFIni>SC</UFIni><cMunFim>2304400</cMunFim><xMunFim>Fortaleza</xMunFim><UFFim>CE</UFFim>${toma}</ide>
<compl><xObs>Observacao do transporte</xObs></compl>
${pessoa('emit', emit, 'TRANSPORTADORA EXEMPLO LTDA', 'enderEmit', '<xFant>Exemplo</xFant>')}
${rem ? pessoa('rem', rem, 'REMETENTE EXEMPLO LTDA', 'enderReme') : ''}
${exped ? pessoa('exped', exped, 'EXPEDIDOR EXEMPLO LTDA', 'enderExped') : ''}
${receb ? pessoa('receb', receb, 'RECEBEDOR EXEMPLO LTDA', 'enderReceb') : ''}
${dest ? pessoa('dest', dest, 'DESTINATARIO EXEMPLO LTDA', 'enderDest') : ''}
<vPrest><vTPrest>${vTPrest}</vTPrest><vRec>${vTPrest}</vRec><Comp><xNome>FRETE VALOR</xNome><vComp>1000.00</vComp></Comp><Comp><xNome>PEDAGIO</xNome><vComp>234.56</vComp></Comp></vPrest>
<imp><ICMS><ICMS00><CST>00</CST><vBC>1234.56</vBC><pICMS>12.00</pICMS><vICMS>148.15</vICMS></ICMS00></ICMS></imp>
<infCTeNorm><infCarga><vCarga>50000.00</vCarga><proPred>TELHAS</proPred><xOutCat>PALETIZADA</xOutCat><infQ><cUnid>01</cUnid><tpMed>PESO BRUTO</tpMed><qCarga>1500.0000</qCarga></infQ><infQ><cUnid>03</cUnid><tpMed>VOLUMES</tpMed><qCarga>30.0000</qCarga></infQ></infCarga><infDoc>${docs}</infDoc><infModal versaoModal="4.00"><rodo><RNTRC>12345678</RNTRC></rodo></infModal></infCTeNorm>
</infCte></CTe><protCTe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><verAplic>SP_CTE_1.0</verAplic><chCTe>${chave}</chCTe><dhRecbto>2026-10-08T10:00:30-03:00</dhRecbto><nProt>342260000000001</nProt><digVal>bW9jaw==</digVal><cStat>${cStat}</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe></cteProc>`
}

function procEventoCte({ chave, tpEvento = '110111', nSeq = '1' } = {}) {
  const desc = tpEvento === '110111' ? 'Cancelamento' : 'Evento'
  return `<?xml version="1.0" encoding="UTF-8"?><procEventoCTe xmlns="${NS}" versao="4.00"><eventoCTe versao="4.00"><infEvento Id="ID${tpEvento}${chave}${pad(nSeq, 2)}"><cOrgao>42</cOrgao><tpAmb>1</tpAmb><CNPJ>${TRANSP}</CNPJ><chCTe>${chave}</chCTe><dhEvento>2026-10-09T09:00:00-03:00</dhEvento><tpEvento>${tpEvento}</tpEvento><nSeqEvento>${nSeq}</nSeqEvento><detEvento versaoEvento="4.00"><evCancCTe><descEvento>${desc}</descEvento><nProt>342260000000001</nProt><xJust>Justificativa de teste do evento</xJust></evCancCTe></detEvento></infEvento></eventoCTe><retEventoCTe versao="4.00"><infEvento><tpAmb>1</tpAmb><cStat>135</cStat><xMotivo>Evento registrado e vinculado a CT-e</xMotivo><chCTe>${chave}</chCTe><tpEvento>${tpEvento}</tpEvento><nSeqEvento>${nSeq}</nSeqEvento><dhRegEvento>2026-10-09T09:00:05-03:00</dhRegEvento><nProt>942260000000001</nProt></infEvento></retEventoCTe></procEventoCTe>`
}

// CT-e aquaviário: a NF-e vem dentro do contêiner e há CT-e anterior (multimodal).
function cteAquaviario() {
  const nfe = chaveCte(REM, 7).replace(/^(\d{20})57/, '$155')
  const anterior = chaveCte(TRANSP, 8)
  const xml = cteProc({ chave: chaveCte(TRANSP, 9), nfes: [] })
    .replace('<modal>01</modal>', '<modal>03</modal>')
    .replace(/<infModal versaoModal="4.00">[\s\S]*?<\/infModal>/,
      `<docAnt><emiDocAnt><CNPJ>${TRANSP}</CNPJ><xNome>TRANSPORTADORA EXEMPLO</xNome><idDocAnt><idDocAntEle><chCTe>${anterior}</chCTe></idDocAntEle></idDocAnt></emiDocAnt></docAnt>` +
      `<infModal versaoModal="4.00"><aquav><vPrest>100.00</vPrest><xNavio>NAVIO EXEMPLO</xNavio><nViag>641</nViag><direc>N</direc><detCont><nCont>ABCU1234567</nCont><infDoc><infNFe><chave>${nfe}</chave></infNFe></infDoc></detCont></aquav></infModal>`)
    .replace('</compl>', '<ObsCont xCampo="Booking"><xTexto>Booking: 6AIBK914N</xTexto></ObsCont></compl>')
  return { xml, nfe, anterior }
}

module.exports = { NS, TRANSP, REM, DEST, EXPED, RECEB, chaveCte, cteProc, cteAquaviario, procEventoCte }
