'use strict'

// ZIP da tela Exportar: clientes, tipos e meses escolhidos, em <Empresa>/<Ano>/<Mês>/<Tipo>/, a mesma ordem das telas.
// `incluir` escolhe o conteúdo: 'pdf' (pasta PDF, um por nota), 'xml' (pasta XML), 'relatorio' e 'excel' (um de cada por empresa, mês e tipo, soltos na pasta do tipo).
// Dois clientes com o mesmo nome de pasta levam o CNPJ junto, para as notas não se misturarem.
// Só notas com XML completo. Um XML sumido ou um PDF com erro não param a exportação: vão para avisos.txt.
// Só lê: não grava em `execucoes` nem marca `exportada_em`.

const fs = require('node:fs')
const path = require('node:path')
const { criarArmazenamento, PASTAS, MESES, nomeDePasta, nomeDoCliente, nomeNoZip } = require('./armazenamento')
const { DA_CARTEIRA } = require('./clientes')
const { pdfsDasNotas } = require('./pdfNota')
const { montarPlanilhaDoMes } = require('./planilhaMes')
const { montarRelatorioPdf } = require('./relatorioPdf')

const MODELOS = Object.keys(PASTAS.modelo)
const COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/
const CONTEUDOS = ['pdf', 'xml', 'relatorio', 'excel']

function erro(status, mensagem) {
  return Object.assign(new Error(mensagem), { status })
}

const ordenar = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' })

