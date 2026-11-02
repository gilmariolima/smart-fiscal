'use strict'

// DACTE (PDF do CT-e) retrato a partir do XML, no leiaute do Manual de Orientação do CT-e 4.00:
// emitente + quadro DACTE + chave com código de barras, tipo/serviço/CFOP, partes, carga, componentes do valor,
// ICMS, documentos originários (continuam nas folhas seguintes) e observações com dados do modal rodoviário.
// CT-e cancelado leva a marca d'água CANCELADO; homologação, SEM VALOR FISCAL.

const PDFDocument = require('pdfkit')
const { dadosCte } = require('../extracaoCte')
const { barrasC } = require('../danfe/code128')

const M = 14 // margem
const NORMAL = 'Helvetica'
const NEGRITO = 'Helvetica-Bold'
const H = 20 // altura de uma linha de campos

const dinheiro = (v) => (v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const numero = (v, casas) => (v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }))
const data = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
const hora = (iso) => (/T\d{2}:\d{2}:\d{2}/.test(iso || '') ? iso.slice(11, 19) : '')
function documento(d) {
  const s = String(d || '').replace(/\D/g, '')
  if (s.length === 14) return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`
  if (s.length === 11) return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
  return d || ''
}
const cep = (c) => (/^\d{8}$/.test(c || '') ? `${c.slice(0, 5)}-${c.slice(5)}` : c || '')
const numeroCt = (n) => String(n || '').padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3')
const chaveEmGrupos = (c) => String(c || '').replace(/(\d{4})(?=\d)/g, '$1 ')
const juntar = (...partes) => partes.filter(Boolean).join(', ')

const MODAIS = { '01': 'Rodoviário', '02': 'Aéreo', '03': 'Aquaviário', '04': 'Ferroviário', '05': 'Dutoviário', '06': 'Multimodal' }
const TIPOS_CTE = { 0: 'Normal', 1: 'Complemento de valores', 2: 'Anulação', 3: 'Substituto' }
const TIPOS_SERVICO = { 0: 'Normal', 1: 'Subcontratação', 2: 'Redespacho', 3: 'Redespacho intermediário', 4: 'Serviço vinculado a multimodal' }
const UNIDADES = { '00': 'M3', '01': 'KG', '02': 'TON', '03': 'UN', '04': 'L', '05': 'MMBTU' }

/**
 * @param {string} xml XML do CT-e (cteProc ou CTe)
 * @param {{ situacao?: 'autorizado'|'cancelado' }} [opcoes]
 * @returns {Promise<Buffer>}
 */
function gerarDacte(xml, { situacao = 'autorizado' } = {}) {
  let d
  try {
    d = dadosCte(xml)
  } catch {
    return Promise.reject(new Error('Não é possível gerar o DACTE: o XML não é um CT-e.'))
  }
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `DACTE ${d.numero || ''}`, Subject: d.chave || '' } })
  const partes = []
  doc.on('data', (c) => partes.push(c))
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))))

  const W = doc.page.width - 2 * M
  const fimDaPagina = doc.page.height - M
  const emit = d.emitente || {}
  const e = emit.endereco || {}
  const folhas = [] // onde escrever "x/y" no fim

  function caber(texto, largura, fonte, tamanho) {
    doc.font(fonte).fontSize(tamanho)
    let s = String(texto ?? '')
    if (doc.widthOfString(s) <= largura) return s
    while (s.length > 1 && doc.widthOfString(`${s}...`) > largura) s = s.slice(0, -1)
    return `${s.trimEnd()}...`
  }
  const caixa = (x, y, w, h) => doc.save().lineWidth(0.5).rect(x, y, w, h).stroke('#000').restore()
  const escrever = (texto, x, y, w, { fonte = NORMAL, tamanho = 7, alinhar = 'left' } = {}) =>
    doc.fillColor('#000').font(fonte).fontSize(tamanho).text(caber(texto, w - 4, fonte, tamanho), x + 2, y, { width: w - 4, align: alinhar, lineBreak: false })

  // Campo: caixa com o rótulo (5 pt) em cima e o valor (7,5 pt) embaixo.
  function campo(x, y, w, rotulo, valor, { h = H, alinhar = 'left', negrito = false, tamanho = 7.5 } = {}) {
    caixa(x, y, w, h)
    escrever(rotulo, x, y + 1.5, w, { tamanho: 5 })
    escrever(valor ?? '', x, y + h - tamanho - 3, w, { fonte: negrito ? NEGRITO : NORMAL, tamanho, alinhar })
  }
  // Linha de campos com larguras fixas; a última (largura null) fica com o resto.
  function linha(y, campos, h = H) {
    const fixas = campos.reduce((s, c) => s + (c[2] || 0), 0)
    let x = M
    for (const [rotulo, valor, largura, op] of campos) {
      const w = largura || W - fixas
      campo(x, y, w, rotulo, valor, { h, ...op })
      x += w
    }
    return y + h
  }
  // Grade de campos de mesma largura (n por linha) que quebra em várias linhas.
  function grade(y, itens, porLinha, opcoes = {}) {
    const w = W / porLinha
    for (let i = 0; i < itens.length; i += porLinha) {
      itens.slice(i, i + porLinha).forEach(([rotulo, valor], j) => campo(M + j * w, y, w, rotulo, valor, opcoes))
      y += H
    }
    return y
  }
  const titulo = (y, texto) => {
    doc.fillColor('#000').font(NEGRITO).fontSize(6).text(texto, M, y + 2, { lineBreak: false })
    return y + 9
  }

  // Emitente, quadro DACTE e chave de acesso (repete em todas as folhas).
  function cabecalho(y) {
    const wEmit = 200
    const wDacte = 150
    const xChave = M + wEmit + wDacte
    const wChave = W - wEmit - wDacte
    const h = 84
    caixa(M, y, wEmit, h)
    escrever('IDENTIFICAÇÃO DO EMITENTE', M, y + 2, wEmit, { tamanho: 5 })
    doc.fillColor('#000').font(NEGRITO).fontSize(9).text(emit.nome || '', M + 4, y + 12, { width: wEmit - 8, align: 'center', height: 24, ellipsis: true })
    const endereco = [juntar(e.logradouro, e.numero), [e.bairro, cep(e.cep)].filter(Boolean).join(' - '), [e.municipio, e.uf].filter(Boolean).join(' - '), `CNPJ/CPF: ${documento(emit.documento)}  IE: ${emit.ie || ''}`, e.telefone ? `Fone: ${e.telefone}` : '']
    doc.font(NORMAL).fontSize(7).text(endereco.filter(Boolean).join('\n'), M + 4, y + 38, { width: wEmit - 8, align: 'center', height: 44, ellipsis: true })

    // Quadro DACTE: título, depois modal/modelo/série/número e folha/emissão.
    caixa(M + wEmit, y, wDacte, h)
    escrever('DACTE', M + wEmit, y + 3, wDacte, { fonte: NEGRITO, tamanho: 12, alinhar: 'center' })
    doc.font(NORMAL).fontSize(6).text('Documento Auxiliar do Conhecimento de Transporte Eletrônico', M + wEmit + 4, y + 17, { width: wDacte - 8, align: 'center' })
    const xq = M + wEmit
    campo(xq, y + 40, 52, 'MODAL', MODAIS[d.modal] || d.modal, { tamanho: 6.5 })
    campo(xq + 52, y + 40, 28, 'MODELO', d.modelo || '57', { alinhar: 'center' })
    campo(xq + 80, y + 40, 24, 'SÉRIE', d.serie, { alinhar: 'center' })
    campo(xq + 104, y + 40, wDacte - 104, 'NÚMERO', numeroCt(d.numero), { alinhar: 'center', tamanho: 7 })
    campo(xq, y + 60, 52, 'FOLHA', '', { h: h - 60, alinhar: 'center' })
    folhas.push({ pagina: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1, x: xq, y: y + h - 11, w: 52 })
    campo(xq + 52, y + 60, wDacte - 52, 'DATA E HORA DA EMISSÃO', `${data(d.dataEmissao)} ${hora(d.dataEmissao)}`, { h: h - 60, alinhar: 'center', tamanho: 7 })

    // Código de barras da chave, a chave em grupos de 4 e o protocolo.
    caixa(xChave, y, wChave, 34)
    const barras = barrasC(d.chave)
    if (barras) {
      const escala = (wChave - 16) / barras.largura
      doc.save().fillColor('#000')
      for (const b of barras.barras) doc.rect(xChave + 8 + b.x * escala, y + 4, b.largura * escala, 26).fill()
      doc.restore()
    }
    campo(xChave, y + 34, wChave, 'CHAVE DE ACESSO', chaveEmGrupos(d.chave), { alinhar: 'center', negrito: true, tamanho: 6.5 })
    caixa(xChave, y + 54, wChave, h - 54)
    doc.font(NORMAL).fontSize(6).fillColor('#000').text('Consulta de autenticidade no portal nacional do CT-e www.cte.fazenda.gov.br/portal ou no site da Sefaz Autorizadora', xChave + 4, y + 57, { width: wChave - 8, align: 'center' })
    y += h
    const protocolo = d.protocolo ? `${d.protocolo.numero || ''} - ${data(d.protocolo.data)} ${hora(d.protocolo.data)}` : ''
    return linha(y, [['PROTOCOLO DE AUTORIZAÇÃO DE USO', protocolo, null, { alinhar: 'center' }]])
  }

  function natureza(y) {
    y = linha(y, [['TIPO DO CT-E', TIPOS_CTE[d.tipoCte] ?? d.tipoCte, 150], ['TIPO DO SERVIÇO', TIPOS_SERVICO[d.tipoServico] ?? d.tipoServico, 150], ['CFOP', d.cfop, 50], ['NATUREZA DA OPERAÇÃO', d.natureza, null]])
    const origem = [d.origem.municipio, d.origem.uf].filter(Boolean).join(' - ')
    const destino = [d.destino.municipio, d.destino.uf].filter(Boolean).join(' - ')
    return linha(y, [['INÍCIO DA PRESTAÇÃO', origem, W / 2], ['TÉRMINO DA PRESTAÇÃO', destino, null]])
  }

  // Parte (remetente, destinatário...): rótulo + nome, endereço, município, documentos e fone.
  function parte(x, y, w, rotulo, p, h) {
    caixa(x, y, w, h)
    escrever(rotulo, x, y + 1.5, w, { fonte: NEGRITO, tamanho: 5.5 })
    if (!p) return
    const en = p.endereco || {}
    const linhas = [
      [p.nome, NEGRITO],
      [juntar(en.logradouro, en.numero), NORMAL],
      [[en.bairro, [en.municipio, en.uf].filter(Boolean).join(' - '), cep(en.cep)].filter(Boolean).join(' · '), NORMAL],
      [`CNPJ/CPF: ${documento(p.documento)}   IE: ${p.ie || ''}`, NORMAL],
      [en.telefone ? `Fone: ${en.telefone}` : '', NORMAL],
    ]
    linhas.forEach(([t, f], i) => escrever(t, x, y + 9 + i * 8, w, { fonte: f, tamanho: 6.5 }))
  }
  function partes2(y, a, b) {
    const w = W / 2
    parte(M, y, w, a[0], a[1], 50)
    parte(M + w, y, W - w, b[0], b[1], 50)
    return y + 50
  }
  function participantes(y) {
    y = partes2(y, ['REMETENTE', d.remetente], ['DESTINATÁRIO', d.destinatario])
    if (d.expedidor || d.recebedor) y = partes2(y, ['EXPEDIDOR', d.expedidor], ['RECEBEDOR', d.recebedor])
    parte(M, y, W, 'TOMADOR DO SERVIÇO', d.tomador, 50)
    return y + 50
  }

  function carga(y) {
    y = titulo(y, 'INFORMAÇÕES DA CARGA')
    y = linha(y, [['PRODUTO PREDOMINANTE', d.carga.produto, 230], ['OUTRAS CARACTERÍSTICAS DA CARGA', d.carga.outras, 200], ['VALOR TOTAL DA CARGA', dinheiro(d.carga.valor), null, { alinhar: 'right', negrito: true }]])
    const qs = d.carga.quantidades.map((q) => [`${q.tipo || 'QUANTIDADE'} (${UNIDADES[q.unidade] || q.unidade || ''})`.toUpperCase(), numero(q.quantidade, 4)])
    return qs.length ? grade(y, qs, 4, { alinhar: 'right' }) : y
  }

  function componentes(y) {
    y = titulo(y, 'COMPONENTES DO VALOR DA PRESTAÇÃO DE SERVIÇO')
    if (d.componentes.length) y = grade(y, d.componentes.map((c) => [c.nome, dinheiro(c.valor)]), 4, { alinhar: 'right' })
    return linha(y, [['VALOR TOTAL DO SERVIÇO', dinheiro(d.valorPrestacao), W / 2, { alinhar: 'right', negrito: true }], ['VALOR A RECEBER', dinheiro(d.valorReceber), null, { alinhar: 'right', negrito: true }]])
  }

  function icms(y) {
    y = titulo(y, 'INFORMAÇÕES RELATIVAS AO IMPOSTO')
    const w5 = W / 5
    return linha(y, [['SITUAÇÃO TRIBUTÁRIA (CST)', d.icms.cst, w5, { alinhar: 'center' }], ['BASE DE CÁLCULO', dinheiro(d.icms.base), w5, { alinhar: 'right' }], ['ALÍQ. ICMS', numero(d.icms.aliquota, 2), w5, { alinhar: 'right' }], ['VALOR DO ICMS', dinheiro(d.icms.valor), w5, { alinhar: 'right' }], ['% RED. BC ICMS', '', null, { alinhar: 'right' }]])
  }

  // Documentos originários em 3 colunas; devolve o índice do próximo que não coube.
  const COLS = 3
  const LIN = 9
  function documentos(y, limite, inicio) {
    y = titulo(y, 'DOCUMENTOS ORIGINÁRIOS')
    const topo = y
    caixa(M, topo, W, limite - topo)
    const w = W / COLS
    for (let c = 1; c < COLS; c++) doc.save().lineWidth(0.5).moveTo(M + c * w, topo).lineTo(M + c * w, limite).stroke('#000').restore()
    const porColuna = Math.max(1, Math.floor((limite - topo - 4) / LIN))
    const fim = Math.min(d.documentos.length, inicio + porColuna * COLS)
    for (let i = inicio; i < fim; i++) {
      const dc = d.documentos[i]
      const k = i - inicio
      const texto = dc.tipo === 'nfe' ? `NF-e ${dc.chave || ''}` : dc.tipo === 'cte' ? `CT-e ${dc.chave || ''}` : dc.tipo === 'nf' ? `NF ${dc.numero || ''}` : `Outro ${dc.numero || ''}`
      escrever(texto, M + Math.floor(k / porColuna) * w, topo + 2 + (k % porColuna) * LIN, w, { tamanho: 6 })
    }
    return fim
  }

  function observacoes(y) {
    y = titulo(y, 'OBSERVAÇÕES')
    const h = fimDaPagina - y
    const wRod = 150
    caixa(M, y, W - wRod, h)
    escrever('OBSERVAÇÕES', M, y + 1.5, W - wRod, { tamanho: 5 })
    doc.font(NORMAL).fontSize(6).fillColor('#000').text(d.observacoes || '', M + 2, y + 9, { width: W - wRod - 4, height: h - 11, ellipsis: true })
    caixa(M + W - wRod, y, wRod, h)
    const nomeModal = (MODAIS[d.modal] || 'Rodoviário').toUpperCase()
    escrever(`DADOS ESPECÍFICOS DO MODAL ${nomeModal}`, M + W - wRod, y + 1.5, wRod, { tamanho: 5 })
    const aq = d.aquaviario
    const dadosModal = aq
      ? [aq.navio && `Navio: ${aq.navio}`, aq.viagem && `Viagem: ${aq.viagem}`, aq.conteineres.length && `Contêiner: ${aq.conteineres.join(', ')}`]
      : [d.rntrc && `RNTRC: ${d.rntrc}`]
    dadosModal.filter(Boolean).forEach((t, i) => escrever(t, M + W - wRod, y + 11 + i * 9, wRod, { tamanho: 7 }))
  }

  function marcaDagua() {
    const texto = situacao === 'cancelado' ? 'CANCELADO' : d.ambiente === 'homologacao' ? 'SEM VALOR FISCAL' : null
    if (!texto) return
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor('#d92d20').fillOpacity(0.18).font(NEGRITO).fontSize(80)
    doc.text(texto, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
    doc.restore()
  }

  // Folha 1: tudo; os documentos vão até o bloco de observações (altura fixa no pé da folha).
  let y = cabecalho(M)
  y = natureza(y)
  y = participantes(y)
  y = carga(y)
  y = componentes(y)
  y = icms(y)
  const alturaObs = 70
  let proximo = documentos(y, fimDaPagina - alturaObs - 9, 0)
  observacoes(fimDaPagina - alturaObs - 9)
  marcaDagua()
  // Folhas seguintes: cabeçalho e a continuação dos documentos.
  while (proximo < d.documentos.length) {
    doc.addPage({ size: 'A4', margin: 0 })
    proximo = documentos(cabecalho(M), fimDaPagina, proximo)
    marcaDagua()
  }

  const total = doc.bufferedPageRange().count
  for (const f of folhas) {
    doc.switchToPage(f.pagina)
    escrever(`${f.pagina + 1}/${total}`, f.x, f.y, f.w, { fonte: NEGRITO, tamanho: 7.5, alinhar: 'center' })
  }
  doc.end()
  return pronto
}

module.exports = { gerarDacte }
