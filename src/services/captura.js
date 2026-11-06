'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { tipoDocumento } = require('../sefaz/client')
const { criarArmazenamento, caminhoDoPdf, pastaDoClienteNoDisco, pastasDoClienteNoBanco, pastasPendentesDoCliente, PASTAS, nomes, direcaoPelaChave, modeloPelaChave } = require('./armazenamento')
const { dadosResNFe, dadosNfeProc, dadosEvento, competenciaDe } = require('./extracao')
const { DA_CARTEIRA } = require('./clientes')
const { VERSAO_XML } = require('./migracaoPastas')
const { xmlParaJson } = require('../sefaz/xml')

const UMA_HORA = 3600e3
const MAX_LOTES_POR_CICLO = 500 // trava de segurança: 500 lotes x 50 docs
const CANCELAMENTO = '110111'

const nsu15 = (v) => String(v || '0').replace(/\D/g, '').padStart(15, '0').slice(-15)
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))
// Arquivo a arquivo pela rede: entre um e outro, a janela responde.
const cederAVez = () => new Promise((r) => setImmediate(r))

/**
 * Serviço de captura por NSU (NFeDistribuicaoDFe).
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {object} deps.config   obterConfig() (usa pastaXmls e intervaloEntreChamadasMs)
 * @param {object} deps.logger
 * @param {Function} deps.fabricaSefaz (clienteRow) => cliente SEFAZ
 * @param {Function} [deps.dormir]  pausa entre chamadas (injetável nos testes)
 * @param {Function} [deps.agora]   relógio (injetável nos testes)
 */
