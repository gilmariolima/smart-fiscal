'use strict'

// Leitores do Importar: reconhecem NF-e, CT-e e NFS-e (e os eventos dos três) pela raiz do XML
// e dizem quem fica com a nota. Reaproveitam as extrações da captura.

const { XMLParser, XMLValidator } = require('fast-xml-parser')
const { xmlParaJson } = require('../sefaz/xml')
const { texto, pegar, dadosNfeProc, dadosEvento } = require('./extracao')
const { dadosCte, papelDoCliente, dadosEventoCte } = require('./extracaoCte')
const { decodificarXml, dadosNfse, dadosEventoNfse } = require('./extracaoNfse')
const { nomes } = require('./armazenamento')

const CANCELAMENTOS = { nfe: ['110111'], cte: ['110111'], nfse: ['101101', '105102'] }
const AUTORIZADA = ['100', '150']
const CHAVE_44 = /^\d{44}$/
const CHAVE_NFSE = /^\d{50}$/
const raiz = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true })
// As mesmas opções do xmlParaJson, sem o prefixo de namespace (há emissor que grava <nfe:nfeProc>).
const semPrefixo = new XMLParser({ attributeNamePrefix: '@_', textNodeName: 'value', ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: true, removeNSPrefix: true })
const textoEm = (obj, caminho) => texto(pegar(obj, caminho))

function lerNfe(xml) {
  const json = semPrefixo.parse(xml)
  const ide = pegar(json, 'nfeProc.NFe.infNFe.ide') || {}
  if (textoEm(ide, 'mod') !== '55') return { motivo: 'nao-suportado' }
  const d = dadosNfeProc(json)
  if (!d.chave) return { motivo: 'invalido' }
  if (textoEm(ide, 'tpAmb') === '2') return { motivo: 'homologacao' }
  if (!AUTORIZADA.includes(textoEm(json, 'nfeProc.protNFe.infProt.cStat'))) return { motivo: 'sem-protocolo' }
  return { tipo: 'nota', modelo: 'nfe', d: { ...d, partes: null } }
}

function lerCte(xml) {
  const c = dadosCte(xml)
  if (c.modelo !== '57') return { motivo: 'nao-suportado' }
  if (!CHAVE_44.test(c.chave || '')) return { motivo: 'invalido' }
  if (c.ambiente === 'homologacao') return { motivo: 'homologacao' }
  if (!AUTORIZADA.includes(c.protocolo?.cStat)) return { motivo: 'sem-protocolo' }
  return {
    tipo: 'nota',
    modelo: 'cte',
    d: {
      chave: c.chave, competencia: c.competencia,
      emitente_cnpj: c.emitente?.documento || null, emitente_nome: c.emitente?.nome || null, emitente_ie: c.emitente?.ie || null,
      destinatario_cnpj: c.tomador?.documento || null, destinatario_nome: c.tomador?.nome || null,
      numero: c.numero, serie: c.serie, data_emissao: c.dataEmissao, valor_total: c.valorPrestacao, tipo_nf: null,
      partes: c,
    },
  }
}

function lerNfse(xml) {
  const n = dadosNfse(xml)
  // A chave vira nome de arquivo e decide modelo e direção: só a de 50 dígitos do padrão nacional.
  if (!CHAVE_NFSE.test(n.chave || '')) return { motivo: 'invalido' }
  return {
    tipo: 'nota',
    modelo: 'nfse',
    d: {
      chave: n.chave, competencia: n.competencia,
      emitente_cnpj: n.prestadorCnpj, emitente_nome: n.prestadorNome, emitente_ie: null,
      destinatario_cnpj: n.tomadorCnpj, destinatario_nome: n.tomadorNome,
      numero: n.numero, serie: null, data_emissao: n.dataEmissao, valor_total: n.valor, tipo_nf: null,
      partes: n,
    },
  }
}

function evento(modelo, e) {
  const valido = modelo === 'nfse' ? CHAVE_NFSE : CHAVE_44
  if (!valido.test(e.chave || '') || !e.tp_evento) return { motivo: 'invalido' }
  const { chave, tp_evento, n_seq, descricao, data_evento, protocolo } = e
  return { tipo: 'evento', modelo, e: { chave, tp_evento, n_seq: n_seq || '1', descricao, data_evento, protocolo } }
}

const LEITORES = {
  nfeProc: lerNfe,
  cteProc: lerCte,
  NFSe: lerNfse,
  procEventoNFe: (xml) => evento('nfe', dadosEvento(xmlParaJson(xml))),
  procEventoCTe: (xml) => {
    const e = dadosEventoCte(xml)
    return evento('cte', { chave: e.chave, tp_evento: e.tpEvento, n_seq: e.nSeq, descricao: e.descricao, data_evento: e.dataEvento, protocolo: e.protocolo })
  },
  evento: (xml, arvore) => (arvore.evento?.infEvento?.pedRegEvento ? evento('nfse', dadosEventoNfse(xml)) : { motivo: 'nao-suportado' }),
}

/**
 * Lê os bytes de um XML.
 * @returns {{ tipo: 'nota', modelo, d } | { tipo: 'evento', modelo, e } | { motivo }}
 */
function lerDocumento(bytes) {
  const xml = decodificarXml(bytes).replace(/^﻿/, '')
  if (XMLValidator.validate(xml) !== true) return { motivo: 'invalido' }
  const arvore = raiz.parse(xml) || {}
  const nome = Object.keys(arvore).find((k) => k !== '?xml')
  const leitor = LEITORES[nome]
  if (!leitor) return { motivo: 'nao-suportado' }
  try {
    const r = leitor(xml, arvore)
    return r.motivo ? r : { ...r, xml }
  } catch {
    return { motivo: 'invalido' }
  }
}

/** Quem fica com a nota: [[cliente, 'entrada' | 'saida' | 'outro']], só entre os clientes de `porCnpj`. */
function donos(modelo, d, porCnpj) {
  if (modelo === 'cte') {
    const vistos = new Set()
    const lista = []
    for (const p of [d.partes.emitente, d.partes.tomador, d.partes.remetente, d.partes.destinatario, d.partes.expedidor, d.partes.recebedor]) {
      const c = p?.documento && porCnpj.get(p.documento)
      if (!c || vistos.has(c.id)) continue
      vistos.add(c.id)
      lista.push([c, papelDoCliente(d.partes, c.cnpj)])
    }
    return lista
  }
  const lista = [
    [porCnpj.get(d.emitente_cnpj), 'saida'],
    [porCnpj.get(d.destinatario_cnpj), 'entrada'],
  ].filter(([c], i, todos) => c && (i === 0 || c.id !== todos[0][0]?.id))
  if (lista.length || modelo !== 'nfse') return lista
  // NFS-e sem prestador nem tomador na carteira: o intermediário fica com ela como entrada.
  const intermediario = d.partes.intermediarioCnpj && porCnpj.get(d.partes.intermediarioCnpj)
  return intermediario ? [[intermediario, 'entrada']] : []
}

const nomeArquivo = (modelo, chave) => nomes[modelo](chave)

module.exports = { lerDocumento, donos, nomeArquivo, CANCELAMENTOS }
