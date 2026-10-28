'use strict'

// Reúne os XMLs das notas marcadas no painel para o ZIP de "Baixar selecionados".
// Só lê: não grava em `execucoes` nem marca `exportada_em`.

const fs = require('node:fs')
const path = require('node:path')
const { criarArmazenamento, pastaDoCliente, pastaNoZip, nomeNoZip } = require('./armazenamento')

const LIMITE_NOTAS = 2000

function erro(status, mensagem) {
  return Object.assign(new Error(mensagem), { status })
}

// AAAAMMDD-HHMMSS no horário de Brasília (-03:00).
function carimbo(data) {
  return new Date(data.getTime() - 3 * 3600e3).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
}

function criarServicoSelecao({ db, config, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const cliente = db.prepare('SELECT cnpj, apelido, razao_social FROM clientes WHERE id = ?')
  const evento = db.prepare("SELECT caminho_xml FROM eventos WHERE chave = ? AND tp_evento = '110111' AND caminho_xml IS NOT NULL ORDER BY n_seq")

  function montar(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > LIMITE_NOTAS || !ids.every(Number.isSafeInteger)) {
      throw erro(400, `Informe de 1 a ${LIMITE_NOTAS} notas.`)
    }
    const unicos = [...new Set(ids)]
    const notas = db.prepare(`SELECT * FROM notas WHERE id IN (${unicos.map(() => '?').join(',')}) ORDER BY id`).all(...unicos)
    if (notas.length !== unicos.length) throw erro(404, 'Nota não encontrada.')
    if (new Set(notas.map((n) => n.cliente_id)).size > 1) throw erro(400, 'Marque notas de um único cliente.')

    const arquivos = []
    const avisos = []
    for (const n of notas) {
      if (n.status !== 'completa' || !n.caminho_xml) {
        avisos.push(`Nota ${n.chave}: sem XML completo.`)
        continue
      }
      const origem = armazenamento.absoluto(n.caminho_xml)
      if (!fs.existsSync(origem)) {
        avisos.push(`Nota ${n.chave}: XML não encontrado no disco.`)
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
    if (!arquivos.length) throw erro(409, 'Nenhuma das notas marcadas tem XML completo.')
    if (avisos.length) arquivos.push({ nome: 'avisos.txt', conteudo: Buffer.from(avisos.join('\r\n') + '\r\n', 'utf8') })

    const dono = cliente.get(notas[0].cliente_id)
    return { nome: `${pastaDoCliente(dono)}_selecionadas_${carimbo(agora())}.zip`, arquivos }
  }

  return { montar }
}

module.exports = { criarServicoSelecao, LIMITE_NOTAS }
