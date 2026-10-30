'use strict'

// Monta o download de "Baixar selecionados" com as notas marcadas no painel. `incluir` escolhe o conteúdo:
//   'xml'     XMLs das notas (e o evento de cancelamento das canceladas)
//   'danfe'   PDF de cada NF-e (DANFE), gerado do XML
//   'danfse'  PDF de cada NFS-e (DANFSe), gerado do XML
//   'excel'   planilha das marcadas (abas Entradas e Saídas quando são de um modelo só)
//   'pdf'     relatório em PDF com os mesmos dados da planilha
// Um arquivo só (só a planilha ou só o relatório) sai solto; o resto sai em ZIP.
// Nome: <apelido>_<AAAA-MM>_<NF-e|NFS-e> quando as marcadas são de um mês e um modelo; senão <apelido>_selecionadas_<carimbo>.
// Só lê: não grava em `execucoes` nem marca `exportada_em`.

const fs = require('node:fs')
const path = require('node:path')
const { criarArmazenamento, pastaDoCliente, pastaNoZip, nomeNoZip, slug } = require('./armazenamento')
const { montarPlanilhaDoMes } = require('./planilhaMes')
const { montarRelatorioPdf } = require('./relatorioPdf')
const { gerarDanfse, situacaoDanfse } = require('./danfse/gerar')
const { gerarDanfe } = require('./danfe/gerar')

const LIMITE_NOTAS = 2000
const CONTEUDOS = ['xml', 'danfe', 'danfse', 'excel', 'pdf']
const TIPOS = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }

function erro(status, mensagem) {
  return Object.assign(new Error(mensagem), { status })
}

// AAAAMMDD-HHMMSS no horário de Brasília (-03:00).
function carimbo(data) {
  return new Date(data.getTime() - 3 * 3600e3).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
}

// O valor comum a todas as notas, ou null se variar.
const unico = (notas, campo) => (notas.every((n) => n[campo] === notas[0][campo]) ? notas[0][campo] : null)

