'use strict'

// CT-e (CTeDistribuicaoDFe) simulado, para os testes e o modo SEFAZ_MOCK.
// Cada CNPJ tem uma fila de documentos { xml, schema? }; o NSU é a posição na fila (1, 2, 3...).
// Sem documentos na fila, responde 137 (nenhum documento localizado), como a SEFAZ.

const nsu15 = (n) => String(n).padStart(15, '0')

/**
 * @param {object} [opcoes]
 * @param {number} [opcoes.tamanhoLote] documentos por resposta (padrão 50)
 * @param {Object<string, Array<{ xml: string, schema?: string }>>} [opcoes.documentos] fila por CNPJ
 */
function criarCteMock({ tamanhoLote = 50, documentos } = {}) {
  const filas = new Map(Object.entries(documentos || {}))
  const falhas = new Map()
  const respostas = new Map()
  const chamadas = []

  function cliente(cnpj) {
    return {
      cnpj,
      async consultarLote(ultNSU) {
        chamadas.push({ cnpj, nsu: String(ultNSU) })
        const vazio = { documentos: [], ultNSU: null, maxNSU: null }
        if (falhas.has(cnpj)) return { ok: false, cStat: null, xMotivo: null, ...vazio, erro: falhas.get(cnpj) }
        if (respostas.has(cnpj)) {
          const { cStat, xMotivo } = respostas.get(cnpj)
          return { ok: false, cStat, xMotivo, ...vazio, erro: `${cStat} ${xMotivo || ''}`.trim() }
        }
        const fila = filas.get(cnpj) || []
        const inicio = Number(ultNSU) || 0
        const lote = fila.slice(inicio, inicio + tamanhoLote).map((d, i) => ({ nsu: nsu15(inicio + i + 1), schema: d.schema || 'procCTe_v4.00.xsd', xml: d.xml }))
        const maxNSU = nsu15(fila.length)
        if (!lote.length) return { ok: true, cStat: '137', xMotivo: 'Nenhum documento localizado.', documentos: [], ultNSU: nsu15(inicio), maxNSU, erro: null }
        return { ok: true, cStat: '138', xMotivo: 'Documento localizado', documentos: lote, ultNSU: lote[lote.length - 1].nsu, maxNSU, erro: null }
      },
    }
  }

  return {
    cliente,
    chamadas,
    /** Acrescenta documentos no fim da fila do CNPJ. */
    adicionar: (cnpj, docs) => filas.set(cnpj, [...(filas.get(cnpj) || []), ...docs]),
    /** Faz o CNPJ responder com erro de rede (null volta ao normal). */
    falhar: (cnpj, erro) => (erro ? falhas.set(cnpj, erro) : falhas.delete(cnpj)),
    /** Força um cStat de rejeição (ex.: 656); null volta ao normal. */
    responder: (cnpj, resposta) => (resposta ? respostas.set(cnpj, resposta) : respostas.delete(cnpj)),
  }
}

module.exports = { criarCteMock }