function criarServicoCaptura({ db, config, logger, fabricaSefaz, dormir = dormirPadrao, agora = () => new Date(), deveParar = () => false }) {
  const armazenamento = criarArmazenamento({ config, db })
  const iso = (deslocamentoMs = 0) => new Date(agora().getTime() + deslocamentoMs).toISOString()

  const sql = {
    nota: db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?'),
    primeiroDono: db.prepare('SELECT cliente_id FROM notas WHERE chave = ? ORDER BY id LIMIT 1'),
    temCancelamento: db.prepare(`SELECT 1 FROM eventos WHERE chave = ? AND tp_evento = '${CANCELAMENTO}' LIMIT 1`),
    inserirNota: db.prepare(`INSERT INTO notas (cliente_id, chave, nsu, tipo, emitente_cnpj, emitente_nome, emitente_ie,
        destinatario_cnpj, destinatario_nome, numero, serie, data_emissao, valor_total, tipo_nf, situacao_sefaz, status, cancelada,
        caminho_xml, competencia, atualizado_em, criado_em)
      VALUES (@cliente_id, @chave, @nsu, @tipo, @emitente_cnpj, @emitente_nome, @emitente_ie,
        @destinatario_cnpj, @destinatario_nome, @numero, @serie, @data_emissao, @valor_total, @tipo_nf, @situacao_sefaz, @status, @cancelada,
        @caminho_xml, @competencia, @atualizado_em, @atualizado_em)`),
    atualizarSituacao: db.prepare(`UPDATE notas SET situacao_sefaz = @situacao_sefaz,
        cancelada = MAX(cancelada, @cancelada), atualizado_em = @atualizado_em WHERE cliente_id = @cliente_id AND chave = @chave`),
    completarNota: db.prepare(`UPDATE notas SET status = 'completa', emitente_cnpj = COALESCE(@emitente_cnpj, emitente_cnpj),
        emitente_nome = COALESCE(@emitente_nome, emitente_nome), emitente_ie = COALESCE(@emitente_ie, emitente_ie),
        destinatario_cnpj = COALESCE(@destinatario_cnpj, destinatario_cnpj),
        destinatario_nome = COALESCE(@destinatario_nome, destinatario_nome),
        numero = COALESCE(@numero, numero), serie = COALESCE(@serie, serie), data_emissao = COALESCE(@data_emissao, data_emissao),
        valor_total = COALESCE(@valor_total, valor_total), tipo_nf = COALESCE(@tipo_nf, tipo_nf),
        competencia = COALESCE(@competencia, competencia), caminho_xml = @caminho_xml,
        cancelada = MAX(cancelada, @cancelada), atualizado_em = @atualizado_em WHERE cliente_id = @cliente_id AND chave = @chave`),
    evento: db.prepare('SELECT * FROM eventos WHERE chave = ? AND tp_evento = ? AND n_seq = ?'),
    inserirEvento: db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo, caminho_xml)
      VALUES (@chave, @tp_evento, @n_seq, @descricao, @data_evento, @protocolo, @caminho_xml)`),
    atualizarEvento: db.prepare(`UPDATE eventos SET descricao = COALESCE(@descricao, descricao), data_evento = COALESCE(@data_evento, data_evento),
      protocolo = COALESCE(@protocolo, protocolo), caminho_xml = @caminho_xml WHERE id = @id`),
    // Cancelamento vale para todas as cópias da nota (uma por cliente).
    marcarCancelada: db.prepare(`UPDATE notas SET cancelada = 1, atualizado_em = ? WHERE chave = ?`),
    salvarNsu: db.prepare(`UPDATE clientes SET ult_nsu = @ult_nsu, max_nsu = @max_nsu, ultima_consulta = @agora,
      ultimo_erro = NULL WHERE id = @id`),
    marcarCliente: db.prepare(`UPDATE clientes SET ult_nsu = COALESCE(@ult_nsu, ult_nsu), max_nsu = COALESCE(@max_nsu, max_nsu),
      proxima_consulta = COALESCE(@proxima_consulta, proxima_consulta), bloqueado_ate = COALESCE(@bloqueado_ate, bloqueado_ate),
      ultima_consulta = @agora, ultimo_erro = @ultimo_erro WHERE id = @id`),
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    clientesAtivos: db.prepare("SELECT * FROM clientes WHERE ativo = 1 AND cert_arquivo <> '' ORDER BY id"),
    clientePorCnpj: db.prepare('SELECT * FROM clientes WHERE cnpj = ?'),
    // Encaminhamento do escritório: CNPJ exato (filial é outro cliente); inativo também recebe a nota.
    clienteDaCarteira: db.prepare(`SELECT * FROM clientes WHERE cnpj = ? AND ${DA_CARTEIRA}`),
    iniciarExecucao: db.prepare(`INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'captura', ?)`),
    docsAteAgora: db.prepare('UPDATE execucoes SET docs_recebidos = ? WHERE id = ?'),
    marcarCaptura: db.prepare('UPDATE notas SET captura_id = ? WHERE cliente_id = ? AND chave = ?'),
    notasDaCaptura: db.prepare('SELECT COUNT(*) n FROM notas WHERE captura_id = ?'),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, c_stat = @c_stat, x_motivo = @x_motivo,
      docs_recebidos = @docs_recebidos, notas_recebidas = @notas_recebidas, eventos_recebidos = @eventos_recebidos,
      erro = @erro WHERE id = @id`),
  }

  function processarResumo(cliente, doc) {
    const d = dadosResNFe(doc.json)
    if (!d.chave) return 'ignorado'
    const existente = sql.nota.get(cliente.id, d.chave)
    // Com a nota completa, o resumo não serve mais: não volta para a pasta.
    if (existente?.status !== 'completa') armazenamento.salvar({ cliente, competencia: existente?.competencia || d.competencia, categoria: 'resumo', nomeArquivo: nomes.resumo(d.chave), xml: doc.xml })
    const cancelada = d.situacao_sefaz === '3' || !!sql.temCancelamento.get(d.chave) ? 1 : 0
    if (existente) {
      // Nunca rebaixa o status: só atualiza a situação informada pela SEFAZ.
      sql.atualizarSituacao.run({ cliente_id: cliente.id, chave: d.chave, situacao_sefaz: d.situacao_sefaz, cancelada, atualizado_em: iso() })
      marcarCaptura(cliente, d.chave)
      return 'resumo'
    }
    const { competencia, ...campos } = d
    sql.inserirNota.run({
      ...campos, competencia, cliente_id: cliente.id, nsu: doc.nsu, tipo: 'entrada', destinatario_cnpj: null, destinatario_nome: null,
      status: 'resumo', cancelada, caminho_xml: null, atualizado_em: iso(),
    })
    marcarCaptura(cliente, d.chave)
    return 'resumo'
  }

  // Execução de captura em andamento: cada nota recebida guarda o id dela (o resumo e o XML da mesma nota contam uma vez).
  let capturaAtual = null
  const marcarCaptura = (cliente, chave) => capturaAtual && sql.marcarCaptura.run(capturaAtual, cliente.id, chave)

  /** Grava o procNFe como nota completa do cliente (cria a linha ou completa a que já existe). */
  function gravarCompleta(cliente, doc, d, tipo, contagem) {
    const existente = sql.nota.get(cliente.id, d.chave)
    const competencia = d.competencia || existente?.competencia
    const caminho = armazenamento.salvar({ cliente, competencia, direcao: tipo, nomeArquivo: nomes.nfe(d.chave), xml: doc.xml })
    const cancelada = sql.temCancelamento.get(d.chave) ? 1 : 0
    const dados = { ...d, competencia, cliente_id: cliente.id, caminho_xml: caminho, cancelada, atualizado_em: iso() }
    if (existente) sql.completarNota.run(dados)
    else sql.inserirNota.run({ ...dados, tipo, nsu: doc.nsu, situacao_sefaz: null, status: 'completa' })
    try {
      armazenamento.tirarResumo(caminho)
    } catch (e) {
      logger.warn('Resumo da nota completa não saiu da pasta', { chave: d.chave, erro: e.code || e.message })
    }
    marcarCaptura(cliente, d.chave)
    if (tipo === 'saida' && contagem) contagem.saida++
  }

  function processarCompleta(cliente, doc, contagem) {
    const d = dadosNfeProc(doc.json)
    if (!d.chave) return 'ignorado'
    gravarCompleta(cliente, doc, d, d.emitente_cnpj === cliente.cnpj ? 'saida' : 'entrada', contagem)
    return 'completa'
  }

  // procNFe recebido pelo certificado do escritório (autXML): vai para o emitente (saída) e/ou o destinatário (entrada).
  function encaminharCompleta(escritorio, doc, contagem) {
    const d = dadosNfeProc(doc.json)
    if (!d.chave) return 'ignorado'
    const emitente = d.emitente_cnpj ? sql.clienteDaCarteira.get(d.emitente_cnpj) : null
    const destinatario = d.destinatario_cnpj ? sql.clienteDaCarteira.get(d.destinatario_cnpj) : null
    if (!emitente && !destinatario) {
      armazenamento.salvar({ cliente: escritorio, foraDaCarteira: true, competencia: d.competencia, nomeArquivo: nomes.nfe(d.chave), xml: doc.xml })
      return 'fora'
    }
    if (emitente) gravarCompleta(emitente, doc, d, 'saida', contagem)
    if (destinatario && destinatario.id !== emitente?.id) gravarCompleta(destinatario, doc, d, 'entrada', contagem)
    return 'completa'
  }

  /** `dono` é o cliente em cuja pasta fica o XML do evento. */
  function processarEvento(dono, e, doc) {
    const nota = sql.nota.get(dono.id, e.chave)
    const existente = sql.evento.get(e.chave, e.tp_evento, e.n_seq)
    // O procEventoNFe (completo) tem prioridade: um resEvento depois não sobrescreve o arquivo.
    const manterArquivo = existente?.caminho_xml && !e.completo
    const caminho = manterArquivo
      ? existente.caminho_xml
      : armazenamento.salvar({
          cliente: dono,
          competencia: nota?.competencia || competenciaDe(e.data_evento),
          modelo: modeloPelaChave(e.chave),
          direcao: nota?.tipo || direcaoPelaChave(e.chave, dono.cnpj),
          categoria: 'evento',
          nomeArquivo: nomes.evento(e.chave, e.tp_evento, e.n_seq),
          xml: doc.xml,
        })
    const { completo, ...campos } = e
    if (existente) sql.atualizarEvento.run({ ...campos, caminho_xml: caminho, id: existente.id })
    else sql.inserirEvento.run({ ...campos, caminho_xml: caminho })
    if (e.tp_evento === CANCELAMENTO) sql.marcarCancelada.run(iso(), e.chave)
    return 'evento'
  }

  function eventoDoDocumento(doc) {
    const e = dadosEvento(doc.json)
    return e.chave && e.tp_evento ? e : null
  }

  function processarDoCliente(cliente, doc, tipo, contagem) {
    if (tipo === 'resNFe') return processarResumo(cliente, doc)
    if (tipo === 'procNFe') return processarCompleta(cliente, doc, contagem)
    const e = eventoDoDocumento(doc)
    return e ? processarEvento(cliente, e, doc) : 'ignorado'
  }

  function processarDoEscritorio(escritorio, doc, tipo, contagem) {
    // Nota destinada ao próprio escritório: só fica quando ele também é cliente.
    if (tipo === 'resNFe') return escritorio.tambem_cliente ? processarResumo(escritorio, doc) : 'ignorado'
    if (tipo === 'procNFe') return encaminharCompleta(escritorio, doc, contagem)
    const e = eventoDoDocumento(doc)
    if (!e) return 'ignorado'
    // O XML do evento fica na pasta do primeiro cliente que tem a nota; sem nota, na do escritório.
    const dono = sql.primeiroDono.get(e.chave)
    return processarEvento(dono ? sql.cliente.get(dono.cliente_id) : escritorio, e, doc)
  }

  const TIPOS_CONHECIDOS = ['resNFe', 'procNFe', 'procEventoNFe', 'resEvento']

  /**
   * Grava um documento do docZip conforme o papel da linha ('cliente' ou 'escritorio').
   * Devolve 'resumo' | 'completa' | 'evento' | 'ignorado' | 'fora'.
   * `contagem.saida` (opcional) soma as notas de saída gravadas.
   */
  function processarDocumento(linha, doc, contagem = null) {
    const tipo = tipoDocumento(doc.schema)
    if (!TIPOS_CONHECIDOS.includes(tipo)) {
      logger.warn('Documento de tipo desconhecido ignorado', { cnpj: linha.cnpj, nsu: doc.nsu, schema: doc.schema })
      return 'ignorado'
    }
    return linha.papel === 'escritorio'
      ? processarDoEscritorio(linha, doc, tipo, contagem)
      : processarDoCliente(linha, doc, tipo, contagem)
  }

  // Documentos do lote + novo ultNSU numa única transação: ou grava tudo, ou nada.
  const gravarLote = db.transaction((cliente, dados, execId) => {
    const contagem = { resumo: 0, completa: 0, evento: 0, ignorado: 0, fora: 0, saida: 0 }
    capturaAtual = execId
    try {
      for (const doc of dados.docZip || []) contagem[processarDocumento(cliente, doc, contagem)]++
    } finally {
      capturaAtual = null
    }
    sql.salvarNsu.run({ id: cliente.id, ult_nsu: nsu15(dados.ultNSU), max_nsu: nsu15(dados.maxNSU), agora: iso() })
    return contagem
  })

  // O bloqueio do 656 vale sempre; a espera do 137 pode ser ignorada com `forcar`.
  function emEspera(cliente, forcar) {
    const t = agora().getTime()
    if (cliente.bloqueado_ate && new Date(cliente.bloqueado_ate).getTime() > t) return `bloqueado até ${cliente.bloqueado_ate}`
    if (!forcar && cliente.proxima_consulta && new Date(cliente.proxima_consulta).getTime() > t) return `próxima consulta em ${cliente.proxima_consulta}`
    return null
  }

  /**
   * Laço de NSU de um cliente. Nunca lança exceção.
   * `forcar` ignora a espera de 1 h (proxima_consulta), nunca o bloqueio do 656.
   */
  async function capturarCliente(clienteOuId, { forcar = false } = {}) {
    const cliente = typeof clienteOuId === 'object' ? sql.cliente.get(clienteOuId.id) : sql.cliente.get(clienteOuId)
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado' }

    const espera = emEspera(cliente, forcar)
    if (espera) {
      logger.info('Captura pulada', { cnpj: cliente.cnpj, motivo: espera })
      return { ok: true, pulado: espera, docs: 0 }
    }

    if (deveParar()) return { ok: true, cnpj: cliente.cnpj, pulado: 'app fechando', docs: 0, notas: 0, eventos: 0 }

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    const resultado = { ok: true, cnpj: cliente.cnpj, docs: 0, lotes: 0, resumo: 0, completa: 0, evento: 0, ignorado: 0, fora: 0, saida: 0, cStat: null, xMotivo: null, erro: null }
    const fechar = () => {
      sql.fecharExecucao.run({
        id: execId, fim: iso(), c_stat: resultado.cStat, x_motivo: resultado.xMotivo, docs_recebidos: resultado.docs,
        notas_recebidas: sql.notasDaCaptura.get(execId).n + resultado.fora, eventos_recebidos: resultado.evento, erro: resultado.erro,
      })
      return resultado
    }
    const falhar = (mensagem, extra = {}) => {
      resultado.ok = false
      resultado.erro = mensagem
      sql.marcarCliente.run({ id: cliente.id, ult_nsu: null, max_nsu: null, proxima_consulta: null, bloqueado_ate: null, agora: iso(), ultimo_erro: mensagem, ...extra })
      logger.error('Falha na captura', { cnpj: cliente.cnpj, erro: mensagem })
      return fechar()
    }

    try {
      const sefaz = fabricaSefaz(cliente)
      let ultNSU = nsu15(cliente.ult_nsu)
      while (resultado.lotes < MAX_LOTES_POR_CICLO) {
        if (resultado.lotes > 0) await dormir(config.intervaloEntreChamadasMs)
        if (deveParar()) {
          logger.info('Captura interrompida: app fechando; continua na próxima', { cnpj: cliente.cnpj, ultNSU })
          return fechar()
        }
        const r = await sefaz.consultaUltNSU(ultNSU)
        if (r.error) return falhar(`Erro na consulta: ${r.error}`)

        const dados = r.data || {}
        resultado.cStat = String(dados.cStat || '')
        resultado.xMotivo = dados.xMotivo || null

        if (resultado.cStat === '138') {
          const novoUlt = nsu15(dados.ultNSU)
          if (novoUlt <= ultNSU) return falhar(`SEFAZ devolveu ultNSU ${novoUlt} sem avançar de ${ultNSU}`)
          const contagem = gravarLote(cliente, dados, execId)
          resultado.lotes++
          resultado.docs += (dados.docZip || []).length
          sql.docsAteAgora.run(resultado.docs, execId)
          for (const k of Object.keys(contagem)) resultado[k] += contagem[k]
          ultNSU = novoUlt
          logger.info('Lote processado', { cnpj: cliente.cnpj, ultNSU, maxNSU: dados.maxNSU, ...contagem })
          if (ultNSU >= nsu15(dados.maxNSU)) {
            // Fila zerada: a SEFAZ pede 1 h de espera antes de consultar de novo.
            sql.marcarCliente.run({ id: cliente.id, ult_nsu: null, max_nsu: null, proxima_consulta: iso(UMA_HORA), bloqueado_ate: null, agora: iso(), ultimo_erro: null })
            return fechar()
          }
          continue
        }

        if (resultado.cStat === '137') {
          const ultSefaz = dados.ultNSU ? nsu15(dados.ultNSU) : null
          sql.marcarCliente.run({
            id: cliente.id,
            ult_nsu: ultSefaz && ultSefaz > ultNSU ? ultSefaz : null,
            max_nsu: dados.maxNSU ? nsu15(dados.maxNSU) : null,
            proxima_consulta: iso(UMA_HORA),
            bloqueado_ate: null,
            agora: iso(),
            ultimo_erro: null,
          })
          logger.info('Nenhum documento novo', { cnpj: cliente.cnpj, ultNSU })
          return fechar()
        }

        if (resultado.cStat === '656') {
          resultado.ok = false
          resultado.erro = `656 ${resultado.xMotivo || 'Consumo indevido'}`
          sql.marcarCliente.run({ id: cliente.id, ult_nsu: null, max_nsu: null, proxima_consulta: null, bloqueado_ate: iso(UMA_HORA), agora: iso(), ultimo_erro: resultado.erro })
          logger.warn('Consumo indevido (656): cliente bloqueado por 1 h', { cnpj: cliente.cnpj })
          return fechar()
        }

        return falhar(`cStat ${resultado.cStat || '?'} ${resultado.xMotivo || ''}`.trim())
      }
      logger.warn('Limite de lotes por ciclo atingido; continua no próximo ciclo', { cnpj: cliente.cnpj, lotes: resultado.lotes })
      return fechar()
    } catch (e) {
      return falhar(`Erro inesperado: ${e.message}`)
    }
  }

  /** Captura de todos os clientes ativos (ou de um CNPJ), um por vez. Um erro não para os outros. */
  async function capturarTodos({ cnpj, forcar = false } = {}) {
    const clientes = cnpj ? [sql.clientePorCnpj.get(cnpj)].filter(Boolean) : sql.clientesAtivos.all()
    const resultados = []
    for (const cliente of clientes) {
      try {
        resultados.push({ cnpj: cliente.cnpj, ...(await capturarCliente(cliente, { forcar })) })
      } catch (e) {
        logger.error('Erro inesperado ao capturar cliente', { cnpj: cliente.cnpj, erro: e.message })
        resultados.push({ cnpj: cliente.cnpj, ok: false, erro: e.message })
      }
    }
    return resultados
  }

  // A pasta do escritório pode estar com o nome antigo, se ainda não foi renomeada.
  function pastasForaDaCarteira(escritorio) {
    const todos = db.prepare('SELECT cnpj, papel, apelido, razao_social FROM clientes').all()
    const nomesDaPasta = new Set([pastaDoClienteNoDisco(escritorio, todos), ...pastasDoClienteNoBanco(db, escritorio.id), ...pastasPendentesDoCliente(db, escritorio.id)])
    return [...nomesDaPasta].map((nome) => armazenamento.absoluto(path.join(nome, PASTAS.foraDaCarteira))).filter((d) => fs.existsSync(d))
  }

  // Tira o arquivo e as pastas que ficaram vazias, até a das notas sem cliente. A nota já está com o dono: arquivo preso só sobra aqui.
  function tirarDaPastaSemCliente(arquivo, raiz) {
    try {
      fs.rmSync(arquivo, { force: true })
      for (let d = path.dirname(arquivo); d !== path.dirname(raiz); d = path.dirname(d)) fs.rmdirSync(d)
    } catch (e) {
      if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') logger.warn('Arquivo das notas sem cliente não saiu da pasta', { arquivo: path.basename(arquivo), erro: e.code || e.message })
    }
  }

  // Quem é emitente ou destinatário e está cadastrado.
  function clientesDaNota(d) {
    return [d.emitente_cnpj, d.destinatario_cnpj].map((c) => c && sql.clienteDaCarteira.get(c)).filter(Boolean)
  }

  // O XML guardado é do dono: linha no banco e arquivo no disco.
  function estaComODono(chave, donos) {
    return donos.some((c) => {
      const n = sql.nota.get(c.id, chave)
      if (!n?.caminho_xml) return false
      try {
        return fs.statSync(armazenamento.absoluto(n.caminho_xml)).size > 0
      } catch {
        return false
      }
    })
  }

  async function resgatarDeForaDaCarteira(escritorio, resultado) {
    for (const raiz of pastasForaDaCarteira(escritorio)) {
      for (const item of fs.readdirSync(raiz, { recursive: true, withFileTypes: true })) {
        if (!item.isFile() || !/-nfe\.xml$/i.test(item.name)) continue
        await cederAVez()
        const arquivo = path.join(item.parentPath, item.name)
        try {
          const xml = fs.readFileSync(arquivo, 'utf8')
          const json = xmlParaJson(xml)
          const d = dadosNfeProc(json)
          if (!d.chave) continue
          const donos = clientesDaNota(d)
          if (!donos.length) {
            resultado.semDono++
            continue
          }
          if (estaComODono(d.chave, donos)) {
            tirarDaPastaSemCliente(arquivo, raiz)
            resultado.copias++
            continue
          }
          // Está no banco em outra empresa: a correção das notas já cuidou do que era do escritório; aqui não se decide.
          if (db.prepare('SELECT 1 FROM notas WHERE chave = ? AND caminho_xml IS NOT NULL LIMIT 1').get(d.chave)) continue
          encaminharCompleta(escritorio, { xml, json, nsu: null }, { saida: 0 })
          if (!estaComODono(d.chave, donos)) throw new Error('nota não gravada')
          tirarDaPastaSemCliente(arquivo, raiz)
          resultado.resgatadas++
        } catch (e) {
          resultado.falhas++
          logger.warn('Nota sem cliente não levada; tenta de novo na próxima abertura', { arquivo: item.name, erro: e.code || e.message })
        }
      }
    }
  }

  // Sobra de quando o escritório estava cadastrado como cliente: a nota recebida pelo autXML foi gravada como entrada dele.
  function retirarGeradosDoMes(pasta) {
    const absoluta = armazenamento.absoluto(pasta)
    let nomesNaPasta = []
    try {
      nomesNaPasta = fs.readdirSync(absoluta)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const nome of nomesNaPasta) {
      if (/^Relatorio .*\.(xlsx|pdf)$/i.test(nome) || /\.zip$/i.test(nome)) fs.rmSync(path.join(absoluta, nome), { force: true })
    }
    // Só saem as que ficaram vazias, de dentro para fora.
    for (const d of [path.join(absoluta, 'PDF'), path.join(absoluta, 'XML'), absoluta, path.dirname(absoluta)]) {
      try {
        fs.rmdirSync(d)
      } catch {}
    }
  }

  /**
   * Uma vez, depois que existe o escritório: a NF-e dele em que ele não é emitente nem destinatário vai para quem é, como na captura.
   * Banco e arquivo novos primeiro; só depois sai do escritório. O que falhar tenta de novo na próxima abertura.
   * Depois, as notas da pasta Sem cliente cadastrado que já têm cliente vão para ele, e a cópia de quem já está com o dono sai. A pasta vazia some.
   * @returns {{ movidas: number, resgatadas: number, copias: number, semDono: number, falhas: number }}
   */
  async function corrigirNotasDoEscritorio() {
    const resultado = { movidas: 0, resgatadas: 0, copias: 0, semDono: 0, falhas: 0 }
    const escritorio = db.prepare("SELECT * FROM clientes WHERE papel = 'escritorio'").get()
    const valor = (chave) => db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(chave)
    if (!escritorio || valor('notas_escritorio_corrigidas') || valor('pastas_layout') !== VERSAO_XML || !fs.existsSync(config.pastaXmls)) return resultado

    const apagarNota = db.prepare('DELETE FROM notas WHERE id = ?')
    const meses = new Map()
    for (const n of db.prepare("SELECT * FROM notas WHERE cliente_id = ? AND modelo = 'nfe' AND status = 'completa' AND caminho_xml IS NOT NULL").all(escritorio.id)) {
      await cederAVez()
      try {
        const xml = fs.readFileSync(armazenamento.absoluto(n.caminho_xml), 'utf8')
        const json = xmlParaJson(xml)
        const d = dadosNfeProc(json)
        if (!d.chave || d.emitente_cnpj === escritorio.cnpj || d.destinatario_cnpj === escritorio.cnpj) continue
        const temDono = [d.emitente_cnpj, d.destinatario_cnpj].some((c) => c && sql.clienteDaCarteira.get(c))
        if (!temDono) {
          resultado.semDono++
          continue
        }
        encaminharCompleta(escritorio, { xml, json, nsu: n.nsu }, { saida: 0 })
        apagarNota.run(n.id)
        resultado.movidas++
        meses.set(`${n.competencia}|${n.tipo}`, { competencia: n.competencia, tipo: n.tipo, pasta: path.dirname(path.dirname(n.caminho_xml)) })
        // A nota já está com o dono: arquivo preso só sobra aqui.
        try {
          fs.rmSync(armazenamento.absoluto(n.caminho_xml), { force: true })
          const pdf = caminhoDoPdf(n.caminho_xml)
          if (pdf) fs.rmSync(armazenamento.absoluto(pdf), { force: true })
        } catch (e) {
          logger.warn('Arquivo da nota corrigida não saiu da pasta do escritório', { chave: n.chave, erro: e.code || e.message })
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          logger.warn('Nota do escritório sem o XML no disco: fica como está', { chave: n.chave })
          continue
        }
        resultado.falhas++
        logger.warn('Nota do escritório não corrigida; tenta de novo na próxima abertura', { chave: n.chave, erro: e.code || e.message })
      }
    }

    const restantes = db.prepare("SELECT COUNT(*) n FROM notas WHERE cliente_id = ? AND modelo = 'nfe' AND competencia = ? AND COALESCE(tipo, 'entrada') = ? AND status = 'completa'").pluck()
    const apagarGrupo = db.prepare("DELETE FROM pasta_grupos WHERE cliente_id = ? AND competencia = ? AND modelo = 'nfe' AND direcao = ?")
    for (const m of meses.values()) {
      const direcao = m.tipo || 'entrada'
      if (restantes.get(escritorio.id, m.competencia, direcao)) continue
      apagarGrupo.run(escritorio.id, m.competencia, direcao)
      try {
        retirarGeradosDoMes(m.pasta)
      } catch (e) {
        logger.warn('Relatório ou ZIP antigo não saiu da pasta do escritório', { pasta: m.pasta, erro: e.code || e.message })
      }
    }
    await resgatarDeForaDaCarteira(escritorio, resultado)
    if (!resultado.falhas) db.prepare("INSERT INTO sistema (chave, valor) VALUES ('notas_escritorio_corrigidas', '1') ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run()
    if (resultado.movidas || resultado.resgatadas || resultado.copias || resultado.semDono || resultado.falhas) logger.info('Notas do escritório corrigidas', resultado)
    return resultado
  }

  return { capturarCliente, capturarTodos, processarDocumento, corrigirNotasDoEscritorio }
}

module.exports = { criarServicoCaptura, nsu15 }
