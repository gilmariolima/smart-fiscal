'use strict'

// Planilha do mês (notas.xlsx) que vai no pacote da exportação e no botão "Baixar Excel":
// - sem modelo (pacote completo): aba NF-e, aba NFS-e e aba Retenções (impostos retidos das NFS-e, lidos do XML);
// - com modelo ("Exportar mês" da NF-e ou da NFS-e): abas Entradas e Saídas só daquele modelo;
//   na NFS-e as retenções viram colunas de cada linha.

const { montarXlsx } = require('./planilha')
const { retencoesNfse } = require('./extracaoNfse')

const SITUACOES = { completa: 'XML completo', resumo: 'Só resumo', ciencia_enviada: 'Aguardando XML', ciencia_erro: 'Erro na ciência' }

function documento(d) {
  const s = String(d || '').replace(/\D/g, '')
  if (s.length === 14) return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`
  if (s.length === 11) return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
  return d || ''
}

const tipo = (n) => (n.tipo === 'saida' ? 'Saída' : 'Entrada')
const simNao = (v) => (v ? 'Sim' : 'Não')
const competencia = (c) => (/^\d{4}-\d{2}$/.test(c || '') ? `${c.slice(5)}/${c.slice(0, 4)}` : '')

// Retenções lidas do XML da NFS-e; null sem arquivo ou com XML ilegível.
function retencoesDe(n, lerXml) {
  try {
    const xml = n.caminho_xml ? lerXml(n) : null
    return xml ? retencoesNfse(xml) : null
  } catch {
    return null
  }
}

const COLUNAS_NFE = ['Número', 'Série', 'Emissão', 'CNPJ emitente', 'Emitente', 'CNPJ destinatário', 'Destinatário', 'Valor', 'Situação', 'Cancelada', 'Chave']
const COLUNAS_NFSE = ['Número', 'Competência', 'Emissão', 'CNPJ prestador', 'Prestador', 'CNPJ tomador', 'Tomador', 'Valor do serviço', 'ISS', 'ISS retido', 'IRRF', 'CSLL', 'INSS', 'PIS', 'COFINS', 'Total retido', 'Valor líquido', 'Situação', 'Cancelada', 'Chave']

function linhaNfe(n) {
  return [n.numero, n.serie, n.data_emissao, documento(n.emitente_cnpj), n.emitente_nome, documento(n.destinatario_cnpj), n.destinatario_nome, n.valor_total, SITUACOES[n.status] || n.status, simNao(n.cancelada), n.chave]
}

// Sem XML legível as colunas de impostos ficam vazias e o valor vem do banco.
function linhaNfse(n, lerXml) {
  const r = retencoesDe(n, lerXml)
  const impostos = r ? [r.iss, simNao(r.issRetido), r.irrf, r.csll, r.inss, r.pis, r.cofins, r.totalRetido, r.valorLiquido] : Array(9).fill('')
  return [
    n.numero, competencia(n.competencia), n.data_emissao, documento(n.emitente_cnpj), n.emitente_nome, documento(n.destinatario_cnpj), n.destinatario_nome,
    r ? r.valorServico : n.valor_total, ...impostos, SITUACOES[n.status] || n.status, simNao(n.cancelada), n.chave,
  ]
}

// Abas Entradas e Saídas de um modelo só.
function porDirecao(notas, modelo, lerXml) {
  const nfse = modelo === 'nfse'
  const daquele = notas.filter((n) => (n.modelo === 'nfse') === nfse)
  const aba = (nome, direcao) => ({
    nome,
    colunas: nfse ? COLUNAS_NFSE : COLUNAS_NFE,
    linhas: daquele.filter((n) => (n.tipo === 'saida' ? 'saida' : 'entrada') === direcao).map((n) => (nfse ? linhaNfse(n, lerXml) : linhaNfe(n))),
  })
  return montarXlsx([aba('Entradas', 'entrada'), aba('Saídas', 'saida')])
}

/**
 * @param {object} p
 * @param {object[]} p.notas linhas da tabela `notas` (NF-e e NFS-e)
 * @param {(nota: object) => string|null} p.lerXml XML da nota ou null (sem arquivo)
 * @param {'nfe'|'nfse'} [p.modelo] só esse modelo, em abas Entradas e Saídas
 * @returns {Promise<Buffer>}
 */
function montarPlanilhaDoMes({ notas, lerXml, modelo }) {
  if (modelo) return porDirecao(notas, modelo, lerXml)
  const nfe = notas.filter((n) => n.modelo !== 'nfse')
  const nfse = notas.filter((n) => n.modelo === 'nfse')

  const retencoes = []
  for (const n of nfse) {
    const r = retencoesDe(n, lerXml)
    if (!r) continue
    retencoes.push([
      tipo(n), n.numero, competencia(n.competencia), documento(n.emitente_cnpj), n.emitente_nome, documento(n.destinatario_cnpj), n.destinatario_nome,
      r.valorServico, r.iss, simNao(r.issRetido), r.irrf, r.csll, r.inss, r.pis, r.cofins, r.totalRetido, r.valorLiquido,
    ])
  }

  return montarXlsx([
    {
      nome: 'NF-e',
      colunas: ['Tipo', 'Número', 'Série', 'Emissão', 'CNPJ emitente', 'Emitente', 'CNPJ destinatário', 'Destinatário', 'Valor', 'Situação', 'Cancelada', 'Chave'],
      linhas: nfe.map((n) => [
        tipo(n), n.numero, n.serie, n.data_emissao, documento(n.emitente_cnpj), n.emitente_nome, documento(n.destinatario_cnpj), n.destinatario_nome,
        n.valor_total, SITUACOES[n.status] || n.status, simNao(n.cancelada), n.chave,
      ]),
    },
    {
      nome: 'NFS-e',
      colunas: ['Tipo', 'Número', 'Competência', 'Emissão', 'CNPJ prestador', 'Prestador', 'CNPJ tomador', 'Tomador', 'Valor do serviço', 'Cancelada', 'Chave'],
      linhas: nfse.map((n) => [
        tipo(n), n.numero, competencia(n.competencia), n.data_emissao, documento(n.emitente_cnpj), n.emitente_nome, documento(n.destinatario_cnpj), n.destinatario_nome,
        n.valor_total, simNao(n.cancelada), n.chave,
      ]),
    },
    {
      nome: 'Retenções',
      colunas: ['Tipo', 'Número', 'Competência', 'CNPJ prestador', 'Prestador', 'CNPJ tomador', 'Tomador', 'Valor do serviço', 'ISS', 'ISS retido', 'IRRF', 'CSLL', 'INSS', 'PIS', 'COFINS', 'Total retido', 'Valor líquido'],
      linhas: retencoes,
    },
  ])
}

module.exports = { montarPlanilhaDoMes }
