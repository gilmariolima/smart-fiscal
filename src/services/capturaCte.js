'use strict'

// Captura dos CT-e pelo CTeDistribuicaoDFe (distribuição por NSU com o certificado do cliente).
// Mesmo molde da captura da NFS-e: lotes a partir do último NSU, cada lote numa transação, 1 h de
// espera no fim da fila (137 ou ultNSU = maxNSU) e 1 h de bloqueio no consumo indevido (656).

const { criarArmazenamento, nomes, direcaoPelaChave } = require('./armazenamento')
const { dadosCte, papelDoCliente, dadosEventoCte } = require('./extracaoCte')
const { competenciaDe } = require('./extracao')

const UMA_HORA = 3600e3
const MAX_LOTES_POR_CICLO = 500
const CANCELAMENTO = '110111'

const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))
// NSU guardado sem os zeros à esquerda ('000000000000003' → '3'); o cliente do serviço completa os 15 dígitos.
const nsuCurto = (v) => String(v || '0').replace(/\D/g, '').replace(/^0+(?=\d)/, '') || '0'
const maiorNsu = (a, b) => (Number(nsuCurto(b)) > Number(nsuCurto(a)) ? nsuCurto(b) : nsuCurto(a))
// Primeiro elemento do XML, sem prefixo de namespace (pula a declaração <?xml?> e comentários).
const raizDoXml = (xml) => String(xml || '').match(/<(?![?!])(?:[\w.-]+:)?([\w.-]+)/)?.[1] || null
// A raiz manda (cteProc, procEventoCTe); o schema do docZip só vale quando o XML não tem raiz legível.
function tipoDoDocumento(xml, schema) {
  const raiz = raizDoXml(xml)
  if (raiz) return raiz === 'cteProc' ? 'cte' : raiz === 'procEventoCTe' ? 'evento' : null
  if (/^procCTe_/i.test(schema)) return 'cte'
  if (/^procEventoCTe_/i.test(schema)) return 'evento'
  return null
}
const p2 = (n) =>String(n).padStart(2, '0')
const horaMinuto = (iso) => {
  const d = new Date(iso)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * @param {object} deps
 * @param {Function} deps.fabricaCte (linha de clientes) => cliente do CTeDistribuicaoDFe
 */
function criarServicoCapturaCte({ db, config, logger, fabricaCte, dormir = dormirPadrao, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const iso = (deslocamentoMs = 0) => new Date(agora().getTime() + deslocamentoMs).toISOString()

  const sql = {
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    nota: db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?'),
    inserirNota: db.prepare(`INSERT INTO notas (cliente_id, chave, nsu, tipo, modelo, emitente_cnpj, emitente_nome, emitente_ie, destinatario_cnpj,
        destinatario_nome, numero, serie, data_emissao, valor_total, status, cancelada, caminho_xml, competencia, atualizado_em, criado_em)
      VALUES (@cliente_id, @chave, @nsu, @tipo, 'cte', @emitente_cnpj, @emitente_nome, @emitente_ie, @destinatario_cnpj,
        @destinatario_nome, @numero, @serie, @data_emissao, @valor_total, 'completa', @cancelada, @caminho_xml, @competencia, @atualizado_em, @atualizado_em)`),
    atualizarNota: db.prepare(`UPDATE notas SET tipo = @tipo, emitente_cnpj = @emitente_cnpj, emitente_nome = @emitente_nome, emitente_ie = @emitente_ie,
        destinatario_cnpj = @destinatario_cnpj, destinatario_nome = @destinatario_nome, numero = @numero, serie = @serie, data_emissao = @data_emissao,
        valor_total = @valor_total, caminho_xml = @caminho_xml, competencia = @competencia, cancelada = MAX(cancelada, @cancelada), atualizado_em = @atualizado_em
      WHERE cliente_id = @cliente_id AND chave = @chave`),
    temCancelamento: db.prepare(`SELECT 1 FROM eventos WHERE chave = ? AND tp_evento = '${CANCELAMENTO}' LIMIT 1`),
    marcarCancelada: db.prepare('UPDATE notas SET cancelada = 1, atualizado_em = ? WHERE chave = ?'),
    evento: db.prepare('SELECT id FROM eventos WHERE chave = ? AND tp_evento = ? AND n_seq = ?'),
    inserirEvento: db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo, caminho_xml)
      VALUES (@chave, @tp_evento, @n_seq, @descricao, @data_evento, @protocolo, @caminho_xml)`),
    atualizarEvento: db.prepare(`UPDATE eventos SET descricao = @descricao, data_evento = @data_evento, protocolo = @protocolo, caminho_xml = @caminho_xml
      WHERE id = @id`),
    salvarNsu: db.prepare('UPDATE clientes SET cte_ult_nsu = ?, cte_ultima_consulta = ?, cte_ultimo_erro = NULL WHERE id = ?'),
    filaZerada: db.prepare('UPDATE clientes SET cte_proxima_consulta = ?, cte_ultima_consulta = ?, cte_ultimo_erro = NULL WHERE id = ?'),
    bloquear: db.prepare('UPDATE clientes SET cte_bloqueado_ate = ?, cte_ultima_consulta = ?, cte_ultimo_erro = ? WHERE id = ?'),
    erro: db.prepare('UPDATE clientes SET cte_ultima_consulta = ?, cte_ultimo_erro = ? WHERE id = ?'),
    aviso: db.prepare('UPDATE clientes SET cte_ultimo_erro = ? WHERE id = ?'),
    iniciarExecucao: db.prepare("INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'captura_cte', ?)"),
    marcarCaptura: db.prepare('UPDATE notas SET captura_id = ? WHERE cliente_id = ? AND chave = ?'),
    notasDaCaptura: db.prepare('SELECT COUNT(*) n FROM notas WHERE captura_id = ?'),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, c_stat = @c_stat, x_motivo = @x_motivo, docs_recebidos = @docs, notas_recebidas = @notas,
      eventos_recebidos = @eventos, erro = @erro WHERE id = @id`),
  }

  // Execução de captura em andamento: cada CT-e recebido guarda o id dela (link "Ver notas").
  let capturaAtual = null

  // Só a leitura do XML pode virar "ignorado"; erro de disco ou do banco sobe e desfaz o lote inteiro.
  function ler(cliente, doc, extrair) {
    try {
      return extrair()
    } catch (e) {
      logger.warn('Documento do CT-e ilegível', { cnpj: cliente.cnpj, nsu: doc.nsu, schema: doc.schema, erro: e.message })
      return null
    }
  }

  function gravarCte(cliente, doc) {
    const lido = ler(cliente, doc, () => {
      const d = dadosCte(doc.xml)
      return { d, tipo: d.chave ? papelDoCliente(d, cliente.cnpj) : null }
    })
    if (!lido) return 'ilegivel'
    const { d, tipo } = lido
    if (!d.chave || !tipo) return 'ignorado'
    const caminho = armazenamento.salvar({ cliente, modelo: 'cte', direcao: tipo, competencia: d.competencia, nomeArquivo: nomes.cte(d.chave), xml: doc.xml })
    const dados = {
      cliente_id: cliente.id, chave: d.chave, nsu: doc.nsu, tipo,
      emitente_cnpj: d.emitente?.documento || null, emitente_nome: d.emitente?.nome || null, emitente_ie: d.emitente?.ie || null,
      destinatario_cnpj: d.tomador?.documento || null, destinatario_nome: d.tomador?.nome || null,
      numero: d.numero, serie: d.serie, data_emissao: d.dataEmissao, valor_total: d.valorPrestacao,
      cancelada: sql.temCancelamento.get(d.chave) ? 1 : 0, caminho_xml: caminho, competencia: d.competencia, atualizado_em: iso(),
    }
    if (sql.nota.get(cliente.id, d.chave)) sql.atualizarNota.run(dados)
    else sql.inserirNota.run(dados)
    if (capturaAtual) sql.marcarCaptura.run(capturaAtual, cliente.id, d.chave)
    return tipo
  }

  function gravarEvento(cliente, doc) {
    const e = ler(cliente, doc, () => dadosEventoCte(doc.xml))
    if (!e) return 'ilegivel'
    if (!e.chave || !e.tpEvento) return 'ignorado'
    const nota = sql.nota.get(cliente.id, e.chave)
    const caminho = armazenamento.salvar({
      cliente,
      modelo: 'cte',
      direcao: nota?.tipo || direcaoPelaChave(e.chave, cliente.cnpj),
      competencia: nota?.competencia || competenciaDe(e.dataEvento),
      categoria: 'evento',
      nomeArquivo: nomes.evento(e.chave, e.tpEvento, e.nSeq),
      xml: doc.xml,
    })
    const campos = { chave: e.chave, tp_evento: e.tpEvento, n_seq: e.nSeq, descricao: e.descricao, data_evento: e.dataEvento, protocolo: e.protocolo, caminho_xml: caminho }
    const existente = sql.evento.get(e.chave, e.tpEvento, e.nSeq)
    if (existente) sql.atualizarEvento.run({ ...campos, id: existente.id })
    else sql.inserirEvento.run(campos)
    // Cancela o CT-e em todos os clientes que o têm; o que chegar depois vê o evento em temCancelamento.
    if (e.tpEvento === CANCELAMENTO) sql.marcarCancelada.run(iso(), e.chave)
    return 'evento'
  }

  // Documentos do lote + NSU novo numa transação: ou grava tudo, ou nada.
  const gravarLote = db.transaction((cliente, documentos, novoNsu, execId) => {
    const contagem = { entrada: 0, saida: 0, outro: 0, evento: 0, ignorado: 0 }
    capturaAtual = execId
    try {
      for (const doc of documentos) {
        const schema = String(doc.schema || '')
        let r = 'ignorado'
        if (!doc.xml) {
          // Um docZip ilegível não trava a fila do cliente: fica no log com o NSU.
          logger.warn('Documento do CT-e ilegível', { cnpj: cliente.cnpj, nsu: doc.nsu, schema, erro: doc.erroLeitura || 'documento sem XML' })
          contagem.ignorado++
          continue
        }
        const tipo = tipoDoDocumento(doc.xml, schema)
        if (tipo === 'cte') r = gravarCte(cliente, doc)
        else if (tipo === 'evento') r = gravarEvento(cliente, doc)
        // cteOSProc, GTVe, resumos etc. não entram nesta versão.
        if (r === 'ignorado') logger.warn('Documento do CT-e ignorado', { cnpj: cliente.cnpj, nsu: doc.nsu, schema, raiz: raizDoXml(doc.xml) })
        contagem[r === 'ilegivel' ? 'ignorado' : r]++
      }
    } finally {
      capturaAtual = null
    }
    sql.salvarNsu.run(novoNsu, iso(), cliente.id)
    return contagem
  })

  // O bloqueio do 656 vale sempre; a espera de 1 h pode ser ignorada com `forcar`.
  function emEspera(cliente, forcar) {
    const t = agora().getTime()
    if (cliente.cte_bloqueado_ate && new Date(cliente.cte_bloqueado_ate).getTime() > t) return `bloqueado até ${cliente.cte_bloqueado_ate}`
    if (!forcar && cliente.cte_proxima_consulta && new Date(cliente.cte_proxima_consulta).getTime() > t) return `próxima consulta em ${cliente.cte_proxima_consulta}`
    return null
  }

  /** Laço de NSU do CT-e de um cliente. Nunca lança exceção. `forcar` ignora a espera de 1 h, nunca o 656. */
  async function capturarCliente(id, { forcar = false } = {}) {
    const cliente = sql.cliente.get(typeof id === 'object' ? id.id : id)
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado' }
    const espera = emEspera(cliente, forcar)
    if (espera) {
      logger.info('Captura de CT-e pulada', { cnpj: cliente.cnpj, motivo: espera })
      return { ok: true, cnpj: cliente.cnpj, pulado: espera, docs: 0, notas: 0, eventos: 0 }
    }

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    const resultado = { ok: true, cnpj: cliente.cnpj, docs: 0, notas: 0, eventos: 0, entradas: 0, saidas: 0, outros: 0, ignorados: 0, lotes: 0, cStat: null, erro: null }
    let xMotivo = null
    const fechar = () => {
      // O mesmo CT-e repetido no lote conta uma vez.
      resultado.notas = sql.notasDaCaptura.get(execId).n
      if (resultado.ok && resultado.aviso) sql.aviso.run(resultado.aviso, cliente.id)
      sql.fecharExecucao.run({ id: execId, fim: iso(), c_stat: resultado.cStat, x_motivo: xMotivo, docs: resultado.docs, notas: resultado.notas, eventos: resultado.eventos, erro: resultado.erro })
      return resultado
    }
    const fimDaFila = () => {
      sql.filaZerada.run(iso(UMA_HORA), iso(), cliente.id)
      return fechar()
    }
    const falhar = (mensagem) => {
      resultado.ok = false
      resultado.erro = mensagem
      sql.erro.run(iso(), mensagem, cliente.id)
      logger.error('Falha na captura de CT-e', { cnpj: cliente.cnpj, erro: mensagem })
      return fechar()
    }

    try {
      const servico = fabricaCte(cliente)
      let nsu = nsuCurto(cliente.cte_ult_nsu)
      while (resultado.lotes < MAX_LOTES_POR_CICLO) {
        if (resultado.lotes > 0) await dormir(config.intervaloEntreChamadasMs)
        const r = await servico.consultarLote(nsu)
        resultado.cStat = r.cStat ? String(r.cStat) : null
        xMotivo = r.xMotivo || null

        if (resultado.cStat === '656') {
          const ate = iso(UMA_HORA)
          resultado.ok = false
          resultado.erro = `Bloqueado até ${horaMinuto(ate)} (${`656 ${xMotivo || ''}`.trim()})`
          sql.bloquear.run(ate, iso(), resultado.erro, cliente.id)
          logger.warn('Consumo indevido do CT-e (656): cliente bloqueado por 1 h', { cnpj: cliente.cnpj, xMotivo, ultNSU: r.ultNSU, maxNSU: r.maxNSU })
          return fechar()
        }
        if (!r.ok) return falhar(r.erro || `cStat ${resultado.cStat || '?'} ${xMotivo || ''}`.trim())

        // 138 sem docZip legível: não grava o NSU, senão os documentos daquele trecho se perdem.
        if (resultado.cStat === '138' && !r.documentos.length) return falhar('SEFAZ devolveu 138 sem documentos legíveis')
        if (resultado.cStat === '137' || !r.documentos.length) {
          // A SEFAZ pode devolver um ultNSU maior mesmo sem documentos: a fila nunca volta.
          if (r.ultNSU && Number(nsuCurto(r.ultNSU)) > Number(nsu)) sql.salvarNsu.run(nsuCurto(r.ultNSU), iso(), cliente.id)
          return fimDaFila()
        }

        const novoNsu = r.documentos.reduce((m, d) => maiorNsu(m, d.nsu), maiorNsu(nsu, r.ultNSU))
        if (Number(novoNsu) <= Number(nsu)) return falhar(`SEFAZ devolveu ultNSU ${novoNsu} sem avançar de ${nsu}`)
        let c
        try {
          c = gravarLote(cliente, r.documentos, novoNsu, execId)
        } catch (e) {
          // Disco (EACCES, ENOSPC) ou banco: a transação desfez o lote e o NSU fica onde estava (tenta no próximo ciclo).
          return falhar(`Erro ao gravar o lote do CT-e (NSU ${nsu}): ${e.code && !e.message.includes(e.code) ? `${e.code} ` : ''}${e.message}`)
        }
        // Lote lido mas sem nada aproveitável: o NSU avança, com aviso na tela.
        if (c.ignorado === r.documentos.length) resultado.aviso = `Lote sem CT-e reconhecido (${c.ignorado} documentos ignorados)`
        resultado.lotes++
        resultado.docs += r.documentos.length
        resultado.entradas += c.entrada
        resultado.saidas += c.saida
        resultado.outros += c.outro
        resultado.notas += c.entrada + c.saida + c.outro
        resultado.eventos += c.evento
        resultado.ignorados += c.ignorado
        nsu = novoNsu
        logger.info('Lote de CT-e processado', { cnpj: cliente.cnpj, nsu, maxNSU: r.maxNSU, ...c })
        if (!r.maxNSU || Number(nsu) >= Number(nsuCurto(r.maxNSU))) return fimDaFila()
      }
      logger.warn('Limite de lotes de CT-e por ciclo atingido; continua no próximo', { cnpj: cliente.cnpj })
      return fechar()
    } catch (e) {
      return falhar(`Erro inesperado: ${e.message}`)
    }
  }

  return { capturarCliente }
}

module.exports = { criarServicoCapturaCte }
