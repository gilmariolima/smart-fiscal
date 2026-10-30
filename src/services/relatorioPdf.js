'use strict'

// Relatório do mês em PDF (relatorio.pdf do pacote): o mesmo conteúdo da planilha, para imprimir ou mandar ao cliente.
// A4 paisagem; por modelo (NF-e, NFS-e) uma seção Entradas e uma Saídas, cada uma com a tabela, a quantidade e o total.
// Na NFS-e entram as retenções lidas do XML (ISS, ISS retido, demais retenções e valor líquido).

const PDFDocument = require('pdfkit')
const { retencoesNfse } = require('./extracaoNfse')

const MARGEM = 32
const NORMAL = 'Helvetica'
const NEGRITO = 'Helvetica-Bold'
const CINZA = '#f2f4f7'
const BORDA = '#d0d5dd'
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const SITUACOES = { completa: 'XML completo', resumo: 'Só resumo', ciencia_enviada: 'Aguardando XML', ciencia_erro: 'Erro na ciência' }

const dinheiro = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const data = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
function documento(d) {
  const s = String(d || '').replace(/\D/g, '')
  if (s.length === 14) return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`
  if (s.length === 11) return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
  return d || ''
}
const situacao = (n) => (n.cancelada ? 'Cancelada' : SITUACOES[n.status] || n.status)

function retencoesDe(n, lerXml) {
  try {
    const xml = n.caminho_xml ? lerXml(n) : null
    return xml ? retencoesNfse(xml) : null
  } catch {
    return null
  }
}

// Colunas: título, peso da largura, alinhamento e o valor da célula. `soma` marca a coluna que vai no total.
const COLUNAS = {
  nfe: [
    { titulo: 'Número', peso: 7, valor: (n) => n.numero || '' },
    { titulo: 'Emissão', peso: 7, valor: (n) => data(n.data_emissao) },
    { titulo: 'CNPJ emitente', peso: 11, valor: (n) => documento(n.emitente_cnpj) },
    { titulo: 'Emitente', peso: 22, valor: (n) => n.emitente_nome || '' },
    { titulo: 'CNPJ destinatário', peso: 11, valor: (n) => documento(n.destinatario_cnpj) },
    { titulo: 'Destinatário', peso: 18, valor: (n) => n.destinatario_nome || '' },
    { titulo: 'Valor', peso: 9, direita: true, soma: true, valor: (n) => n.valor_total },
    { titulo: 'Situação', peso: 9, valor: situacao },
  ],
  nfse: [
    { titulo: 'Número', peso: 6, valor: (n) => n.numero || '' },
    { titulo: 'Emissão', peso: 6, valor: (n) => data(n.data_emissao) },
    { titulo: 'Prestador', peso: 17, valor: (n) => n.emitente_nome || documento(n.emitente_cnpj) },
    { titulo: 'Tomador', peso: 13, valor: (n) => n.destinatario_nome || documento(n.destinatario_cnpj) },
    { titulo: 'Valor do serviço', peso: 8, direita: true, soma: true, valor: (n, r) => (r ? r.valorServico : n.valor_total) },
    { titulo: 'ISS', peso: 6, direita: true, soma: true, valor: (n, r) => (r ? r.iss : null) },
    { titulo: 'ISS retido', peso: 5, valor: (n, r) => (r ? (r.issRetido ? 'Sim' : 'Não') : '') },
    { titulo: 'Outras retenções', peso: 10, direita: true, soma: true, valor: (n, r) => (r ? r.irrf + r.csll + r.inss + r.pis + r.cofins : null) },
    { titulo: 'Total retido', peso: 7, direita: true, soma: true, valor: (n, r) => (r ? r.totalRetido : null) },
    { titulo: 'Valor líquido', peso: 8, direita: true, soma: true, valor: (n, r) => (r ? r.valorLiquido : null) },
    { titulo: 'Situação', peso: 8, valor: situacao },
  ],
}

/**
 * @param {object} p
 * @param {{ cnpj: string, nome: string }} p.cliente
 * @param {string} p.competencia 'AAAA-MM'
 * @param {object[]} p.notas linhas da tabela `notas`
 * @param {(nota: object) => string|null} p.lerXml XML da nota ou null
 * @param {'nfe'|'nfse'} [p.modelo] só esse modelo; sem ele, uma parte por modelo que tiver notas (NF-e se não houver nenhuma)
 * @returns {Promise<Buffer>}
 */
function montarRelatorioPdf({ cliente, competencia, notas, lerXml, modelo }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGEM, bufferPages: true, info: { Title: `Relatório ${cliente.nome} ${competencia}` } })
  const partes = []
  doc.on('data', (c) => partes.push(c))
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))))

  const largura = doc.page.width - 2 * MARGEM
  const fimDaPagina = () => doc.page.height - MARGEM - 14
  const [ano, mes] = competencia.split('-')
  const periodo = `${MESES[Number(mes) - 1] || mes} de ${ano}`
  const modelos = modelo ? [modelo] : ['nfe', 'nfse'].filter((m) => notas.some((n) => (n.modelo === 'nfse') === (m === 'nfse')))

  function cabecalho(rotuloModelo) {
    doc.font(NEGRITO).fontSize(14).fillColor('#101828').text(`Relatório de ${rotuloModelo} · ${periodo}`, MARGEM, MARGEM)
    doc.font(NORMAL).fontSize(9).fillColor('#475467').text(`${cliente.nome} · CNPJ ${documento(cliente.cnpj)}`, MARGEM, doc.y + 2)
    doc.moveDown(0.8)
  }

  // Corta o texto com "..." para caber na coluna.
  function caber(texto, w, fonte, tamanho) {
    doc.font(fonte).fontSize(tamanho)
    let s = String(texto ?? '')
    if (doc.widthOfString(s) <= w) return s
    while (s.length > 1 && doc.widthOfString(`${s}...`) > w) s = s.slice(0, -1)
    return `${s.trimEnd()}...`
  }

  function linha(colunas, larguras, valores, { fonte = NORMAL, fundo = null, altura = 15 } = {}) {
    const y = doc.y
    if (fundo) doc.save().rect(MARGEM, y, largura, altura).fill(fundo).restore()
    let x = MARGEM
    colunas.forEach((c, i) => {
      const texto = caber(valores[i], larguras[i] - 6, fonte, 7.5)
      doc.font(fonte).fontSize(7.5).fillColor('#101828').text(texto, x + 3, y + 4, { width: larguras[i] - 6, align: c.direita ? 'right' : 'left', lineBreak: false })
      x += larguras[i]
    })
    doc.save().lineWidth(0.5).moveTo(MARGEM, y + altura).lineTo(MARGEM + largura, y + altura).stroke(BORDA).restore()
    doc.x = MARGEM
    doc.y = y + altura
  }

  function secao(chave, titulo, lista) {
    const colunas = COLUNAS[chave]
    const pesoTotal = colunas.reduce((s, c) => s + c.peso, 0)
    const larguras = colunas.map((c) => (largura * c.peso) / pesoTotal)
    const titulos = colunas.map((c) => c.titulo)
    if (doc.y + 60 > fimDaPagina()) doc.addPage()
    doc.font(NEGRITO).fontSize(11).fillColor('#101828').text(`${titulo} (${lista.length})`, MARGEM, doc.y)
    doc.moveDown(0.3)
    if (!lista.length) {
      doc.font(NORMAL).fontSize(9).fillColor('#667085').text('Nenhuma nota.', MARGEM, doc.y)
      doc.moveDown(1)
      return
    }
    linha(colunas, larguras, titulos, { fonte: NEGRITO, fundo: CINZA })
    const totais = colunas.map(() => 0)
    for (const n of lista) {
      if (doc.y + 15 > fimDaPagina()) {
        doc.addPage()
        linha(colunas, larguras, titulos, { fonte: NEGRITO, fundo: CINZA })
      }
      const r = chave === 'nfse' ? retencoesDe(n, lerXml) : null
      const valores = colunas.map((c, i) => {
        const v = c.valor(n, r)
        // Cancelada não entra no total.
        if (c.soma && typeof v === 'number' && !n.cancelada) totais[i] += v
        return c.soma ? (v === null || v === undefined ? '' : dinheiro(v)) : v
      })
      linha(colunas, larguras, valores)
    }
    if (doc.y + 15 > fimDaPagina()) doc.addPage()
    linha(colunas, larguras, colunas.map((c, i) => (i === 0 ? 'Total' : c.soma ? dinheiro(totais[i]) : '')), { fonte: NEGRITO, fundo: CINZA })
    doc.moveDown(1.2)
  }

  ;(modelos.length ? modelos : ['nfe']).forEach((m, i) => {
    if (i > 0) doc.addPage()
    cabecalho(m === 'nfse' ? 'NFS-e' : 'NF-e')
    const daquele = notas.filter((n) => (n.modelo === 'nfse') === (m === 'nfse'))
    secao(m, 'Entradas', daquele.filter((n) => n.tipo !== 'saida'))
    secao(m, 'Saídas', daquele.filter((n) => n.tipo === 'saida'))
  })

  // Rodapé com a página em todas as folhas.
  const { start, count } = doc.bufferedPageRange()
  for (let p = start; p < start + count; p++) {
    doc.switchToPage(p)
    doc.page.margins.bottom = 0 // texto abaixo da margem não abre página nova
    doc.font(NORMAL).fontSize(7.5).fillColor('#667085').text(`Página ${p - start + 1} de ${count} · canceladas não entram nos totais`, MARGEM, doc.page.height - MARGEM, { width: largura, align: 'right', lineBreak: false })
  }
  doc.end()
  return pronto
}

module.exports = { montarRelatorioPdf }
