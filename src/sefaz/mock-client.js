'use strict'

// SEFAZ simulada (NFeDistribuicaoDFe + RecepcaoEvento) com a mesma interface de client.js.
// Comportamento por CNPJ destinatário:
// - 'normal': fila de documentos por NSU. Lote 1 = resNFe A e B (138); lote 2 = procNFe C
//   (chegou direto, sem resumo) e o cancelamento (110111) de B; depois 137.
//   A ciência (210210) de uma nota coloca o procNFe dela no fim da fila, com NSU novo,
//   e libera o XML completo na consulta por chave. Com `cienciaDoDono`, o dono da empresa
//   dá a ciência fora do app logo depois que o resumo sai na distribuição (menos na nota cancelada B).
// - '656': toda consulta de distribuição devolve consumo indevido.
// - 'escritorio': certificado do escritório (CNPJ no autXML). Só procNFe de notas de saída dos clientes
//   (S1, S2, E1, F1), cancelamento de S2 e um resNFe que deve ser ignorado; depois 137.
// - 'erro': toda chamada devolve { error } (falha de rede simulada).

const { xmlParaJson } = require('./xml')

const NS = 'http://www.portalfiscal.inf.br/nfe'
const CNPJ_MOCK_OK = '11222333000181'
const CNPJ_MOCK_656 = '99888777000100'
const CNPJ_MOCK_ESCRITORIO = '44555666000181'
const CNPJ_FORA_CARTEIRA = '55666777000181'
const EVENTOS_MANIFESTACAO = { 210200: 'Confirmacao da Operacao', 210210: 'Ciencia da Operacao', 210220: 'Desconhecimento da Operacao', 210240: 'Operacao nao Realizada' }

const EMITENTES = [
  { cnpj: '12345678000195', nome: 'Fornecedor Alfa Ltda', ie: '061234567' },
  { cnpj: '23456789000195', nome: 'Distribuidora Beta S/A', ie: '062345678' },
  { cnpj: '34567890000130', nome: 'Comercio Gama ME', ie: '063456789' },
]

const pad = (v, n) => String(v).padStart(n, '0')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Data no formato da SEFAZ com fuso -03:00 (ex.: 2026-10-09T10:00:00-03:00). */
function dataSefaz(d) {
  return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 19) + '-03:00'
}

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

/** Chave de 44 dígitos com dígito verificador correto. */
function gerarChave({ cUF = '23', data, cnpjEmit, serie = 1, nNF, cNF }) {
  const aamm = pad(data.getUTCFullYear() % 100, 2) + pad(data.getUTCMonth() + 1, 2)
  const base = `${cUF}${aamm}${cnpjEmit}55${pad(serie, 3)}${pad(nNF, 9)}1${pad(cNF, 8)}`
  return base + dvChave(base)
}

function xmlResNFe(n) {
  return `<resNFe xmlns="${NS}" versao="1.01"><chNFe>${n.chave}</chNFe><CNPJ>${n.emit.cnpj}</CNPJ><xNome>${esc(n.emit.nome)}</xNome><IE>${n.emit.ie}</IE><dhEmi>${n.dhEmi}</dhEmi><tpNF>1</tpNF><vNF>${n.vNF}</vNF><digVal>bW9jay1kaWdlc3QtdmFsdWU=</digVal><dhRecbto>${n.dhEmi}</dhRecbto><nProt>${n.nProt}</nProt><cSitNFe>1</cSitNFe></resNFe>`
}

function xmlNfeProc(n, dest, tpAmb) {
  return `<nfeProc xmlns="${NS}" versao="4.00"><NFe xmlns="${NS}"><infNFe Id="NFe${n.chave}" versao="4.00">` +
    `<ide><cUF>23</cUF><cNF>${n.cNF}</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>${n.nNF}</nNF><dhEmi>${n.dhEmi}</dhEmi><tpNF>1</tpNF><tpAmb>${tpAmb}</tpAmb></ide>` +
    `<emit><CNPJ>${n.emit.cnpj}</CNPJ><xNome>${esc(n.emit.nome)}</xNome><IE>${n.emit.ie}</IE></emit>` +
    `<dest><CNPJ>${dest}</CNPJ><xNome>CLIENTE SIMULADO</xNome></dest>` +
    `<total><ICMSTot><vNF>${n.vNF}</vNF></ICMSTot></total></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><chNFe>${n.chave}</chNFe><dhRecbto>${n.dhEmi}</dhRecbto><nProt>${n.nProt}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`
}

