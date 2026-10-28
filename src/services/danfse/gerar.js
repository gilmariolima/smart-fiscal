'use strict'

// Desenha o DANFSe (NT 008/2026 v1.02, Anexo I) a partir do XML da NFS-e: A4 retrato, uma página,
// grade de 4 colunas de 5,09 cm, títulos de bloco sombreados (cinza 5%), rótulos 6 pt em negrito,
// conteúdo 7 pt, QR Code da consulta pública e marca d'água de cancelada/substituída.
// Fontes: Helvetica (equivalente métrico da Arial) no lugar de Arial/Microsoft Sans Serif.
// O canhoto (opcional) não é impresso; o espaço vai para "Informações Complementares" (item 2.3.3).

const path = require('node:path')
const PDFDocument = require('pdfkit')
const QRCode = require('qrcode')
const { dadosDanfse, VAZIO } = require('./dados')

const CM = 72 / 2.54
const LOGO = path.join(__dirname, 'logo-nfse.png')
const X = [0.3, 5.41, 10.51, 15.62] // colunas (cm)
const DIREITA = 20.7
const FIM_PAGINA = 29.4
const LINHA = 0.64 // altura de uma linha de campos (cm)
const CINZA = '#f2f2f2' // 5% de densidade
const NORMAL = 'Helvetica'
const NEGRITO = 'Helvetica-Bold'

const largura = (col, span = 1) => (col + span >= X.length ? DIREITA : X[col + span]) - X[col]

function caber(doc, texto, larguraPt, fonte, tamanho) {
  doc.font(fonte).fontSize(tamanho)
  let s = String(texto ?? VAZIO)
  if (doc.widthOfString(s) <= larguraPt) return s
  while (s.length > 1 && doc.widthOfString(`${s}...`) > larguraPt) s = s.slice(0, -1)
  return `${s.trimEnd()}...`
}

/**
 * @param {string} xml XML da NFS-e
 * @param {{ situacao?: 'autorizada'|'cancelada'|'substituida', comprimir?: boolean }} [opcoes]
 * @returns {Promise<Buffer>} PDF
 */
