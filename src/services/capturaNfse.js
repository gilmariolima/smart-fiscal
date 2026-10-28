'use strict'

// Captura das NFS-e pelo ADN (distribuição por NSU com o certificado do cliente).
// Mesmo molde da captura da NF-e: lotes a partir do último NSU, cada lote numa transação e,
// no fim da fila, 1 h de espera antes de consultar o mesmo CNPJ de novo.

const { criarArmazenamento, nomes, direcaoPelaChave } = require('./armazenamento')
const { dadosNfse, dadosEventoNfse } = require('./extracaoNfse')
const { competenciaDe } = require('./extracao')

const UMA_HORA = 3600e3
const TAMANHO_LOTE = 50 // o ADN entrega até 50 documentos por consulta
const MAX_LOTES_POR_CICLO = 500
const CANCELAMENTOS = new Set(['101101', '105102']) // cancelamento e cancelamento por substituição

const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))
const maiorNsu = (a, b) => (Number(b) > Number(a) ? String(b) : String(a))

/**
 * @param {object} deps
 * @param {Function} deps.fabricaAdn (linha de clientes) => cliente do ADN
 */
function criarServicoCapturaNfse({ db, config, logger, fabricaAdn, dormir = dormirPadrao, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const iso = (deslocamentoMs = 0) => new Date(agora().getTime() + deslocamentoMs).toISOString()
  const tamanhoLote = config.adnTamanhoLote || TAMANHO_LOTE

  const sql = {
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    nota: db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?'),
    inserirNota: db.prepare(`INSERT INTO notas (cliente_id, chave, nsu, tipo, modelo, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome,
        numero, data_emissao, valor_total, status, cancelada, caminho_xml, competencia, atualizado_em)
      VALUES (@cliente_id, @chave, @nsu, @tipo, 'nfse', @emitente_cnpj, @emitente_nome, @destinatario_cnpj, @destinatario_nome,
        @numero, @data_emissao, @valor_total, 'completa', @cancelada, @caminho_xml, @competencia, @atualizado_em)`),
    atualizarNota: db.prepare(`UPDATE notas SET emitente_cnpj = @emitente_cnpj, emitente_nome = @emitente_nome, destinatario_cnpj = @destinatario_cnpj,
        destinatario_nome = @destinatario_nome, numero = @numero, data_emissao = @data_emissao, valor_total = @valor_total, caminho_xml = @caminho_xml,
        competencia = @competencia, cancelada = MAX(cancelada, @cancelada), atualizado_em = @atualizado_em WHERE cliente_id = @cliente_id AND chave = @chave`),
    temCancelamento: db.prepare(`SELECT 1 FROM eventos WHERE chave = ? AND tp_evento IN (${[...CANCELAMENTOS].map((c) => `'${c}'`).join(',')}) LIMIT 1`),
    marcarCancelada: db.prepare('UPDATE notas SET cancelada = 1, atualizado_em = ? WHERE chave = ?'),
    evento: db.prepare('SELECT id FROM eventos WHERE chave = ? AND tp_evento = ? AND n_seq = ?'),
    inserirEvento: db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo, caminho_xml)
      VALUES (@chave, @tp_evento, @n_seq, @descricao, @data_evento, @protocolo, @caminho_xml)`),
    atualizarEvento: db.prepare(`UPDATE eventos SET descricao = @descricao, data_evento = @data_evento, protocolo = @protocolo, caminho_xml = @caminho_xml
      WHERE id = @id`),
    salvarNsu: db.prepare('UPDATE clientes SET nfse_ult_nsu = ?, nfse_ultima_consulta = ?, nfse_ultimo_erro = NULL WHERE id = ?'),
    filaZerada: db.prepare('UPDATE clientes SET nfse_proxima_consulta = ?, nfse_ultima_consulta = ?, nfse_ultimo_erro = NULL WHERE id = ?'),
    erro: db.prepare('UPDATE clientes SET nfse_ultima_consulta = ?, nfse_ultimo_erro = ? WHERE id = ?'),
    iniciarExecucao: db.prepare("INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'captura_nfse', ?)"),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, c_stat = @c_stat, docs_recebidos = @docs, notas_recebidas = @notas,
      eventos_recebidos = @eventos, erro = @erro WHERE id = @id`),
  }

  function gravarNota(cliente, doc) {
    const d = dadosNfse(doc.xml)
    if (!d.chave) return 'ignorado'
    let tipo = 'entrada'
    if (d.prestadorCnpj === cliente.cnpj) tipo = 'saida'
    else if (d.tomadorCnpj !== cliente.cnpj) {
      logger.warn('NFS-e em que o cliente é só intermediário: gravada como entrada', { cnpj: cliente.cnpj, chave: d.chave, intermediario: d.intermediarioCnpj })
    }
    const caminho = armazenamento.salvar({ cliente, modelo: 'nfse', direcao: tipo, competencia: d.competencia, nomeArquivo: nomes.nfse(d.chave), xml: doc.xml })
    const dados = {
      cliente_id: cliente.id, chave: d.chave, nsu: doc.nsu, tipo, emitente_cnpj: d.prestadorCnpj, emitente_nome: d.prestadorNome,
      destinatario_cnpj: d.tomadorCnpj, destinatario_nome: d.tomadorNome, numero: d.numero, data_emissao: d.dataEmissao, valor_total: d.valor,
      cancelada: sql.temCancelamento.get(d.chave) ? 1 : 0, caminho_xml: caminho, competencia: d.competencia, atualizado_em: iso(),
    }
    if (sql.nota.get(cliente.id, d.chave)) sql.atualizarNota.run(dados)
    else sql.inserirNota.run(dados)
    return tipo
  }

  function gravarEvento(cliente, doc) {
    const e = dadosEventoNfse(doc.xml)
    if (!e.chave || !e.tp_evento) return 'ignorado'
    const nota = sql.nota.get(cliente.id, e.chave)
    const caminho = armazenamento.salvar({
      cliente,
      modelo: 'nfse',
      direcao: nota?.tipo || direcaoPelaChave(e.chave, cliente.cnpj),
      competencia: nota?.competencia || competenciaDe(e.data_evento),
      categoria: 'evento',
      nomeArquivo: nomes.evento(e.chave, e.tp_evento, e.n_seq),
      xml: doc.xml,
    })
    const { completo, ...campos } = e
    const existente = sql.evento.get(e.chave, e.tp_evento, e.n_seq)
    if (existente) sql.atualizarEvento.run({ ...campos, caminho_xml: caminho, id: existente.id })
    else sql.inserirEvento.run({ ...campos, caminho_xml: caminho })
    if (CANCELAMENTOS.has(e.tp_evento)) sql.marcarCancelada.run(iso(), e.chave)
    return 'evento'
  }

  // Documentos do lote + NSU novo numa transação: ou grava tudo, ou nada.
  const gravarLote = db.transaction((cliente, documentos, novoNsu) => {
    const contagem = { entrada: 0, saida: 0, evento: 0, ignorado: 0 }
    for (const doc of documentos) {
      let r = 'ignorado'
      try {
        if (!doc.xml) throw new Error(doc.erroLeitura || 'documento sem XML')
        if (doc.tipo === 'NFSE') r = gravarNota(cliente, doc)
        else if (doc.tipo === 'EVENTO') r = gravarEvento(cliente, doc)
        if (r === 'ignorado') logger.warn('Documento do ADN ignorado', { cnpj: cliente.cnpj, nsu: doc.nsu, tipo: doc.tipo })
      } catch (e) {
        // Um documento ilegível não trava a fila do cliente: fica no log com o NSU e a chave.
        logger.error('Documento do ADN ilegível', { cnpj: cliente.cnpj, nsu: doc.nsu, chave: doc.chave, tipo: doc.tipo, erro: e.message })
      }
      contagem[r]++
    }
    sql.salvarNsu.run(novoNsu, iso(), cliente.id)
    return contagem
  })

  /** Laço de NSU da NFS-e de um cliente. Nunca lança exceção. `forcar` ignora a espera de 1 h. */
  async function capturarCliente(id, { forcar = false } = {}) {
    const cliente = sql.cliente.get(typeof id === 'object' ? id.id : id)
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado' }
    if (!forcar && cliente.nfse_proxima_consulta && new Date(cliente.nfse_proxima_consulta).getTime() > agora().getTime()) {
      return { ok: true, pulado: `próxima consulta em ${cliente.nfse_proxima_consulta}`, docs: 0, notas: 0, eventos: 0 }
    }

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    const resultado = { ok: true, cnpj: cliente.cnpj, docs: 0, notas: 0, eventos: 0, entradas: 0, saidas: 0, ignorados: 0, lotes: 0, cStat: null, erro: null }
    const fechar = () => {
      sql.fecharExecucao.run({ id: execId, fim: iso(), c_stat: resultado.cStat, docs: resultado.docs, notas: resultado.notas, eventos: resultado.eventos, erro: resultado.erro })
      return resultado
    }
    const fimDaFila = () => {
      sql.filaZerada.run(iso(UMA_HORA), iso(), cliente.id)
      return fechar()
    }

    try {
      const adn = fabricaAdn(cliente)
      let nsu = String(cliente.nfse_ult_nsu || '0')
      while (resultado.lotes < MAX_LOTES_POR_CICLO) {
        if (resultado.lotes > 0) await dormir(config.intervaloEntreChamadasMs)
        const r = await adn.consultarLote(nsu)
        if (!r.ok) {
          resultado.ok = false
          resultado.erro = r.erro
          sql.erro.run(iso(), r.erro, cliente.id)
          logger.error('Falha na captura de NFS-e', { cnpj: cliente.cnpj, erro: r.erro })
          return fechar()
        }
        resultado.cStat = r.status
        if (!r.documentos.length) return fimDaFila()
        const novoNsu = r.documentos.reduce((m, d) => maiorNsu(m, d.nsu), nsu)
        const c = gravarLote(cliente, r.documentos, novoNsu)
        resultado.lotes++
        resultado.docs += r.documentos.length
        resultado.entradas += c.entrada
        resultado.saidas += c.saida
        resultado.notas += c.entrada + c.saida
        resultado.eventos += c.evento
        resultado.ignorados += c.ignorado
        nsu = novoNsu
        logger.info('Lote de NFS-e processado', { cnpj: cliente.cnpj, nsu, ...c })
        if (r.documentos.length < tamanhoLote) return fimDaFila()
      }
      logger.warn('Limite de lotes de NFS-e por ciclo atingido; continua no próximo', { cnpj: cliente.cnpj })
      return fechar()
    } catch (e) {
      resultado.ok = false
      resultado.erro = `Erro inesperado: ${e.message}`
      sql.erro.run(iso(), resultado.erro, cliente.id)
      logger.error('Falha na captura de NFS-e', { cnpj: cliente.cnpj, erro: resultado.erro })
      return fechar()
    }
  }

  return { capturarCliente }
}

module.exports = { criarServicoCapturaNfse }
