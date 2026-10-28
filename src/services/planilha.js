'use strict'

// Gerador mínimo de planilha .xlsx (SpreadsheetML), sem biblioteca: o .xlsx é um ZIP de XMLs.
// Cada aba: { nome, colunas: [títulos], linhas: [[valores]] }.
// Valor número → célula numérica com formato de moeda; texto AAAA-MM-DD... → data dd/mm/aaaa; resto → texto.
// O cabeçalho fica em negrito, congelado e com filtro.

const { PassThrough } = require('node:stream')
const archiver = require('archiver')

const escapar = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Caracteres de controle quebram o XML do Excel.
const limpar = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

function coluna(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// Data/hora como está escrita (hora local do documento) → número de série do Excel.
function serieExcel(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(texto)
  if (!m) return null
  const [, a, mes, d, h = 0, mi = 0, s = 0] = m
  return (Date.UTC(+a, +mes - 1, +d, +h, +mi, +s) - Date.UTC(1899, 11, 30)) / 86400e3
}

function celula(valor, ref) {
  if (valor === null || valor === undefined || valor === '') return ''
  if (typeof valor === 'number' && Number.isFinite(valor)) return `<c r="${ref}" s="1"><v>${valor}</v></c>`
  const serie = typeof valor === 'string' ? serieExcel(valor) : null
  if (serie !== null) return `<c r="${ref}" s="2"><v>${serie}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t>${escapar(limpar(valor))}</t></is></c>`
}

function aba({ colunas, linhas }) {
  const cab = `<row r="1">${colunas.map((t, i) => `<c r="${coluna(i)}1" s="3" t="inlineStr"><is><t>${escapar(t)}</t></is></c>`).join('')}</row>`
  const corpo = linhas.map((l, j) => `<row r="${j + 2}">${l.map((v, i) => celula(v, `${coluna(i)}${j + 2}`)).join('')}</row>`).join('')
  const larguras = colunas.map((t, i) => {
    const maior = Math.max(String(t).length, ...linhas.slice(0, 200).map((l) => String(l[i] ?? '').length))
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(maior + 2, 8), 60)}" customWidth="1"/>`
  })
  const ultima = `${coluna(colunas.length - 1)}${linhas.length + 1}`
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${larguras.join('')}</cols><sheetData>${cab}${corpo}</sheetData><autoFilter ref="A1:${ultima}"/></worksheet>`
}

// O Excel recusa nomes de aba com \ / : * ? [ ] e com mais de 31 caracteres.
const nomeDeAba = (nome, i) => String(nome || `Aba ${i + 1}`).replace(/[\\/:*?[\]]/g, ' ').trim().slice(0, 31) || `Aba ${i + 1}`

const ESTILOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
  + '<cellXfs count="4"><xf/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/** @param {{ nome: string, colunas: string[], linhas: any[][] }[]} abas @returns {Promise<Buffer>} */
function montarXlsx(abas) {
  const nomes = abas.map((a, i) => nomeDeAba(a.nome, i))
  const arquivos = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + nomes.map((n, i) => `<sheet name="${escapar(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets>'
      + `<definedNames>${abas.map((a, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapar(nomes[i])}'!$A$1:$${coluna(a.colunas.length - 1)}$${a.linhas.length + 1}</definedName>`).join('')}</definedNames>`
      + '</workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': ESTILOS,
  }
  abas.forEach((a, i) => (arquivos[`xl/worksheets/sheet${i + 1}.xml`] = aba(a)))

  return new Promise((resolve, reject) => {
    const partes = []
    const saida = new PassThrough()
    saida.on('data', (d) => partes.push(d))
    saida.on('end', () => resolve(Buffer.concat(partes)))
    const zip = archiver('zip', { zlib: { level: 9 } })
    zip.on('error', reject)
    zip.on('warning', reject)
    zip.pipe(saida)
    for (const [nome, conteudo] of Object.entries(arquivos)) zip.append(Buffer.from(conteudo, 'utf8'), { name: nome })
    zip.finalize()
  })
}

module.exports = { montarXlsx }