function xmlCancelamento(n, tpAmb, dhEvento, nProtEvento) {
  return `<procEventoNFe xmlns="${NS}" versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${n.chave}01">` +
    `<cOrgao>23</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${n.emit.cnpj}</CNPJ><chNFe>${n.chave}</chNFe><dhEvento>${dhEvento}</dhEvento>` +
    `<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${n.nProt}</nProt><xJust>Nota emitida com erro de digitacao</xJust></detEvento></infEvento></evento>` +
    `<retEvento versao="1.00"><infEvento><tpAmb>${tpAmb}</tpAmb><cOrgao>23</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
    `<chNFe>${n.chave}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>${dhEvento}</dhRegEvento><nProt>${nProtEvento}</nProt></infEvento></retEvento></procEventoNFe>`
}

const doc = (nsu, schema, xml) => ({ nsu, schema, xml, json: xmlParaJson(xml) })

/**
 * @param {object} [opcoes]
 * @param {object} [opcoes.cenarios] { [cnpj]: { modo: 'normal' | '656' | 'erro' | 'escritorio' } }
 * @param {number} [opcoes.tamanhoLote] documentos por resposta (padrão 2)
 * @param {Date}   [opcoes.dataBase] data de emissão das notas simuladas (padrão: agora)
 * @param {string} [opcoes.tpAmb]
 */
function criarSefazMock({ cenarios = { [CNPJ_MOCK_656]: { modo: '656' } }, tamanhoLote = 2, dataBase = new Date(), tpAmb = '2', cienciaDoDono = false } = {}) {
  const estados = new Map()
  const chamadas = []
  let seqProt = 0
  const nProt = () => `3232600000${pad(++seqProt, 5)}`

  /** Notas determinísticas por CNPJ (números diferentes para cada destinatário). */
  function notasDoCliente(cnpj, dataBase) {
    const semente = Number(cnpj.slice(0, 4)) % 900
    const valores = ['1500.00', '820.50', '99.90']
    return EMITENTES.map((emit, i) => {
      const data = new Date(dataBase.getTime() - (i + 1) * 3600e3)
      const nNF = 1000 * (i + 1) + semente
      const n = { emit, nNF, cNF: pad(nNF * 7, 8), vNF: valores[i], dhEmi: dataSefaz(data), nProt: nProt() }
      n.chave = gerarChave({ data, cnpjEmit: emit.cnpj, nNF, cNF: n.cNF })
      return n
    })
  }

  function novoEstadoEscritorio(st) {
    const cliente = { cnpj: CNPJ_MOCK_OK, nome: 'Cliente Simulado Ltda', ie: '061111111' }
    // E1 é a mesma nota (mesma chave e nProt) da fila normal do cliente, seja qual for a ordem das consultas.
    const [a, b] = [...estado(CNPJ_MOCK_OK).notas.values()]
    const saida = (i, nNF, vNF, emit = cliente) => {
      const data = new Date(dataBase.getTime() - (i + 4) * 3600e3)
      const n = { emit, nNF, cNF: pad(nNF * 7, 8), vNF, dhEmi: dataSefaz(data), nProt: nProt() }
      n.chave = gerarChave({ data, cnpjEmit: emit.cnpj, nNF, cNF: n.cNF })
      return n
    }
    const s1 = saida(1, 5001, '310.00')
    const s2 = saida(2, 5002, '455.75')
    const f1 = saida(3, 7003, '77.30', EMITENTES[2])
    for (const n of [s1, s2, a, f1]) st.notas.set(n.chave, n)
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(s1, CNPJ_FORA_CARTEIRA, tpAmb))
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(s2, CNPJ_FORA_CARTEIRA, tpAmb))
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(a, CNPJ_MOCK_OK, tpAmb))
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(f1, CNPJ_FORA_CARTEIRA, tpAmb))
    adicionar(st, 'procEventoNFe_v1.00.xsd', xmlCancelamento(s2, tpAmb, dataSefaz(dataBase), nProt()))
    adicionar(st, 'resNFe_v1.01.xsd', xmlResNFe(b))
    return st
  }

  function novoEstado(cnpj) {
    const cenario = cenarios[cnpj] || (cnpj === CNPJ_MOCK_ESCRITORIO ? { modo: 'escritorio' } : { modo: 'normal' })
    const st = { cnpj, modo: cenario.modo || 'normal', docs: [], notas: new Map(), eventos: new Map() }
    if (st.modo === 'escritorio') return novoEstadoEscritorio(st)
    if (st.modo !== 'normal') return st

    for (const n of notasDoCliente(cnpj, dataBase)) st.notas.set(n.chave, n)
    const [a, b, c] = [...st.notas.values()]
    c.liberada = true // chega completa sem resumo
    b.cancelada = true
    adicionar(st, 'resNFe_v1.01.xsd', xmlResNFe(a))
    adicionar(st, 'resNFe_v1.01.xsd', xmlResNFe(b))
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(c, cnpj, tpAmb))
    adicionar(st, 'procEventoNFe_v1.00.xsd', xmlCancelamento(b, tpAmb, dataSefaz(dataBase), nProt()))
    return st
  }

  /** O dono deu ciência fora do app: o procNFe da nota entra no fim da fila (o maxNSU desta resposta ainda não o conta). */
  function liberarPeloDono(st, d) {
    if (d.schema !== 'resNFe_v1.01.xsd' || st.modo !== 'normal') return
    const n = [...st.notas.values()].find((x) => d.xml.includes(x.chave))
    if (!n || n.liberada || n.cancelada) return
    n.liberada = true
    adicionar(st, 'procNFe_v4.00.xsd', xmlNfeProc(n, st.cnpj, tpAmb))
  }

  function adicionar(st, schema, xml) {
    st.docs.push(doc(pad(st.docs.length + 1, 15), schema, xml))
  }

  function estado(cnpj) {
    if (!estados.has(cnpj)) estados.set(cnpj, novoEstado(cnpj))
    return estados.get(cnpj)
  }

  function resposta(cStat, xMotivo, extra = {}) {
    return { status: 200, data: { tpAmb, verAplic: 'MOCK_1.0', cStat, xMotivo, dhResp: dataSefaz(new Date()), ultNSU: '', maxNSU: '', docZip: [], ...extra } }
  }

  const ERRO_REDE = { error: '<error>connect ECONNREFUSED (SEFAZ simulada)</error>', status: 502, data: {} }

  function distribuicao(st, fn) {
    if (st.modo === 'erro') return ERRO_REDE
    const maxNSU = pad(st.docs.length, 15)
    if (st.modo === '656') return resposta('656', 'Rejeicao: Consumo Indevido', { ultNSU: maxNSU, maxNSU })
    return fn(maxNSU)
  }

  function cliente(cnpj) {
    const registrar = (metodo, arg) => {
      chamadas.push({ cnpj, metodo, arg })
      if (chamadas.length > 1000) chamadas.splice(0, chamadas.length - 1000)
    }
    const st = () => estado(cnpj)

    return {
      cnpj,
      async consultaUltNSU(ultNSU) {
        registrar('consultaUltNSU', ultNSU)
        return distribuicao(st(), (maxNSU) => {
          const pendentes = st().docs.filter((d) => d.nsu > pad(ultNSU, 15)).slice(0, tamanhoLote)
          if (!pendentes.length) return resposta('137', 'Nenhum documento localizado', { ultNSU: maxNSU, maxNSU })
          if (cienciaDoDono) for (const d of pendentes) liberarPeloDono(st(), d)
          return resposta('138', 'Documento localizado', { ultNSU: pendentes.at(-1).nsu, maxNSU, docZip: pendentes })
        })
      },
      async consultaNSU(nsu) {
        registrar('consultaNSU', nsu)
        return distribuicao(st(), (maxNSU) => {
          const d = st().docs.find((x) => x.nsu === pad(nsu, 15))
          if (!d) return resposta('137', 'Nenhum documento localizado', { ultNSU: maxNSU, maxNSU })
          return resposta('138', 'Documento localizado', { ultNSU: d.nsu, maxNSU, docZip: [d] })
        })
      },
      async consultaChNFe(chave) {
        registrar('consultaChNFe', chave)
        return distribuicao(st(), (maxNSU) => {
          const n = st().notas.get(chave)
          if (!n) return resposta('137', 'Nenhum documento localizado', { ultNSU: maxNSU, maxNSU })
          const d = n.liberada
            ? doc('000000000000000', 'procNFe_v4.00.xsd', xmlNfeProc(n, cnpj, tpAmb))
            : doc('000000000000000', 'resNFe_v1.01.xsd', xmlResNFe(n))
          return resposta('138', 'Documento localizado', { ultNSU: maxNSU, maxNSU, docZip: [d] })
        })
      },
      async enviarEvento({ idLote, lote }) {
        registrar('enviarEvento', { idLote, lote })
        const s = st()
        if (s.modo === 'erro') return ERRO_REDE
        // Mesmas validações do node-mde (lá elas lançam exceção; o client.js converte em { error }).
        if (!Array.isArray(lote) || lote.length < 1 || lote.length > 20) return { error: 'Um lote deve possuir no mínimo 1 e no máximo 20 eventos.', data: {} }
        for (const ev of lote) {
          if (!ev.chNFe || String(ev.chNFe).length !== 44) return { error: 'Chave da NF-e com tamanho incorreto.', data: {} }
          if (!EVENTOS_MANIFESTACAO[ev.tipoEvento]) return { error: 'Tipo Evento deve conter um dos valores: 210200, 210210, 210220 ou 210240', data: {} }
          const just = ev.justificativa || ''
          if (Number(ev.tipoEvento) === 210240 && (just.length < 15 || just.length > 255)) return { error: 'Justificativa com tamanho incorreto.', data: {} }
        }

        const agora = dataSefaz(new Date())
        const infEvento = lote.map((ev) => {
          const tp = String(ev.tipoEvento)
          const base = { tpAmb, verAplic: 'MOCK_1.0', cOrgao: '91', chNFe: ev.chNFe, tpEvento: tp, xEvento: EVENTOS_MANIFESTACAO[tp], nSeqEvento: '1', CNPJDest: cnpj, dhRegEvento: agora, nProt: '' }
          const n = s.notas.get(ev.chNFe)
          if (!n) return { ...base, cStat: '494', xMotivo: 'Rejeicao: Chave de Acesso inexistente' }
          const chaveEvento = `${ev.chNFe}|${tp}`
          if (s.eventos.has(chaveEvento)) return { ...base, cStat: '573', xMotivo: 'Rejeicao: Duplicidade de evento' }
          const prot = nProt()
          s.eventos.set(chaveEvento, prot)
          if (tp === '210210' && !n.liberada) {
            n.liberada = true
            adicionar(s, 'procNFe_v4.00.xsd', xmlNfeProc(n, cnpj, tpAmb))
          }
          return { ...base, cStat: '135', xMotivo: 'Evento registrado e vinculado a NF-e', nProt: prot }
        })
        return { status: 200, data: { idLote: String(idLote), tpAmb, verAplic: 'MOCK_1.0', cOrgao: '91', cStat: '128', xMotivo: 'Lote de evento processado', infEvento } }
      },
    }
  }

  return {
    cliente,
    chamadas,
    /** Estado interno de um CNPJ (para testes). */
    estado,
  }
}

module.exports = { criarSefazMock, gerarChave, CNPJ_MOCK_OK, CNPJ_MOCK_656, CNPJ_MOCK_ESCRITORIO, CNPJ_FORA_CARTEIRA }
