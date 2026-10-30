'use strict'

// Relatório do mês em PDF (relatorio.pdf do pacote): os mesmos dados da planilha (abas Entradas e Saídas), no formato PDF.
// Colunas e linhas vêm de planilhaMes.js, então o que estiver na planilha está aqui, sem cortar texto: célula longa quebra a linha.
// A4 paisagem; por modelo (NF-e, NFS-e) uma seção Entradas e uma Saídas, cada uma com a tabela e a linha de total
// (as canceladas não entram no total).

const PDFDocument = require('pdfkit')
const { COLUNAS_NFE, COLUNAS_NFSE, linhaNfe, linhaNfse } = require('./planilhaMes')

const MARGEM = 28
const NORMAL = 'Helvetica'
const NEGRITO = 'Helvetica-Bold'
const CINZA = '#f2f4f7'
const BORDA = '#d0d5dd'
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

// Por modelo: colunas e linha da planilha, peso da largura de cada coluna, colunas de dinheiro (somadas no total) e tamanho da letra.
const MODELOS = {
  nfe: {
    rotulo: 'NF-e',
    colunas: COLUNAS_NFE,
    linha: (n) => linhaNfe(n),
    pesos: { Número: 6, Série: 3, Emissão: 6, 'CNPJ emitente': 9.5, Emitente: 15, 'CNPJ destinatário': 9.5, Destinatário: 15, Valor: 7, Situação: 7, Cancelada: 5, Chave: 22.5 },
    dinheiro: new Set(['Valor']),
    letra: 6.5,
  },
  nfse: {
    rotulo: 'NFS-e',
    colunas: COLUNAS_NFSE,
    linha: (n, lerXml) => linhaNfse(n, lerXml),
    pesos: {
      Número: 5, Competência: 7, Emissão: 5.5, 'CNPJ prestador': 9.5, Prestador: 9.5, 'CNPJ tomador': 9.5, Tomador: 9.5, 'Valor do serviço': 6, ISS: 4.5, 'ISS retido': 4,
      IRRF: 4, CSLL: 4, INSS: 4, PIS: 4, COFINS: 4.5, 'Total retido': 5, 'Valor líquido': 6, Situação: 6, Cancelada: 5.5, Chave: 14,
    },
    dinheiro: new Set(['Valor do serviço', 'ISS', 'IRRF', 'CSLL', 'INSS', 'PIS', 'COFINS', 'Total retido', 'Valor líquido']),
    letra: 5.5,
  },
}

const dinheiro = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const data = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso || '')
function documento(d) {
  const s = String(d || '').replace(/\D/g, '')
  return s.length === 14 ? `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}` : d || ''
}

/**
 * @param {object} p
 * @param {{ cnpj: string, nome: string }} p.cliente
 * @param {string|null} p.competencia 'AAAA-MM' (null: notas de meses diferentes)
 * @param {object[]} p.notas linhas da tabela `notas`
 * @param {(nota: object) => string|null} p.lerXml XML da nota ou null
 * @param {'nfe'|'nfse'} [p.modelo] só esse modelo; sem ele, uma parte por modelo que tiver notas (NF-e se não houver nenhuma)
 * @returns {Promise<Buffer>}
 */