function criarServicoSelecao({ db, config, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const cliente = db.prepare('SELECT cnpj, apelido, razao_social FROM clientes WHERE id = ?')
  const evento = db.prepare("SELECT caminho_xml FROM eventos WHERE chave = ? AND tp_evento = '110111' AND caminho_xml IS NOT NULL ORDER BY n_seq")
  const tiposEvento = db.prepare('SELECT tp_evento FROM eventos WHERE chave = ?')

  // XML da nota no disco, ou null (sem XML completo ou arquivo sumido).
  const arquivoXml = (n) => {
    if (n.status !== 'completa' || !n.caminho_xml) return null
    const origem = armazenamento.absoluto(n.caminho_xml)
    return fs.existsSync(origem) ? origem : null
  }
  const lerXml = (n) => {
    const origem = arquivoXml(n)
    return origem ? fs.readFileSync(origem, 'utf8') : null
  }

  /**
   * @param {number[]} ids notas marcadas (de um cliente só)
   * @param {{ incluir?: string[] }} [opcoes] padrão: só os XMLs
   * @returns {Promise<{ nome: string, arquivos: object[] } | { nome: string, conteudo: Buffer, tipo: string }>} ZIP (arquivos) ou arquivo solto
   */
  async function montar(ids, { incluir = ['xml'] } = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > LIMITE_NOTAS || !ids.every(Number.isSafeInteger)) {
      throw erro(400, `Informe de 1 a ${LIMITE_NOTAS} notas.`)
    }
    const partes = new Set(incluir)
    if (!partes.size || [...partes].some((p) => !CONTEUDOS.includes(p))) throw erro(400, 'Conteúdo inválido: escolha xml, danfe, danfse, excel e/ou pdf.')
    const unicos = [...new Set(ids)]
    const notas = db
      .prepare(`SELECT * FROM notas WHERE id IN (${unicos.map(() => '?').join(',')}) ORDER BY data_emissao, emitente_cnpj, CAST(numero AS INTEGER)`)
      .all(...unicos)
    if (notas.length !== unicos.length) throw erro(404, 'Nota não encontrada.')
    if (new Set(notas.map((n) => n.cliente_id)).size > 1) throw erro(400, 'Marque notas de um único cliente.')

    const dono = cliente.get(notas[0].cliente_id)
    const competencia = unico(notas, 'competencia')
    const modeloComum = unico(notas, 'modelo')
    const modelo = modeloComum === 'nfse' ? 'nfse' : modeloComum ? 'nfe' : undefined
    const doMes = competencia && modelo ? `${competencia}_${modelo === 'nfse' ? 'NFS-e' : 'NF-e'}` : `selecionadas_${carimbo(agora())}`
    const nomeDaEmpresa = slug(dono.apelido || dono.razao_social) || dono.cnpj

    const arquivos = []
    const avisos = []
    if (partes.has('xml')) {
      for (const n of notas) {
        const origem = arquivoXml(n)
        if (!origem) {
          avisos.push(`Nota ${n.chave}: ${n.status !== 'completa' || !n.caminho_xml ? 'sem XML completo' : 'XML não encontrado no disco'}.`)
          continue
        }
        const pasta = pastaNoZip(n)
        arquivos.push({ nome: `${pasta}/${nomeNoZip(n)}`, caminho: origem })
        if (!n.cancelada) continue
        for (const e of evento.all(n.chave)) {
          const arquivoEvento = armazenamento.absoluto(e.caminho_xml)
          if (fs.existsSync(arquivoEvento)) arquivos.push({ nome: `${pasta}/${path.basename(e.caminho_xml)}`, caminho: arquivoEvento })
        }
      }
    }
    // PDF de cada nota: DANFE para NF-e, DANFSe para NFS-e (ao lado do XML, com o mesmo nome).
    const pdfsDasNotas = [
      ['danfe', 'DANFE', (n) => n.modelo !== 'nfse', (xml, n) => gerarDanfe(xml, { situacao: n.cancelada ? 'cancelada' : 'autorizada' })],
      ['danfse', 'DANFSe', (n) => n.modelo === 'nfse', (xml, n) => gerarDanfse(xml, { situacao: situacaoDanfse(n, tiposEvento.all(n.chave).map((e) => e.tp_evento)) })],
    ]
    for (const [chave, rotulo, doModelo, gerar] of pdfsDasNotas) {
      if (!partes.has(chave)) continue
      for (const n of notas.filter(doModelo)) {
        const xml = lerXml(n)
        if (!xml) continue
        try {
          arquivos.push({ nome: `${pastaNoZip(n)}/${nomeNoZip(n).replace(/\.xml$/, '.pdf')}`, conteudo: await gerar(xml, n) })
        } catch (e) {
          avisos.push(`${rotulo} da nota ${n.chave} não gerado: ${e.message}`)
        }
      }
    }
    const relatorios = []
    if (partes.has('excel')) relatorios.push({ ext: 'xlsx', conteudo: await montarPlanilhaDoMes({ notas, lerXml, modelo }) })
    if (partes.has('pdf')) {
      const doCliente = { cnpj: dono.cnpj, nome: dono.apelido || dono.razao_social }
      relatorios.push({ ext: 'pdf', conteudo: await montarRelatorioPdf({ cliente: doCliente, competencia, notas, lerXml, modelo }) })
    }

    // Só a planilha ou só o relatório: arquivo solto, com o nome da empresa.
    if (partes.size === 1 && relatorios.length === 1) {
      const [r] = relatorios
      return { nome: `${nomeDaEmpresa}_${doMes}.${r.ext}`, conteudo: r.conteudo, tipo: TIPOS[r.ext] }
    }
    for (const r of relatorios) arquivos.push({ nome: r.ext === 'xlsx' ? 'notas.xlsx' : 'relatorio.pdf', conteudo: r.conteudo })
    if (!arquivos.length) {
      throw erro(409, 'Nenhuma das notas marcadas tem XML completo para isso.')
    }
    if (avisos.length) arquivos.push({ nome: 'avisos.txt', conteudo: Buffer.from(avisos.join('\r\n') + '\r\n', 'utf8') })
    return { nome: `${pastaDoCliente(dono)}_${doMes}.zip`, arquivos }
  }

  return { montar }
}

module.exports = { criarServicoSelecao, LIMITE_NOTAS }
