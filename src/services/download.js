'use strict'

// Download do XML completo por chave (consultaChNFe) das notas com ciência enviada.
// A consulta por chave gasta a mesma cota da distribuição: limite por CNPJ por ciclo.

const { tipoDocumento } = require('../sefaz/client')
const { criarServicoCaptura } = require('./captura')

const UMA_HORA = 3600e3
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))

function criarServicoDownload(deps) {
  const { db, config, logger, fabricaSefaz, dormir = dormirPadrao, agora = () => new Date() } = deps
  const captura = deps.captura || criarServicoCaptura(deps)
  const iso = (deslocamentoMs = 0) => new Date(agora().getTime() + deslocamentoMs).toISOString()

  const sql = {
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    pendentes: db.prepare(`SELECT chave FROM notas WHERE cliente_id = ? AND tipo = 'entrada' AND status = 'ciencia_enviada' AND cancelada = 0
      AND tentativas_download < ? ORDER BY tentativas_download, ciencia_em, id LIMIT ?`),
    tentativa: db.prepare('UPDATE notas SET tentativas_download = tentativas_download + 1, atualizado_em = ? WHERE cliente_id = ? AND chave = ?'),
    status: db.prepare('SELECT status FROM notas WHERE cliente_id = ? AND chave = ?'),
    bloquear: db.prepare('UPDATE clientes SET bloqueado_ate = ?, ultimo_erro = ? WHERE id = ?'),
    iniciarExecucao: db.prepare(`INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'download', ?)`),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, c_stat = @c_stat, x_motivo = @x_motivo,
      docs_recebidos = @docs, erro = @erro WHERE id = @id`),
  }

  const gravarDocs = db.transaction((cliente, docs) => {
    for (const doc of docs) captura.processarDocumento(cliente, doc)
  })

  function bloqueado(cliente) {
    return cliente.bloqueado_ate && new Date(cliente.bloqueado_ate).getTime() > agora().getTime()
  }

  /** Tenta baixar o XML completo das notas em 'ciencia_enviada'. Nunca lança exceção. */
  async function baixarPendentes(clienteId) {
    const cliente = sql.cliente.get(clienteId)
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado' }
    const resultado = { ok: true, cnpj: cliente.cnpj, consultas: 0, baixadas: 0, indisponiveis: 0, erro: null, cStat: null, xMotivo: null }
    if (bloqueado(cliente)) return { ...resultado, pulado: `bloqueado até ${cliente.bloqueado_ate}` }

    const chaves = sql.pendentes.all(cliente.id, config.maxTentativasDownload, config.maxConsultasChavePorCiclo).map((n) => n.chave)
    if (!chaves.length) return resultado

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    try {
      const sefaz = fabricaSefaz(cliente)
      for (const chave of chaves) {
        if (resultado.consultas > 0) await dormir(config.intervaloEntreChamadasMs)
        const r = await sefaz.consultaChNFe(chave)
        resultado.consultas++
        sql.tentativa.run(iso(), cliente.id, chave)

        if (r.error) {
          resultado.ok = false
          resultado.erro = `Erro na consulta por chave: ${r.error}`
          logger.error('Falha no download por chave', { cnpj: cliente.cnpj, chave, erro: r.error })
          break
        }
        const dados = r.data || {}
        resultado.cStat = String(dados.cStat || '')
        resultado.xMotivo = dados.xMotivo || null

        if (resultado.cStat === '656') {
          resultado.ok = false
          resultado.erro = `656 ${resultado.xMotivo || 'Consumo indevido'}`
          sql.bloquear.run(iso(UMA_HORA), resultado.erro, cliente.id)
          logger.warn('Consumo indevido (656) no download: cliente bloqueado por 1 h', { cnpj: cliente.cnpj })
          break
        }

        const docs = dados.docZip || []
        if (resultado.cStat === '138' && docs.length) {
          gravarDocs(cliente, docs)
          if (sql.status.get(cliente.id, chave)?.status === 'completa') {
            resultado.baixadas++
            continue
          }
        }
        // Ainda sem o XML completo (só o resumo, 137 ou rejeição): tenta no próximo ciclo.
        resultado.indisponiveis++
        logger.info('XML completo ainda indisponível', { cnpj: cliente.cnpj, chave, cStat: resultado.cStat, tipos: docs.map((d) => tipoDocumento(d.schema)) })
      }
    } catch (e) {
      resultado.ok = false
      resultado.erro = `Erro inesperado: ${e.message}`
      logger.error('Erro inesperado no download', { cnpj: cliente.cnpj, erro: e.message })
    }
    sql.fecharExecucao.run({ id: execId, fim: iso(), c_stat: resultado.cStat, x_motivo: resultado.xMotivo, docs: resultado.baixadas, erro: resultado.erro })
    logger.info('Download processado', { cnpj: cliente.cnpj, consultas: resultado.consultas, baixadas: resultado.baixadas })
    return resultado
  }

  return { baixarPendentes }
}

module.exports = { criarServicoDownload }