function criarServicoExportacaoLote({ db, config, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ config, db })
  const clientes = db.prepare(`SELECT id, cnpj, papel, apelido, razao_social FROM clientes WHERE ${DA_CARTEIRA}`)
  const contagem = db.prepare(`SELECT n.modelo, n.competencia, n.cliente_id clienteId, COUNT(*) total FROM notas n
    JOIN clientes c ON c.id = n.cliente_id
    WHERE n.status = 'completa' AND n.caminho_xml IS NOT NULL AND n.competencia IS NOT NULL AND (c.papel = 'cliente' OR c.tambem_cliente = 1)
    GROUP BY n.modelo, n.competencia, n.cliente_id`)
  const evento = db.prepare("SELECT caminho_xml FROM eventos WHERE chave = ? AND tp_evento = '110111' AND caminho_xml IS NOT NULL ORDER BY n_seq")
  const tiposEvento = db.prepare('SELECT tp_evento FROM eventos WHERE chave = ?')
  const pdfs = pdfsDasNotas((c) => tiposEvento.all(c).map((e) => e.tp_evento))

  const daCarteira = () => clientes.all().map((c) => ({ id: c.id, cnpj: c.cnpj, nome: nomeDoCliente(c) })).sort(ordenar)

  /** Clientes em ordem e quantas notas com XML existem por tipo, mês e cliente (a tela monta os filtros e a contagem disso). */
  function opcoes() {
    return { clientes: daCarteira(), notas: contagem.all().map((l) => ({ ...l })) }
  }

  /**
   * Confere a escolha e separa as notas; os arquivos só são gerados ao percorrer `arquivos()`.
   * @param {{ modelos: string[], competencias: string[], clientes: number[], incluir: string[] }} escolha
   * @returns {{ nome: string, total: number, arquivos: () => AsyncGenerator<{ nome: string, caminho?: string, conteudo?: Buffer }> }}
   */
  function preparar({ modelos, competencias, clientes: ids, incluir } = {}) {
    if (!Array.isArray(incluir) || !incluir.length || !incluir.every((c) => CONTEUDOS.includes(c))) throw erro(400, 'Escolha o que exportar: PDF, XML, relatório ou Excel.')
    if (!Array.isArray(modelos) || !modelos.length || !modelos.every((m) => MODELOS.includes(m))) throw erro(400, 'Escolha ao menos um tipo de nota.')
    if (!Array.isArray(competencias) || !competencias.length || !competencias.every((c) => COMPETENCIA.test(c))) throw erro(400, 'Escolha ao menos um ano e um mês.')
    if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isSafeInteger)) throw erro(400, 'Escolha ao menos um cliente.')

    const marcados = daCarteira().filter((c) => ids.includes(c.id))
    if (marcados.length !== new Set(ids).size) throw erro(400, 'Cliente não encontrado.')
    // O Windows não diferencia maiúscula de minúscula em nome de pasta.
    const chave = (c) => nomeDePasta(c.nome).toLowerCase()
    const repetidos = marcados.filter((c, _, todos) => todos.filter((o) => chave(o) === chave(c)).length > 1).map((c) => c.id)
    const pastaCliente = new Map(marcados.map((c) => [c.id, repetidos.includes(c.id) ? `${nomeDePasta(c.nome)} ${c.cnpj}` : nomeDePasta(c.nome)]))

    const lista = (v) => v.map(() => '?').join(',')
    const notas = db
      .prepare(`SELECT * FROM notas WHERE status = 'completa' AND caminho_xml IS NOT NULL AND modelo IN (${lista(modelos)}) AND competencia IN (${lista(competencias)}) AND cliente_id IN (${lista(ids)})
        ORDER BY cliente_id, modelo, competencia, data_emissao`)
      .all(...modelos, ...competencias, ...ids)
    if (!notas.length) throw erro(409, 'Nenhuma nota com XML para essa escolha.')

    const partes = new Set(incluir)
    const lerXml = (n) => {
      const origem = armazenamento.absoluto(n.caminho_xml)
      return fs.existsSync(origem) ? fs.readFileSync(origem, 'utf8') : null
    }

    async function* arquivos() {
      const avisos = []
      // Um grupo por empresa, tipo e mês: cada um é uma pasta do ZIP.
      const grupos = new Map()
      for (const n of notas) {
        const k = `${n.cliente_id}|${n.modelo}|${n.competencia}`
        grupos.set(k, [...(grupos.get(k) || []), n])
      }
      for (const grupo of grupos.values()) {
        const [{ cliente_id: clienteId, modelo, competencia }] = grupo
        const [ano, mes] = competencia.split('-')
        const nomeDoMes = MESES[Number(mes) - 1]
        const tipo = PASTAS.modelo[modelo]
        const pasta = `${pastaCliente.get(clienteId)}/${ano}/${nomeDoMes}/${tipo}`

        for (const n of partes.has('pdf') || partes.has('xml') ? grupo : []) {
          const origem = armazenamento.absoluto(n.caminho_xml)
          if (!fs.existsSync(origem)) {
            avisos.push(`Nota ${n.chave}: XML não encontrado no disco.`)
            continue
          }
          if (partes.has('pdf')) {
            const pdf = pdfs.find((p) => p.doModelo(n))
            try {
              yield { nome: `${pasta}/PDF/${nomeNoZip(n).replace(/\.xml$/, '.pdf')}`, conteudo: await pdf.gerar(fs.readFileSync(origem, 'utf8'), n) }
            } catch (e) {
              avisos.push(`${pdf.rotulo} da nota ${n.chave} não gerado: ${e.message}`)
            }
          }
          if (!partes.has('xml')) continue
          yield { nome: `${pasta}/XML/${nomeNoZip(n)}`, caminho: origem }
          if (!n.cancelada) continue
          for (const e of evento.all(n.chave)) {
            const arquivoEvento = armazenamento.absoluto(e.caminho_xml)
            if (fs.existsSync(arquivoEvento)) yield { nome: `${pasta}/XML/${path.basename(e.caminho_xml)}`, caminho: arquivoEvento }
          }
        }

        const sufixo = `${tipo} ${nomeDoMes} ${ano}`
        const cliente = marcados.find((c) => c.id === clienteId)
        const relatorios = [
          ['relatorio', `Relatorio ${sufixo}.pdf`, () => montarRelatorioPdf({ cliente: { cnpj: cliente.cnpj, nome: cliente.nome }, competencia, notas: grupo, lerXml, modelo })],
          ['excel', `Relatorio ${sufixo}.xlsx`, () => montarPlanilhaDoMes({ notas: grupo, lerXml, modelo })],
        ]
        for (const [parte, nome, montar] of relatorios) {
          if (!partes.has(parte)) continue
          try {
            yield { nome: `${pasta}/${nome}`, conteudo: await montar() }
          } catch (e) {
            avisos.push(`${nome} de ${pastaCliente.get(clienteId)} não gerado: ${e.message}`)
          }
        }
      }
      if (avisos.length) yield { nome: 'avisos.txt', conteudo: Buffer.from(avisos.join('\r\n') + '\r\n', 'utf8') }
    }

    // Data no horário de Brasília (-03:00).
    const hoje = new Date(agora().getTime() - 3 * 3600e3).toISOString().slice(0, 10)
    return { nome: `Smart-Fiscal-Exportacao-${hoje}.zip`, total: notas.length, arquivos }
  }

  return { opcoes, preparar }
}

module.exports = { criarServicoExportacaoLote }
