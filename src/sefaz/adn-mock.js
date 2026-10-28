'use strict'

// ADN (NFS-e Nacional) simulado, para os testes e o modo SEFAZ_MOCK.
// Cada CNPJ tem uma fila de documentos; o NSU é a posição na fila (1, 2, 3...).
// Por padrão o CNPJ_MOCK_OK recebe: 2 NFS-e tomadas, 1 prestada e o cancelamento da primeira tomada.

const { CNPJ_MOCK_OK } = require('./mock-client')

const PRESTADOR_MOCK = '99888777000166'

/** cLocEmi(7) + ambGer(1) + tpInsc(1) + CNPJ(14) + nNFSe(13) + AAMM(4) + cNum(9) + DV(1) = 50 */
const chaveNfse = (prestador, n, aamm = '2610') => `230440012${prestador}${String(n).padStart(13, '0')}${aamm}${'1'.repeat(9)}0`

function xmlNfse({ chave, prestador, tomador, numero = '1', dCompet = '2026-10-01', dhEmi = '2026-10-05T10:00:00-03:00', ambGer = '2', vServ = '150.00', xLocEmi = 'FORTALEZA' }) {
  return '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">'
    + `<infNFSe Id="NFS${chave}"><xLocEmi>${xLocEmi}</xLocEmi><nNFSe>${numero}</nNFSe><ambGer>${ambGer}</ambGer><cStat>100</cStat>`
    + `<dhProc>${dhEmi}</dhProc><emit><CNPJ>${prestador}</CNPJ><xNome>PRESTADOR ${prestador}</xNome></emit><valores><vLiq>${vServ}</vLiq></valores>`
    + `<DPS versao="1.00"><infDPS><dhEmi>${dhEmi}</dhEmi><dCompet>${dCompet}</dCompet><prest><CNPJ>${prestador}</CNPJ></prest>`
    + `<toma><CNPJ>${tomador}</CNPJ><xNome>TOMADOR ${tomador}</xNome></toma><serv><cServ><xDescServ>Serviço de teste</xDescServ></cServ></serv>`
    + `<valores><vServPrest><vServ>${vServ}</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`
}

function xmlEventoNfse({ chave, codigo = '101101', descricao = 'Cancelamento de NFS-e', dhEvento = '2026-10-06T10:00:00-03:00', nSeq = '001' }) {
  return '<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">'
    + `<infEvento Id="EVT${chave}${codigo}${nSeq}"><ambGer>2</ambGer><nSeqEvento>${nSeq}</nSeqEvento><dhProc>${dhEvento}</dhProc><nDFSe>1</nDFSe>`
    + `<pedRegEvento versao="1.00"><infPedReg><dhEvento>${dhEvento}</dhEvento><chNFSe>${chave}</chNFSe>`
    + `<e${codigo}><xDesc>${descricao}</xDesc></e${codigo}></infPedReg></pedRegEvento></infEvento></evento>`
}

const nfse = (dados) => ({ tipo: 'NFSE', chave: dados.chave, xml: xmlNfse(dados) })
const eventoNfse = (dados) => ({ tipo: 'EVENTO', chave: dados.chave, xml: xmlEventoNfse(dados) })

function documentosPadrao(cnpj) {
  const tomada1 = chaveNfse(PRESTADOR_MOCK, 1)
  return [
    nfse({ chave: tomada1, prestador: PRESTADOR_MOCK, tomador: cnpj, numero: '1' }),
    nfse({ chave: chaveNfse(PRESTADOR_MOCK, 2), prestador: PRESTADOR_MOCK, tomador: cnpj, numero: '2', vServ: '320.55' }),
    nfse({ chave: chaveNfse(cnpj, 3), prestador: cnpj, tomador: PRESTADOR_MOCK, numero: '3', vServ: '1000.00' }),
    eventoNfse({ chave: tomada1 }),
  ]
}

/**
 * @param {object} [opcoes]
 * @param {number} [opcoes.tamanhoLote] documentos por resposta (padrão 50, como o ADN)
 * @param {Object<string, Array>} [opcoes.documentos] fila por CNPJ; sem ela, o CNPJ_MOCK_OK usa documentosPadrao
 */
function criarAdnMock({ tamanhoLote = 50, documentos } = {}) {
  const filas = new Map(Object.entries(documentos || { [CNPJ_MOCK_OK]: documentosPadrao(CNPJ_MOCK_OK) }))
  const falhas = new Map()
  const chamadas = []

  function cliente(cnpj) {
    return {
      cnpj,
      async consultarLote(nsu) {
        chamadas.push({ cnpj, nsu: String(nsu) })
        if (falhas.has(cnpj)) return { ok: false, status: null, documentos: [], erro: falhas.get(cnpj) }
        const fila = filas.get(cnpj) || []
        const inicio = Number(nsu) || 0
        const lote = fila.slice(inicio, inicio + tamanhoLote).map((d, i) => ({ nsu: String(inicio + i + 1), chave: d.chave, tipo: d.tipo, xml: d.xml, geradoEm: null }))
        if (!lote.length) return { ok: true, status: 'NENHUM_DOCUMENTO_LOCALIZADO', documentos: [], erro: null }
        return { ok: true, status: 'DOCUMENTOS_LOCALIZADOS', documentos: lote, erro: null }
      },
    }
  }

  return {
    cliente,
    chamadas,
    /** Acrescenta documentos no fim da fila do CNPJ. */
    adicionar: (cnpj, docs) => filas.set(cnpj, [...(filas.get(cnpj) || []), ...docs]),
    /** Faz o CNPJ responder com erro (null volta ao normal). */
    falhar: (cnpj, erro) => (erro ? falhas.set(cnpj, erro) : falhas.delete(cnpj)),
  }
}

module.exports = { criarAdnMock, xmlNfse, xmlEventoNfse, nfse, eventoNfse, chaveNfse, documentosPadrao, PRESTADOR_MOCK }