async function gerarDanfse(xml, { situacao = 'autorizada', comprimir = true } = {}) {
  let d
  try {
    d = dadosDanfse(xml)
  } catch (e) {
    throw new Error(`Não é possível gerar o DANFSe: o XML não é uma NFS-e (${e.message})`)
  }
  const qr = await QRCode.toBuffer(d.urlQr, { errorCorrectionLevel: 'M', margin: 0, width: 300 })
  const doc = new PDFDocument({ size: 'A4', margin: 0, compress: comprimir, info: { Title: `DANFSe ${d.numero}`, Subject: d.chave } })
  const partes = []
  doc.on('data', (c) => partes.push(c))
  const pronto = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))))

  const pt = (cm) => cm * CM
  const fundo = (x, y, w, h) => doc.save().rect(pt(x), pt(y), pt(w), pt(h)).fill(CINZA).restore()
  const linhaH = (y) => doc.save().lineWidth(0.5).moveTo(pt(X[0]), pt(y)).lineTo(pt(DIREITA), pt(y)).stroke('#000').restore()
  const escrever = (texto, x, y, w, { fonte = NORMAL, tamanho = 7, cor = '#000', alinhar = 'left' } = {}) =>
    doc.fillColor(cor).font(fonte).fontSize(tamanho).text(caber(doc, texto, pt(w) - 4, fonte, tamanho), pt(x) + 2, pt(y), { width: pt(w) - 4, align: alinhar, lineBreak: false })

  // Campo: rótulo (6 pt negrito, Primeira Letra Maiúscula) e valor (7 pt) logo abaixo.
  const campo = (rotulo, valor, col, y, { span = 1, sombra = false, destaque = false } = {}) => {
    if (sombra) fundo(X[col], y, largura(col, span), LINHA)
    escrever(rotulo, X[col], y + 0.06, largura(col, span), { fonte: NEGRITO, tamanho: destaque ? 7 : 6 })
    escrever(valor, X[col], y + 0.33, largura(col, span))
  }
  const titulo = (texto, y, h = LINHA) => {
    fundo(X[0], y, largura(0), h)
    escrever(texto, X[0], y + 0.12, largura(0), { fonte: NEGRITO })
  }
  const mensagem = (texto, y) => {
    escrever(texto, X[0], y + 0.08, DIREITA - X[0], { fonte: NEGRITO })
    return 0.4
  }

  // ---------- montagem das linhas (altura em cm + desenho) ----------
  const blocos = []
  const bloco = (desenhar, altura) => blocos.push({ desenhar, altura })

  function blocoPessoa(nome, p, { simples = false, semInscricao = false, vazio }) {
    if (!p) return bloco((y) => mensagem(vazio, y), 0.4)
    const linhas = simples ? 4 : 3
    bloco((y) => {
      titulo(nome, y)
      campo('CNPJ / CPF / NIF', p.documento, 1, y)
      if (!semInscricao) campo('Indicador Municipal (Inscrição)', p.im, 2, y)
      campo('Telefone', p.telefone, 3, y)
      campo('Nome / Nome Empresarial', p.nome, 0, y + LINHA, { span: 2 })
      campo('Município / Sigla UF', p.municipio, 2, y + LINHA)
      campo('Código IBGE / CEP', p.ibgeCep, 3, y + LINHA)
      campo('Endereço', p.endereco, 0, y + 2 * LINHA, { span: 2 })
      campo('E-mail', p.email, 2, y + 2 * LINHA, { span: 2 })
      if (simples) {
        campo('Simples Nacional na Data de Competência', p.simples, 0, y + 3 * LINHA)
        campo('Regime de Apuração Tributária pelo SN', p.regimeSn, 1, y + 3 * LINHA, { span: 3 })
      }
    }, linhas * LINHA)
  }

  blocoPessoa('PRESTADOR / FORNECEDOR', d.prestador, { simples: true, vazio: '' })
  blocoPessoa('TOMADOR / ADQUIRENTE', d.tomador, { vazio: 'TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' })
  blocoPessoa('DESTINATÁRIO DA OPERAÇÃO', d.destinatario, { semInscricao: true, vazio: 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO' })
  blocoPessoa('INTERMEDIÁRIO DA OPERAÇÃO', d.intermediario, { vazio: 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' })

  // Serviço: a descrição cresce conforme o texto (calculada depois, com o espaço que sobrar).
  const servico = { altura: 0 }
  bloco((y) => {
    titulo('SERVIÇO PRESTADO', y)
    campo('Código de Tributação Nacional / Municipal', d.servico.codigo, 1, y)
    campo('Código da NBS', d.servico.nbs, 2, y)
    campo('Local da Prestação / Sigla UF / País', d.servico.local, 3, y)
    escrever(d.servico.descricaoCodigo, X[0], y + LINHA + 0.08, DIREITA - X[0], { cor: '#444' })
    escrever('Descrição do Serviço', X[0], y + LINHA + 0.46, DIREITA - X[0], { fonte: NEGRITO, tamanho: 6 })
    doc.fillColor('#000').font(NORMAL).fontSize(7)
      .text(d.servico.descricao, pt(X[0]) + 2, pt(y + LINHA + 0.72), { width: pt(DIREITA - X[0]) - 4, height: pt(servico.altura), ellipsis: true })
  }, null)
  const indiceServico = blocos.length - 1

  if (!d.issqn) bloco((y) => mensagem('TRIBUTAÇÃO MUNICIPAL (ISSQN) - OPERAÇÃO NÃO SUJEITA AO ISSQN', y), 0.4)
  else {
    const i = d.issqn
    const linha2 = [i.regimeEspecial, i.imunidade, i.suspensao, i.processo].some((v) => v !== VAZIO)
    const linha3 = [i.beneficio, i.calculoBm, i.deducoes, i.descontoIncond].some((v) => v !== VAZIO)
    bloco((y) => {
      titulo('TRIBUTAÇÃO MUNICIPAL (ISSQN)', y)
      campo('Tipo de Tributação do ISSQN', i.tipo, 1, y)
      campo('Município / Sigla UF / País de Incidência do ISSQN', i.incidencia, 2, y, { span: 2 })
      let yy = y + LINHA
      if (linha2) {
        campo('Regime Especial de Tributação do ISSQN', i.regimeEspecial, 0, yy)
        campo('Tipo de Imunidade do ISSQN', i.imunidade, 1, yy)
        campo('Suspensão da Exigibilidade do ISSQN', i.suspensao, 2, yy)
        campo('Número Processo Suspensão', i.processo, 3, yy)
        yy += LINHA
      }
      if (linha3) {
        campo('Benefício Municipal', i.beneficio, 0, yy)
        campo('Cálculo do BM', i.calculoBm, 1, yy)
        campo('Total Deduções/Reduções', i.deducoes, 2, yy)
        campo('Desconto Incondicionado', i.descontoIncond, 3, yy)
        yy += LINHA
      }
      campo('BC ISSQN', i.bc, 0, yy)
      campo('Alíquota Aplicada', i.aliquota, 1, yy)
      campo('Retenção do ISSQN', i.retencao, 2, yy)
      campo('ISSQN Apurado', i.apurado, 3, yy)
    }, (2 + (linha2 ? 1 : 0) + (linha3 ? 1 : 0)) * LINHA)
  }

  const f = d.federal
  bloco((y) => {
    titulo('TRIBUTAÇÃO FEDERAL (EXCETO CBS)', y)
    campo('IRRF', f.irrf, 1, y)
    campo('Contribuição Previdenciária - Retida', f.cpRetida, 2, y)
    campo('Contribuições Sociais - Retidas', f.contribuicoesRetidas, 3, y)
    if (f.imprimirPisCofins) {
      campo('PIS - Débito Apuração Própria', f.pis, 0, y + LINHA)
      campo('COFINS - Débito Apuração Própria', f.cofins, 1, y + LINHA)
      campo('Descrição Contrib. Sociais - Retidas', f.descricaoRetidas, 2, y + LINHA, { span: 2 })
    }
  }, (f.imprimirPisCofins ? 2 : 1) * LINHA)

  const t = d.ibscbs
  bloco((y) => {
    titulo('TRIBUTAÇÃO IBS / CBS', y)
    campo('CST / cClassTrib', t.cst, 1, y)
    campo('Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF', t.indicador, 2, y, { span: 2 })
    campo('Exclusões e Reduções da Base de Cálculo', t.exclusoes, 0, y + LINHA)
    campo('Base de Cálculo Após Exclusões e Reduções', t.bc, 1, y + LINHA)
    campo('Red. Alíquota IBS / Red. Alíquota CBS', t.reducoes, 2, y + LINHA)
    campo('Alíquota - IBS UF / IBS Mun', t.aliquotas, 3, y + LINHA)
    campo('Alíq. Efetiva Municipal - IBS', t.efetivaMun, 0, y + 2 * LINHA)
    campo('Valor Apurado Municipal - IBS', t.valorMun, 1, y + 2 * LINHA)
    campo('Alíq. Efetiva Estadual - IBS', t.efetivaUf, 2, y + 2 * LINHA)
    campo('Valor Apurado Estadual - IBS', t.valorUf, 3, y + 2 * LINHA)
    campo('Valor Total Apurado - IBS', t.totalIbs, 0, y + 3 * LINHA)
    campo('Alíquota - CBS', t.aliquotaCbs, 1, y + 3 * LINHA)
    campo('Alíquota Efetiva - CBS', t.efetivaCbs, 2, y + 3 * LINHA)
    campo('Valor Total Apurado - CBS', t.totalCbs, 3, y + 3 * LINHA)
  }, 4 * LINHA)

  const v = d.totais
  bloco((y) => {
    titulo('VALOR TOTAL DA NFS-E', y)
    campo('VALOR DA OPERAÇÃO / SERVIÇO', v.servico, 1, y, { destaque: true })
    campo('Desconto Incondicionado', v.descontoIncond, 2, y)
    campo('Desconto Condicionado', v.descontoCond, 3, y)
    campo('Total das Retenções (ISSQN / Federais)', v.retencoes, 0, y + LINHA)
    campo('VALOR LÍQUIDO DA NFS-e', v.liquido, 1, y + LINHA, { destaque: true })
    campo('Total do IBS/CBS', v.ibscbs, 2, y + LINHA)
    campo('VALOR LÍQUIDO DA NFS-e + IBS/CBS', v.liquidoComIbscbs, 3, y + LINHA, { sombra: true, destaque: true })
  }, 2 * LINHA)

  // ---------- espaço da descrição do serviço e das informações complementares ----------
  const INICIO_BLOCOS = 4.34
  const MIN_INFO = 1.6
  const fixos = blocos.reduce((s, b) => s + (b.altura ?? 0), 0) + LINHA + 0.78
  doc.font(NORMAL).fontSize(7)
  const precisa = doc.heightOfString(d.servico.descricao, { width: pt(DIREITA - X[0]) - 4 }) / CM + 0.1
  servico.altura = Math.max(0.6, Math.min(precisa, FIM_PAGINA - INICIO_BLOCOS - fixos - MIN_INFO))
  // Linha dos códigos + descrição do código + rótulo "Descrição do Serviço" (0,72 cm) + texto.
  blocos[indiceServico].altura = LINHA + 0.78 + servico.altura

  // Marca d'água de cancelada/substituída (itens 2.5.1 e 2.5.2), desenhada antes de tudo para ficar por trás do conteúdo.
  const marca = { cancelada: 'CANCELADA', substituida: 'SUBSTITUÍDA' }[situacao]
  if (marca) {
    doc.save().rotate(-35, { origin: [pt(10.5), pt(15)] }).fillColor('#a6a6a6').font(NORMAL).fontSize(72)
      .text(marca, pt(0.5), pt(14.2), { width: pt(20), align: 'center', lineBreak: false }).restore()
  }

  // ---------- cabeçalho ----------
  fundo(X[0], 0.3, DIREITA - X[0], 1.16)
  doc.image(LOGO, pt(0.49), pt(0.44), { fit: [pt(4.0), pt(0.85)] })
  escrever('DANFSe v2.0', 5.41, 0.42, 10.19, { fonte: NEGRITO, tamanho: 9, alinhar: 'center' })
  escrever('Documento Auxiliar da NFS-e', 5.41, 0.78, 10.19, { fonte: NEGRITO, tamanho: 9, alinhar: 'center' })
  if (d.homologacao) escrever('NFS-e SEM VALIDADE JURÍDICA', 5.41, 1.12, 10.19, { fonte: NEGRITO, tamanho: 9, cor: '#e00000', alinhar: 'center' })
  escrever(d.municipioEmissao, 15.62, 0.4, 5.09, { tamanho: 8 })
  escrever(d.ambienteGerador, 15.62, 0.97, 5.09, { tamanho: 6 })
  escrever(d.tipoAmbiente, 15.62, 1.22, 5.09, { tamanho: 6 })
  linhaH(1.46)

  // ---------- identificação da NFS-e ----------
  const rot = (texto, valor, col, y, opcoes = {}) => {
    if (opcoes.sombra) fundo(X[col], y, largura(col), 0.67)
    escrever(texto, X[col], y + 0.06, largura(col, opcoes.span), { fonte: NEGRITO })
    escrever(valor, X[col], y + 0.36, largura(col, opcoes.span))
  }
  rot('CHAVE DE ACESSO DA NFS-E', d.chave, 0, 1.52, { span: 3 })
  rot('NÚMERO DA NFS-E', d.numero, 0, 2.27)
  rot('COMPETÊNCIA DA NFS-E', d.competencia, 1, 2.27)
  rot('DATA E HORA DA EMISSÃO DA NFS-E', d.emissaoNfse, 2, 2.27)
  rot('NÚMERO DA DPS', d.numeroDps, 0, 2.96)
  rot('SÉRIE DA DPS', d.serieDps, 1, 2.96)
  rot('DATA E HORA DA EMISSÃO DA DPS', d.emissaoDps, 2, 2.96)
  rot('EMITENTE DA NFS-E', d.emitente, 0, 3.65, { sombra: true })
  rot('SITUAÇÃO DA NFS-E', d.situacao, 1, 3.65)
  rot('FINALIDADE', d.finalidade, 2, 3.65)
  doc.image(qr, pt(17.48), pt(1.67), { width: pt(1.52), height: pt(1.52) })
  doc.fillColor('#000').font(NORMAL).fontSize(6).text(
    'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e',
    pt(15.8), pt(3.36), { width: pt(4.72), align: 'justify' },
  )

  // ---------- blocos ----------
  let y = INICIO_BLOCOS
  for (const b of blocos) {
    linhaH(y)
    b.desenhar(y)
    y += b.altura
  }
  linhaH(y)
  titulo('INFORMAÇÕES COMPLEMENTARES', y, 0.42)
  doc.fillColor('#000').font(NORMAL).fontSize(7)
    .text(d.informacoes, pt(X[0]) + 2, pt(y + 0.5), { width: pt(DIREITA - X[0]) - 4, height: pt(FIM_PAGINA - y - 0.6), ellipsis: true })

  // Borda da página (1 pt).
  doc.save().lineWidth(1).rect(pt(0.2), pt(0.2), pt(DIREITA - 0.1), pt(FIM_PAGINA)).stroke('#000').restore()

  doc.end()
  return pronto
}

/** Situação para a marca d'água: substituída (evento 105102), cancelada ou autorizada. */
function situacaoDanfse(nota, tiposEvento = []) {
  if (tiposEvento.includes('105102')) return 'substituida'
  return nota.cancelada ? 'cancelada' : 'autorizada'
}

module.exports = { gerarDanfse, situacaoDanfse }
