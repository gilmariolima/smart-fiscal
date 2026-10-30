'use strict'

// DANFE (PDF da NF-e) retrato a partir do XML, no leiaute usual do Manual de Orientação do Contribuinte:
// canhoto, emitente + quadro DANFE + chave com código de barras, natureza/protocolo, destinatário, fatura,
// cálculo do imposto, transportador, produtos (continuam nas folhas seguintes) e dados adicionais.
// Nota cancelada leva a marca d'água CANCELADA; homologação, SEM VALOR FISCAL.

const PDFDocument = require('pdfkit')
const { detalharNfe } = require('../detalheNota')
const { barrasC } = require('./code128')

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
const numeroNf = (n) => String(n || '').padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3')
const chaveEmGrupos = (c) => String(c || '').replace(/(\d{4})(?=\d)/g, '$1 ')
const juntar = (...partes) => partes.filter(Boolean).join(', ')

/**
 * @param {string} xml XML da NF-e (nfeProc ou NFe)
 * @param {{ situacao?: 'autorizada'|'cancelada' }} [opcoes]
 * @returns {Promise<Buffer>}
 */
function gerarDanfe(xml, { situacao = 'autorizada' } = {}) {
  const d = detalharNfe(xml)
  if (!d) return Promise.reject(new Error('Não é possível gerar o DANFE: o XML não é uma NF-e.'))
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `DANFE ${d.ide.numero || ''}`, Subject: d.ide.chave || '' } })
  const partes = []
  doc.on('data', (c) => partes.push(c))
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))))

  const W = doc.page.width - 2 * M
  const fimDaPagina = doc.page.height - M
  const emit = d.emitente || {}
  const dest = d.destinatario || {}
  const e = emit.endereco || {}
  const de = dest.endereco || {}
  const folhas = [] // onde escrever "FOLHA x/y" no fim

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
  const titulo = (y, texto) => {
    doc.fillColor('#000').font(NEGRITO).fontSize(6).text(texto, M, y + 2, { lineBreak: false })
    return y + 9
  }

  function canhoto(y) {
    const direita = 100
    caixa(M, y, W - direita, 16)
    escrever(`RECEBEMOS DE ${emit.nome || ''} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO`, M, y + 5, W - direita, { tamanho: 5.5 })
    campo(M, y + 16, 100, 'DATA DE RECEBIMENTO', '', { h: 18 })
    campo(M + 100, y + 16, W - direita - 100, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR', '', { h: 18 })
    caixa(M + W - direita, y, direita, 34)
    escrever('NF-e', M + W - direita, y + 3, direita, { fonte: NEGRITO, tamanho: 11, alinhar: 'center' })
    escrever(`Nº ${numeroNf(d.ide.numero)}`, M + W - direita, y + 17, direita, { fonte: NEGRITO, tamanho: 7.5, alinhar: 'center' })
    escrever(`SÉRIE ${String(d.ide.serie || '').padStart(3, '0')}`, M + W - direita, y + 26, direita, { tamanho: 7, alinhar: 'center' })
    doc.save().lineWidth(0.5).dash(3, { space: 2 }).moveTo(M, y + 39).lineTo(M + W, y + 39).stroke('#000').undash().restore()
    return y + 44
  }

  // Emitente, quadro DANFE e chave de acesso (repete em todas as folhas).
  function cabecalho(y) {
    const wEmit = 235
    const wDanfe = 92
    const xChave = M + wEmit + wDanfe
    const wChave = W - wEmit - wDanfe
    const h = 84
    caixa(M, y, wEmit, h)
    escrever('IDENTIFICAÇÃO DO EMITENTE', M, y + 2, wEmit, { tamanho: 5 })
    doc.fillColor('#000').font(NEGRITO).fontSize(9).text(emit.nome || '', M + 4, y + 12, { width: wEmit - 8, align: 'center', height: 24, ellipsis: true })
    const endereco = [juntar(e.logradouro, e.numero, e.complemento), [e.bairro, cep(e.cep)].filter(Boolean).join(' - '), [e.municipio, e.uf].filter(Boolean).join(' - '), e.telefone ? `Fone: ${e.telefone}` : '']
    doc.font(NORMAL).fontSize(7).text(endereco.filter(Boolean).join('\n'), M + 4, y + 40, { width: wEmit - 8, align: 'center', height: 42, ellipsis: true })

    caixa(M + wEmit, y, wDanfe, h)
    escrever('DANFE', M + wEmit, y + 4, wDanfe, { fonte: NEGRITO, tamanho: 12, alinhar: 'center' })
    doc.font(NORMAL).fontSize(6).text('Documento Auxiliar da Nota Fiscal Eletrônica', M + wEmit + 4, y + 18, { width: wDanfe - 8, align: 'center' })
    escrever('0 - ENTRADA', M + wEmit + 4, y + 36, 60, { tamanho: 6 })
    escrever('1 - SAÍDA', M + wEmit + 4, y + 43, 60, { tamanho: 6 })
    caixa(M + wEmit + wDanfe - 24, y + 35, 14, 14)
    escrever(d.ide.tipo === 'entrada' ? '0' : '1', M + wEmit + wDanfe - 24, y + 38, 14, { fonte: NEGRITO, tamanho: 9, alinhar: 'center' })
    escrever(`Nº ${numeroNf(d.ide.numero)}`, M + wEmit, y + 55, wDanfe, { fonte: NEGRITO, tamanho: 7.5, alinhar: 'center' })
    escrever(`SÉRIE ${String(d.ide.serie || '').padStart(3, '0')}`, M + wEmit, y + 64, wDanfe, { fonte: NEGRITO, tamanho: 7.5, alinhar: 'center' })
    folhas.push({ pagina: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1, x: M + wEmit, y: y + 73, w: wDanfe })

    // Código de barras da chave, a chave em grupos de 4 e o texto da consulta.
    caixa(xChave, y, wChave, 34)
    const barras = barrasC(d.ide.chave)
    if (barras) {
      const escala = (wChave - 16) / barras.largura
      doc.save().fillColor('#000')
      for (const b of barras.barras) doc.rect(xChave + 8 + b.x * escala, y + 4, b.largura * escala, 26).fill()
      doc.restore()
    }
    campo(xChave, y + 34, wChave, 'CHAVE DE ACESSO', chaveEmGrupos(d.ide.chave), { alinhar: 'center', negrito: true, tamanho: 7.5 })
    caixa(xChave, y + 54, wChave, h - 54)
    doc.font(NORMAL).fontSize(7).fillColor('#000').text('Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora', xChave + 4, y + 58, { width: wChave - 8, align: 'center' })
    y += h

    const protocolo = d.protocolo ? `${d.protocolo.numero || ''} - ${data(d.protocolo.data)} ${hora(d.protocolo.data)}` : ''
    y = linha(y, [['NATUREZA DA OPERAÇÃO', d.ide.naturezaOperacao, wEmit + wDanfe], ['PROTOCOLO DE AUTORIZAÇÃO DE USO', protocolo, null, { alinhar: 'center' }]])
    return linha(y, [['INSCRIÇÃO ESTADUAL', emit.ie, 190], ['INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.', '', 190], ['CNPJ / CPF', documento(emit.documento), null]])
  }

  function destinatario(y) {
    y = titulo(y, 'DESTINATÁRIO / REMETENTE')
    y = linha(y, [['NOME / RAZÃO SOCIAL', dest.nome, W - 210], ['CNPJ / CPF', documento(dest.documento), 110], ['DATA DA EMISSÃO', data(d.ide.dataEmissao), null, { alinhar: 'center' }]])
    y = linha(y, [['ENDEREÇO', juntar(de.logradouro, de.numero, de.complemento), W - 310], ['BAIRRO / DISTRITO', de.bairro, 140], ['CEP', cep(de.cep), 70], ['DATA DA SAÍDA/ENTRADA', data(d.ide.dataSaida), null, { alinhar: 'center' }]])
    return linha(y, [['MUNICÍPIO', de.municipio, W - 340], ['FONE / FAX', de.telefone, 100], ['UF', de.uf, 30], ['INSCRIÇÃO ESTADUAL', dest.ie, 110], ['HORA DA SAÍDA/ENTRADA', hora(d.ide.dataSaida), null, { alinhar: 'center' }]])
  }

  function fatura(y) {
    const dups = d.cobranca.duplicatas
    const fat = d.cobranca.fatura
    if (!dups.length && !fat) return y
    y = titulo(y, 'FATURA / DUPLICATAS')
    if (!dups.length) return linha(y, [['FATURA', `Nº ${fat.numero || ''}  ·  Valor original ${dinheiro(fat.valorOriginal)}  ·  Desconto ${dinheiro(fat.desconto)}  ·  Valor líquido ${dinheiro(fat.valorLiquido)}`, null]])
    const porLinha = 6
    const w = W / porLinha
    for (let i = 0; i < dups.length; i += porLinha) {
      dups.slice(i, i + porLinha).forEach((dp, j) => {
        const x = M + j * w
        caixa(x, y, w, 26)
        escrever(`Nº ${dp.numero || ''}`, x, y + 2, w, { tamanho: 6.5 })
        escrever(`Venc. ${data(dp.vencimento)}`, x, y + 10, w, { tamanho: 6.5 })
        escrever(`Valor ${dinheiro(dp.valor)}`, x, y + 18, w, { fonte: NEGRITO, tamanho: 6.5 })
      })
      y += 26
    }
    return y
  }

  function impostos(y) {
    const t = d.totais
    y = titulo(y, 'CÁLCULO DO IMPOSTO')
    const w5 = W / 5
    y = linha(y, [['BASE DE CÁLC. DO ICMS', dinheiro(t.baseIcms), w5, { alinhar: 'right' }], ['VALOR DO ICMS', dinheiro(t.icms), w5, { alinhar: 'right' }], ['BASE DE CÁLC. ICMS S.T.', dinheiro(t.baseSt), w5, { alinhar: 'right' }], ['VALOR DO ICMS SUBST.', dinheiro(t.st), w5, { alinhar: 'right' }], ['V. TOTAL PRODUTOS', dinheiro(t.produtos), null, { alinhar: 'right' }]])
    const w6 = W / 6
    return linha(y, [['VALOR DO FRETE', dinheiro(t.frete), w6, { alinhar: 'right' }], ['VALOR DO SEGURO', dinheiro(t.seguro), w6, { alinhar: 'right' }], ['DESCONTO', dinheiro(t.desconto), w6, { alinhar: 'right' }], ['OUTRAS DESPESAS', dinheiro(t.outras), w6, { alinhar: 'right' }], ['VALOR TOTAL IPI', dinheiro(t.ipi), w6, { alinhar: 'right' }], ['V. TOTAL DA NOTA', dinheiro(t.total), null, { alinhar: 'right', negrito: true }]])
  }

  function transportador(y) {
    const tr = d.transporte
    const ta = tr.transportadora || {}
    const vols = tr.volumes || []
    const soma = (c) => (vols.some((v) => v[c] !== null) ? vols.reduce((s, v) => s + (v[c] || 0), 0) : null)
    y = titulo(y, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS')
    y = linha(y, [['NOME / RAZÃO SOCIAL', ta.nome, 200], ['FRETE POR CONTA', tr.modalidade, 110], ['CÓDIGO ANTT', '', 55], ['PLACA DO VEÍCULO', tr.veiculo?.placa, 60], ['UF', tr.veiculo?.uf, 25], ['CNPJ / CPF', documento(ta.documento), null]])
    y = linha(y, [['ENDEREÇO', ta.endereco, 250], ['MUNICÍPIO', ta.municipio, 150], ['UF', ta.uf, 25], ['INSCRIÇÃO ESTADUAL', ta.ie, null]])
    const w6 = W / 6
    return linha(y, [['QUANTIDADE', numero(soma('quantidade'), 0), w6, { alinhar: 'right' }], ['ESPÉCIE', vols[0]?.especie, w6], ['MARCA', vols[0]?.marca, w6], ['NUMERAÇÃO', vols[0]?.numeracao, w6], ['PESO BRUTO', numero(soma('pesoBruto'), 3), w6, { alinhar: 'right' }], ['PESO LÍQUIDO', numero(soma('pesoLiquido'), 3), null, { alinhar: 'right' }]])
  }

  // Tabela de produtos: colunas fixas e a descrição com o que sobra (quebra linha).
  const COLUNAS = [
    ['CÓDIGO', 46, (i) => i.codigo],
    ['DESCRIÇÃO DO PRODUTO / SERVIÇO', null, (i) => i.descricao],
    ['NCM/SH', 38, (i) => i.ncm],
    ['O/CST', 24, (i) => i.cst],
    ['CFOP', 24, (i) => i.cfop],
    ['UN', 20, (i) => i.unidade],
    ['QUANT.', 40, (i) => numero(i.quantidade, 4), true],
    ['VALOR UNIT.', 42, (i) => numero(i.valorUnitario, 4), true],
    ['VALOR TOTAL', 44, (i) => dinheiro(i.valorTotal), true],
    ['B.CÁLC ICMS', 40, (i) => dinheiro(i.baseIcms), true],
    ['VALOR ICMS', 36, (i) => dinheiro(i.valorIcms), true],
    ['VALOR IPI', 32, (i) => dinheiro(i.valorIpi), true],
    ['ALÍQ. ICMS', 24, (i) => numero(i.aliquotaIcms, 2), true],
    ['ALÍQ. IPI', 22, (i) => numero(i.aliquotaIpi, 2), true],
  ]
  const fixas = COLUNAS.reduce((s, c) => s + (c[1] || 0), 0)
  const larguras = COLUNAS.map((c) => c[1] || W - fixas)

  // Escreve itens a partir de `inicio` até `limite`; devolve o índice do próximo item que não coube.
  function produtos(y, limite, inicio) {
    y = titulo(y, 'DADOS DOS PRODUTOS / SERVIÇOS')
    const topo = y
    let x = M
    COLUNAS.forEach(([rotulo], i) => {
      doc.font(NEGRITO).fontSize(5).fillColor('#000').text(rotulo, x + 1.5, y + 2, { width: larguras[i] - 3, align: 'center' })
      x += larguras[i]
    })
    y += 14
    doc.save().lineWidth(0.5).moveTo(M, y).lineTo(M + W, y).stroke('#000').restore()
    let i = inicio
    for (; i < d.itens.length; i++) {
      const item = d.itens[i]
      doc.font(NORMAL).fontSize(6)
      const altura = doc.heightOfString(item.descricao || '', { width: larguras[1] - 3 }) + 4
      if (y + altura > limite && i > inicio) break // o primeiro da folha sempre entra (evita laço sem fim)
      let cx = M
      COLUNAS.forEach(([, , valor, direita], c) => {
        const texto = String(valor(item) ?? '')
        if (c === 1) doc.font(NORMAL).fontSize(6).text(texto, cx + 1.5, y + 2, { width: larguras[c] - 3 })
        else escrever(texto, cx, y + 2, larguras[c], { tamanho: 6, alinhar: direita ? 'right' : 'center' })
        cx += larguras[c]
      })
      y += altura
    }
    // Moldura e linhas verticais até o fim da área (a tabela ocupa o espaço reservado).
    caixa(M, topo, W, limite - topo)
    let vx = M
    for (const w of larguras.slice(0, -1)) {
      vx += w
      doc.save().lineWidth(0.5).moveTo(vx, topo).lineTo(vx, limite).stroke('#000').restore()
    }
    return i
  }

  function dadosAdicionais(y) {
    y = titulo(y, 'DADOS ADICIONAIS')
    const h = fimDaPagina - y
    const wInfo = 380
    caixa(M, y, wInfo, h)
    escrever('INFORMAÇÕES COMPLEMENTARES', M, y + 1.5, wInfo, { tamanho: 5 })
    doc.font(NORMAL).fontSize(6).fillColor('#000').text(d.informacoes.complementar || '', M + 2, y + 9, { width: wInfo - 4, height: h - 11, ellipsis: true })
    caixa(M + wInfo, y, W - wInfo, h)
    escrever('RESERVADO AO FISCO', M + wInfo, y + 1.5, W - wInfo, { tamanho: 5 })
    doc.font(NORMAL).fontSize(6).text(d.informacoes.fisco || '', M + wInfo + 2, y + 9, { width: W - wInfo - 4, height: h - 11, ellipsis: true })
  }

  function marcaDagua() {
    const texto = situacao === 'cancelada' ? 'CANCELADA' : d.ide.ambiente === 'homologacao' ? 'SEM VALOR FISCAL' : null
    if (!texto) return
    doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor('#d92d20').fillOpacity(0.18).font(NEGRITO).fontSize(80)
    doc.text(texto, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false })
    doc.restore()
  }

  // Folha 1: tudo; os produtos vão até o bloco de dados adicionais (altura fixa no pé da folha).
  let y = canhoto(M)
  y = cabecalho(y)
  y = destinatario(y)
  y = fatura(y)
  y = impostos(y)
  y = transportador(y)
  const alturaAdicionais = 80
  let proximo = produtos(y, fimDaPagina - alturaAdicionais - 9, 0)
  dadosAdicionais(fimDaPagina - alturaAdicionais - 9)
  marcaDagua()
  // Folhas seguintes: cabeçalho e a continuação dos produtos.
  while (proximo < d.itens.length) {
    doc.addPage({ size: 'A4', margin: 0 })
    proximo = produtos(cabecalho(M), fimDaPagina, proximo)
    marcaDagua()
  }

  const total = doc.bufferedPageRange().count
  for (const f of folhas) {
    doc.switchToPage(f.pagina)
    escrever(`FOLHA ${f.pagina + 1}/${total}`, f.x, f.y, f.w, { fonte: NEGRITO, tamanho: 7, alinhar: 'center' })
  }
  doc.end()
  return pronto
}

module.exports = { gerarDanfe }