function montarRelatorioPdf({ cliente, competencia, notas, lerXml, modelo }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGEM, bufferPages: true, info: { Title: `Relatório ${cliente.nome} ${competencia || 'selecionadas'}` } })
  const partes = []
  doc.on('data', (c) => partes.push(c))
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))))

  const largura = doc.page.width - 2 * MARGEM
  const fimDaPagina = () => doc.page.height - MARGEM - 14
  // Notas de meses diferentes (seleção livre) não têm um mês só no título.
  const [ano, mes] = (competencia || '').split('-')
  const periodo = competencia ? `${MESES[Number(mes) - 1] || mes} de ${ano}` : 'notas selecionadas'
  const doModelo = (n, m) => (n.modelo === 'nfse') === (m === 'nfse')
  const modelos = modelo ? [modelo] : ['nfe', 'nfse'].filter((m) => notas.some((n) => doModelo(n, m)))

  function cabecalho(rotulo) {
    doc.font(NEGRITO).fontSize(14).fillColor('#101828').text(`Relatório de ${rotulo} · ${periodo}`, MARGEM, MARGEM)
    doc.font(NORMAL).fontSize(9).fillColor('#475467').text(`${cliente.nome} · CNPJ ${documento(cliente.cnpj)}`, MARGEM, doc.y + 2)
    doc.moveDown(0.8)
  }

  // Uma linha da tabela; a altura acompanha a célula com mais texto (nada é cortado).
  function linha(m, larguras, valores, { fonte = NORMAL, fundo = null } = {}) {
    doc.font(fonte).fontSize(m.letra)
    const textos = valores.map((v) => String(v ?? ''))
    const altura = Math.max(...textos.map((t, i) => doc.heightOfString(t, { width: larguras[i] - 4 }))) + 6
    if (doc.y + altura > fimDaPagina()) return false
    const y = doc.y
    if (fundo) doc.save().rect(MARGEM, y, largura, altura).fill(fundo).restore()
    let x = MARGEM
    m.colunas.forEach((titulo, i) => {
      const direita = m.dinheiro.has(titulo) // valores e títulos de dinheiro à direita
      doc.font(fonte).fontSize(m.letra).fillColor('#101828').text(textos[i], x + 2, y + 3, { width: larguras[i] - 4, align: direita ? 'right' : 'left' })
      x += larguras[i]
    })
    doc.save().lineWidth(0.5).moveTo(MARGEM, y + altura).lineTo(MARGEM + largura, y + altura).stroke(BORDA).restore()
    doc.x = MARGEM
    doc.y = y + altura
    return true
  }

  function secao(chave, titulo, lista) {
    const m = MODELOS[chave]
    const pesoTotal = m.colunas.reduce((s, c) => s + m.pesos[c], 0)
    const larguras = m.colunas.map((c) => (largura * m.pesos[c]) / pesoTotal)
    const titulos = () => linha(m, larguras, m.colunas, { fonte: NEGRITO, fundo: CINZA })
    if (doc.y + 60 > fimDaPagina()) doc.addPage()
    doc.font(NEGRITO).fontSize(11).fillColor('#101828').text(`${titulo} (${lista.length})`, MARGEM, doc.y)
    doc.moveDown(0.3)
    if (!lista.length) {
      doc.font(NORMAL).fontSize(9).fillColor('#667085').text('Nenhuma nota.', MARGEM, doc.y)
      doc.moveDown(1)
      return
    }
    titulos()
    const totais = m.colunas.map(() => 0)
    for (const n of lista) {
      const crua = m.linha(n, lerXml)
      const valores = crua.map((v, i) => {
        const coluna = m.colunas[i]
        if (m.dinheiro.has(coluna)) {
          if (typeof v === 'number' && !n.cancelada) totais[i] += v
          return v === '' || v === null || v === undefined ? '' : dinheiro(v)
        }
        return coluna === 'Emissão' ? data(v) : v
      })
      if (!linha(m, larguras, valores)) {
        doc.addPage()
        titulos()
        linha(m, larguras, valores)
      }
    }
    const total = m.colunas.map((c, i) => (i === 0 ? 'Total' : m.dinheiro.has(c) ? dinheiro(totais[i]) : ''))
    if (!linha(m, larguras, total, { fonte: NEGRITO, fundo: CINZA })) {
      doc.addPage()
      linha(m, larguras, total, { fonte: NEGRITO, fundo: CINZA })
    }
    doc.moveDown(1.2)
  }

  ;(modelos.length ? modelos : ['nfe']).forEach((m, i) => {
    if (i > 0) doc.addPage()
    cabecalho(MODELOS[m].rotulo)
    const daquele = notas.filter((n) => doModelo(n, m))
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
