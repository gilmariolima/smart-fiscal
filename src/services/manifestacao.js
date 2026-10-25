'use strict'

// Manifestação do destinatário (RecepcaoEvento).
// Automático: só Ciência da Operação (210210), em lotes de até 20.
// Eventos conclusivos (confirmação, desconhecimento, não realizada) só por comando manual.

const CIENCIA = 210210
const MAX_POR_LOTE = 20
const SUCESSO = new Set(['135', '136', '573']) // 573 = duplicidade: a ciência já existe
const SERVICO_FORA = new Set(['108', '109']) // serviço paralisado: tentar de novo depois

const EVENTOS_MANUAIS = {
  confirmacao: { codigo: 210200, descricao: 'Confirmacao da Operacao' },
  desconhecimento: { codigo: 210220, descricao: 'Desconhecimento da Operacao' },
  'nao-realizada': { codigo: 210240, descricao: 'Operacao nao Realizada' },
}

const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))

function criarServicoManifestacao({ db, config, logger, fabricaSefaz, dormir = dormirPadrao, agora = () => new Date() }) {
  const iso = () => agora().toISOString()
  let seqLote = 0
  // idLote: numérico, até 15 dígitos, único por envio.
  const novoIdLote = () => String(agora().getTime()).slice(-12) + String(++seqLote % 1000).padStart(3, '0')

  const sql = {
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    pendentes: db.prepare(`SELECT chave FROM notas WHERE cliente_id = ? AND tipo = 'entrada' AND status = 'resumo' AND cancelada = 0
      AND COALESCE(situacao_sefaz, '1') = '1' ORDER BY id`),
    ok: db.prepare(`UPDATE notas SET status = CASE WHEN status = 'completa' THEN status ELSE 'ciencia_enviada' END,
      ciencia_protocolo = @protocolo, ciencia_em = @em, ciencia_erro = NULL, atualizado_em = @agora WHERE cliente_id = @cliente_id AND chave = @chave`),
    erro: db.prepare(`UPDATE notas SET status = CASE WHEN status = 'completa' THEN status ELSE 'ciencia_erro' END,
      ciencia_erro = @erro, atualizado_em = @agora WHERE cliente_id = @cliente_id AND chave = @chave`),
    registrarEvento: db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo)
      VALUES (@chave, @tp_evento, '1', @descricao, @data_evento, @protocolo)
      ON CONFLICT(chave, tp_evento, n_seq) DO UPDATE SET protocolo = COALESCE(excluded.protocolo, protocolo),
      data_evento = COALESCE(excluded.data_evento, data_evento)`),
    notaDoCliente: db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?'),
    notasDeEntrada: db.prepare("SELECT * FROM notas WHERE chave = ? AND tipo = 'entrada'"),
    clientePorCnpj: db.prepare('SELECT * FROM clientes WHERE cnpj = ?'),
    iniciarExecucao: db.prepare(`INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'ciencia', ?)`),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, c_stat = @c_stat, x_motivo = @x_motivo,
      docs_recebidos = @docs, erro = @erro WHERE id = @id`),
  }

  const aplicarRetorno = db.transaction((clienteId, lote, infEvento, descricao, tpEvento) => {
    const porChave = new Map((infEvento || []).map((i) => [i.chNFe, i]))
    const contagem = { enviadas: 0, erros: 0, semRetorno: 0 }
    for (const chave of lote) {
      const inf = porChave.get(chave)
      if (!inf) {
        contagem.semRetorno++
        continue
      }
      const cStat = String(inf.cStat || '')
      if (SUCESSO.has(cStat)) {
        sql.ok.run({ cliente_id: clienteId, chave, protocolo: inf.nProt || null, em: inf.dhRegEvento || iso(), agora: iso() })
        sql.registrarEvento.run({ chave, tp_evento: String(tpEvento), descricao, data_evento: inf.dhRegEvento || iso(), protocolo: inf.nProt || null })
        contagem.enviadas++
      } else {
        sql.erro.run({ cliente_id: clienteId, chave, erro: `${cStat} ${inf.xMotivo || ''}`.trim(), agora: iso() })
        contagem.erros++
      }
    }
    return contagem
  })

  const marcarLoteComErro = db.transaction((clienteId, lote, mensagem) => {
    for (const chave of lote) sql.erro.run({ cliente_id: clienteId, chave, erro: mensagem, agora: iso() })
  })

  /** Envia a ciência de todas as notas em 'resumo' do cliente. Nunca lança exceção. */
  async function enviarCiencias(clienteId) {
    const cliente = sql.cliente.get(clienteId)
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado' }
    const chaves = sql.pendentes.all(cliente.id).map((n) => n.chave)
    const resultado = { ok: true, cnpj: cliente.cnpj, pendentes: chaves.length, enviadas: 0, erros: 0, semRetorno: 0, lotes: 0, erro: null, cStat: null, xMotivo: null }
    if (!chaves.length) return resultado

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    try {
      const sefaz = fabricaSefaz(cliente)
      for (let i = 0; i < chaves.length; i += MAX_POR_LOTE) {
        if (i > 0) await dormir(config.intervaloEntreChamadasMs)
        const lote = chaves.slice(i, i + MAX_POR_LOTE)
        const r = await sefaz.enviarEvento({ idLote: novoIdLote(), lote: lote.map((chNFe) => ({ chNFe, tipoEvento: CIENCIA })) })
        resultado.lotes++

        if (r.error) {
          // Falha de comunicação: as notas continuam em 'resumo' e saem no próximo ciclo.
          resultado.ok = false
          resultado.erro = `Erro no envio da ciência: ${r.error}`
          logger.error('Falha ao enviar ciência', { cnpj: cliente.cnpj, erro: r.error })
          break
        }
        const dados = r.data || {}
        resultado.cStat = String(dados.cStat || '')
        resultado.xMotivo = dados.xMotivo || null

        if (resultado.cStat !== '128') {
          resultado.ok = false
          resultado.erro = `Lote rejeitado: ${resultado.cStat} ${resultado.xMotivo || ''}`.trim()
          if (SERVICO_FORA.has(resultado.cStat)) {
            logger.warn('Serviço de eventos indisponível; tenta no próximo ciclo', { cnpj: cliente.cnpj, cStat: resultado.cStat })
          } else {
            marcarLoteComErro(cliente.id, lote, resultado.erro)
            resultado.erros += lote.length
            logger.error('Lote de ciência rejeitado', { cnpj: cliente.cnpj, cStat: resultado.cStat, xMotivo: resultado.xMotivo })
          }
          break
        }

        const c = aplicarRetorno(cliente.id, lote, dados.infEvento, 'Ciencia da Operacao', CIENCIA)
        resultado.enviadas += c.enviadas
        resultado.erros += c.erros
        resultado.semRetorno += c.semRetorno
      }
      logger.info('Ciência processada', { cnpj: cliente.cnpj, enviadas: resultado.enviadas, erros: resultado.erros })
    } catch (e) {
      resultado.ok = false
      resultado.erro = `Erro inesperado: ${e.message}`
      logger.error('Erro inesperado na ciência', { cnpj: cliente.cnpj, erro: e.message })
    }
    sql.fecharExecucao.run({ id: execId, fim: iso(), c_stat: resultado.cStat, x_motivo: resultado.xMotivo, docs: resultado.enviadas, erro: resultado.erro })
    return resultado
  }

  /**
   * Evento conclusivo manual. `evento`: 'confirmacao' | 'desconhecimento' | 'nao-realizada'.
   * Não muda o status da nota; registra o evento na tabela `eventos`.
   */
  async function manifestar({ chave, evento, justificativa, cnpj }) {
    const tipo = EVENTOS_MANUAIS[evento]
    if (!tipo) return { ok: false, erro: `Evento inválido: ${evento}. Use confirmacao, desconhecimento ou nao-realizada.` }
    const just = (justificativa || '').trim()
    if (tipo.codigo === 210240 && (just.length < 15 || just.length > 255)) {
      return { ok: false, erro: 'Operação não realizada exige justificativa de 15 a 255 caracteres.' }
    }
    let nota
    if (cnpj) {
      const dono = sql.clientePorCnpj.get(cnpj)
      nota = dono && sql.notaDoCliente.get(dono.id, chave)
      if (nota && nota.tipo !== 'entrada') return { ok: false, erro: 'Manifestação só vale para nota de entrada.' }
    } else {
      const linhas = sql.notasDeEntrada.all(chave)
      if (linhas.length > 1) return { ok: false, erro: 'Chave em mais de um cliente: informe o CNPJ.' }
      nota = linhas[0]
    }
    if (!nota) return { ok: false, erro: 'Nota não encontrada no banco.' }
    const cliente = sql.cliente.get(nota.cliente_id)

    try {
      const ev = { chNFe: chave, tipoEvento: tipo.codigo }
      if (tipo.codigo === 210240) ev.justificativa = just
      const r = await fabricaSefaz(cliente).enviarEvento({ idLote: novoIdLote(), lote: [ev] })
      if (r.error) return { ok: false, erro: r.error }
      const inf = (r.data?.infEvento || [])[0]
      if (r.data?.cStat !== '128' || !inf) return { ok: false, erro: `Lote rejeitado: ${r.data?.cStat} ${r.data?.xMotivo || ''}`.trim() }
      const cStat = String(inf.cStat)
      if (!SUCESSO.has(cStat)) return { ok: false, cStat, erro: `${cStat} ${inf.xMotivo || ''}`.trim() }
      sql.registrarEvento.run({ chave, tp_evento: String(tipo.codigo), descricao: tipo.descricao, data_evento: inf.dhRegEvento || iso(), protocolo: inf.nProt || null })
      logger.info('Manifestação manual registrada', { cnpj: cliente.cnpj, chave, evento: tipo.codigo, cStat })
      return { ok: true, cStat, protocolo: inf.nProt || null, xMotivo: inf.xMotivo }
    } catch (e) {
      return { ok: false, erro: `Erro inesperado: ${e.message}` }
    }
  }

  return { enviarCiencias, manifestar }
}

module.exports = { criarServicoManifestacao, EVENTOS_MANUAIS, MAX_POR_LOTE }
