'use strict'

// Planilha do mês (notas.xlsx) que vai no pacote da exportação e no botão "Baixar Excel":
// aba NF-e, aba NFS-e e aba Retenções (impostos retidos das NFS-e, lidos do XML).

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

/**
 * @param {object} p
 * @param {object[]} p.notas linhas da tabela `notas` (NF-e e NFS-e)
 * @param {(nota: object) => string|null} p.lerXml XML da nota ou null (sem arquivo)
 * @returns {Promise<Buffer>}
 */
function montarPlanilhaDoMes({ notas, lerXml }) {
  const nfe = notas.filter((n) => n.modelo !== 'nfse')
  const nfse = notas.filter((n) => n.modelo === 'nfse')

  const retencoes = []
  for (const n of nfse) {
    let r = null
    try {
      const xml = n.caminho_xml ? lerXml(n) : null
      if (xml) r = retencoesNfse(xml)
    } catch {
      r = null
    }
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
