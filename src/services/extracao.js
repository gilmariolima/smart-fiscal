'use strict'

// Extração defensiva dos campos dos documentos da SEFAZ (json do node-mde).
// Campo ausente ou em formato inesperado vira null; nada aqui lança exceção.

/** Valor de texto de um nó: string direta ou { value } quando o nó tem atributos. */
function texto(no) {
  if (no === null || no === undefined) return null
  if (typeof no === 'string' || typeof no === 'number') return String(no).trim() || null
  if (typeof no === 'object' && 'value' in no) return texto(no.value)
  return null
}

/** Navega por um caminho ('a.b.c') sem quebrar em nó ausente. */
function pegar(obj, caminho) {
  let atual = obj
  for (const parte of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object') return null
    atual = atual[parte]
  }
  return atual === undefined ? null : atual
}

const textoEm = (obj, caminho) => texto(pegar(obj, caminho))

function numero(v) {
  const n = Number(texto(v))
  return texto(v) !== null && Number.isFinite(n) ? n : null
}

/** 'AAAA-MM' a partir de dhEmi ('2026-10-08T10:00:00-03:00') ou dEmi ('2026-10-08'). */
function competenciaDe(data) {
  const m = /^(\d{4})-(\d{2})/.exec(texto(data) || '')
  return m ? `${m[1]}-${m[2]}` : null
}

/** Série e número a partir da chave (posições 23-25 e 26-34 do layout). */
function serieNumeroDaChave(chave) {
  if (!/^\d{44}$/.test(chave || '')) return { serie: null, numero: null }
  return { serie: String(Number(chave.slice(22, 25))), numero: String(Number(chave.slice(25, 34))) }
}

function chaveValida(chave) {
  return /^\d{44}$/.test(chave || '') ? chave : null
}

function dadosResNFe(json) {
  const r = pegar(json, 'resNFe') || {}
  const chave = chaveValida(texto(r.chNFe))
  const { serie, numero: num } = serieNumeroDaChave(chave)
  return {
    chave,
    emitente_cnpj: texto(r.CNPJ) || texto(r.CPF),
    emitente_nome: texto(r.xNome),
    emitente_ie: texto(r.IE),
    numero: num,
    serie,
    data_emissao: texto(r.dhEmi),
    valor_total: numero(r.vNF),
    tipo_nf: texto(r.tpNF),
    situacao_sefaz: texto(r.cSitNFe),
    competencia: competenciaDe(r.dhEmi),
  }
}

function dadosNfeProc(json) {
  const proc = pegar(json, 'nfeProc') || {}
  const inf = pegar(proc, 'NFe.infNFe') || {}
  const idChave = (texto(pegar(inf, '@_Id')) || '').replace(/^NFe/, '')
  const chave = chaveValida(textoEm(proc, 'protNFe.infProt.chNFe')) || chaveValida(idChave)
  const doChave = serieNumeroDaChave(chave)
  const dataEmissao = textoEm(inf, 'ide.dhEmi') || textoEm(inf, 'ide.dEmi')
  return {
    chave,
    emitente_cnpj: textoEm(inf, 'emit.CNPJ') || textoEm(inf, 'emit.CPF'),
    emitente_nome: textoEm(inf, 'emit.xNome'),
    emitente_ie: textoEm(inf, 'emit.IE'),
    numero: textoEm(inf, 'ide.nNF') || doChave.numero,
    serie: textoEm(inf, 'ide.serie') || doChave.serie,
    data_emissao: dataEmissao,
    valor_total: numero(pegar(inf, 'total.ICMSTot.vNF')),
    tipo_nf: textoEm(inf, 'ide.tpNF'),
    competencia: competenciaDe(dataEmissao),
    destinatario_cnpj: textoEm(inf, 'dest.CNPJ') || textoEm(inf, 'dest.CPF'),
    destinatario_nome: textoEm(inf, 'dest.xNome'),
  }
}

/** Evento a partir de procEventoNFe (completo) ou resEvento (resumo). */
function dadosEvento(json) {
  if (pegar(json, 'procEventoNFe')) {
    const inf = pegar(json, 'procEventoNFe.evento.infEvento') || {}
    const ret = pegar(json, 'procEventoNFe.retEvento.infEvento') || {}
    return {
      chave: chaveValida(texto(inf.chNFe)),
      tp_evento: texto(inf.tpEvento),
      n_seq: texto(inf.nSeqEvento) || '1',
      descricao: textoEm(inf, 'detEvento.descEvento') || texto(ret.xEvento),
      data_evento: texto(inf.dhEvento),
      protocolo: texto(ret.nProt),
      completo: true,
    }
  }
  const r = pegar(json, 'resEvento') || {}
  return {
    chave: chaveValida(texto(r.chNFe)),
    tp_evento: texto(r.tpEvento),
    n_seq: texto(r.nSeqEvento) || '1',
    descricao: texto(r.xEvento),
    data_evento: texto(r.dhEvento),
    protocolo: texto(r.nProt),
    completo: false,
  }
}

module.exports = { texto, pegar, competenciaDe, serieNumeroDaChave, dadosResNFe, dadosNfeProc, dadosEvento }
