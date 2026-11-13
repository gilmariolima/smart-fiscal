'use strict'

// "Buscar notas antigas": fila de chaves de NF-e a baixar pela SVRS com o certificado do cliente.
// Uma consulta por vez, 60 s entre elas; a SVRS bloqueia o IP com consultas seguidas ("múltiplas consultas"),
// então o bloqueio pausa 5 min e alonga o intervalo. Cada XML baixado passa pelo Importar.

const fs = require('node:fs')
const { criarArmazenamento } = require('./armazenamento')

const UM_MINUTO = 60e3
const PAUSA_BLOQUEIO_MS = 5 * UM_MINUTO
const ESPERA_SEM_RODAR_MS = 30e3
const PASSO_SOBE_MS = 30e3
const PASSO_DESCE_MS = 15e3
const INTERVALO_MAXIMO_MS = 180e3
const CONSULTAS_PARA_DESCER = 20
const TENTATIVAS = 3
const FALHAS_PARA_PAUSAR = 3
const CONCLUIDAS = ['baixada', 'ja-existia', 'nao-nfe']
const MOTIVOS_IMPORTAR = {
  'sem-protocolo': 'nota sem autorização da SEFAZ',
  homologacao: 'nota de homologação (teste)',
  invalido: 'XML ilegível',
  'nao-suportado': 'tipo não suportado (só NF-e, NFS-e e CT-e)',
  'cnpj-nao-cadastrado': 'o cliente não é emitente nem destinatário da nota',
  'erro-gravacao': 'não foi possível gravar na pasta (veja o log)',
}

/** Sequências de dígitos (com espaço, ponto ou hífen entre blocos) que formam chaves de 44 dígitos. */
function chavesDoTexto(texto) {
  const chaves = []
  for (const trecho of String(texto || '').match(/\d(?:[ .-]?\d)*/g) || []) {
    // Blocos pequenos (chave em grupos de 4) se juntam até dar 44; bloco de 44 é uma chave; maior que isso não é.
    let junta = ''
    for (const bloco of trecho.split(/[ .-]/)) {
      if (bloco.length >= 44) {
        if (bloco.length === 44) chaves.push(bloco)
        junta = ''
        continue
      }
      junta += bloco
      if (junta.length === 44) {
        chaves.push(junta)
        junta = ''
      } else if (junta.length > 44) junta = ''
    }
  }
  return chaves
}

function criarBuscaAntiga({ db, config, logger, importacao, fabricaSvrs, podeRodar = () => null, aoImportar = () => {}, agora = () => new Date(), temporizador = { setTimeout, clearTimeout } }) {
  const armazenamento = criarArmazenamento({ config, db })
  // Abaixo de 1 min só na demonstração (SEFAZ simulada): na SVRS de verdade, 30 s já bloqueia o IP.
  const base = () => (config.sefazMock ? config.buscaAntigaIntervaloMs || UM_MINUTO : Math.max(UM_MINUTO, config.buscaAntigaIntervaloMs || UM_MINUTO))
  const iso = () => agora().toISOString()
  const sql = {
    cliente: db.prepare("SELECT * FROM clientes WHERE id = ? AND cert_arquivo <> '' AND (papel = 'cliente' OR tambem_cliente = 1)"),
    linha: db.prepare('SELECT * FROM busca_antiga WHERE cliente_id = ? AND chave = ?'),
    inserir: db.prepare('INSERT INTO busca_antiga (cliente_id, chave, situacao, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)'),
    voltarParaFila: db.prepare("UPDATE busca_antiga SET situacao = 'fila', tentativas = 0, mensagem = NULL, atualizado_em = ? WHERE id = ?"),
    proxima: db.prepare("SELECT * FROM busca_antiga WHERE situacao = 'fila' ORDER BY id LIMIT 1"),
    clienteDaLinha: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    marcar: db.prepare('UPDATE busca_antiga SET situacao = ?, mensagem = ?, tentativas = ?, atualizado_em = ? WHERE id = ?'),
    nota: db.prepare("SELECT caminho_xml FROM notas WHERE cliente_id = ? AND chave = ? AND status = 'completa'"),
    pendentes: db.prepare("SELECT COUNT(*) FROM busca_antiga WHERE situacao = 'fila'").pluck(),
    total: db.prepare('SELECT COUNT(*) FROM busca_antiga').pluck(),
    pausada: db.prepare("SELECT valor FROM sistema WHERE chave = 'busca_antiga_pausada'").pluck(),
    pausar: db.prepare("INSERT INTO sistema (chave, valor) VALUES ('busca_antiga_pausada', '1') ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor"),
    continuar: db.prepare("DELETE FROM sistema WHERE chave = 'busca_antiga_pausada'"),
    lerSistema: db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck(),
    gravarSistema: db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
    limpar: db.prepare(`DELETE FROM busca_antiga WHERE situacao IN (${CONCLUIDAS.map((s) => `'${s}'`).join(',')})`),
  }

  // O ritmo sobrevive a fechar e abrir o app: sem isso, a primeira consulta depois de abrir ignoraria o intervalo.
  const lido = (chave) => sql.lerSistema.get(`busca_antiga_${chave}`) || null
  const intervaloLido = Number(lido('intervalo')) || 0
  const st = {
    pausada: sql.pausada.get() === '1',
    iniciado: false,
    ocupado: false,
    timer: null,
    proximaEm: null,
    voltaAs: lido('volta') ? new Date(lido('volta')) : null,
    pausaPor: lido('pausa_por'),
    motivo: null,
    intervaloMs: Math.min(INTERVALO_MAXIMO_MS, Math.max(base(), intervaloLido)),
    semBloqueio: 0,
    falhasSeguidas: 0,
    ultimaConsulta: Number(lido('ultima')) || null,
  }

  function gravarRitmo() {
    sql.gravarSistema.run('busca_antiga_ultima', String(st.ultimaConsulta || ''))
    sql.gravarSistema.run('busca_antiga_volta', st.voltaAs ? st.voltaAs.toISOString() : '')
    sql.gravarSistema.run('busca_antiga_pausa_por', st.pausaPor || '')
    sql.gravarSistema.run('busca_antiga_intervalo', String(st.intervaloMs))
  }

  function cancelar() {
    if (st.timer) temporizador.clearTimeout(st.timer)
    st.timer = null
    st.proximaEm = null
  }

  function agendar(ms) {
    cancelar()
    st.proximaEm = new Date(agora().getTime() + ms)
    st.timer = temporizador.setTimeout(ciclo, ms)
  }

  // Quanto falta para poder consultar de novo (intervalo desde a última consulta e pausa do bloqueio).
  function restante() {
    const t = agora().getTime()
    const peloIntervalo = st.ultimaConsulta ? st.ultimaConsulta + st.intervaloMs - t : 0
    const peloBloqueio = st.voltaAs ? st.voltaAs.getTime() - t : 0
    return Math.max(0, peloIntervalo, peloBloqueio)
  }

  function adicionar(clienteId, texto) {
    const cliente = sql.cliente.get(clienteId)
    if (!cliente) throw Object.assign(new Error('Cliente sem certificado: escolha um cliente com certificado A1.'), { codigo: 404 })
    const r = { adicionadas: 0, repetidas: 0, naoNfe: 0 }
    const vistas = new Set()
    db.transaction(() => {
      for (const chave of chavesDoTexto(texto)) {
        if (vistas.has(chave)) {
          r.repetidas++
          continue
        }
        vistas.add(chave)
        const existente = sql.linha.get(cliente.id, chave)
        if (existente) {
          if (existente.situacao === 'erro' || existente.situacao === 'nao-envolvido') {
            sql.voltarParaFila.run(iso(), existente.id)
            r.adicionadas++
          } else r.repetidas++
          continue
        }
        // Só NF-e (modelo 55, posições 21-22 da chave).
        const nfe = chave.slice(20, 22) === '55'
        sql.inserir.run(cliente.id, chave, nfe ? 'fila' : 'nao-nfe', iso(), iso())
        if (nfe) r.adicionadas++
        else r.naoNfe++
      }
    })()
    if (r.adicionadas && st.iniciado && !st.pausada && !st.timer && !st.ocupado) agendar(restante())
    return r
  }

  function temArquivo(clienteId, chave) {
    const nota = sql.nota.get(clienteId, chave)
    if (!nota?.caminho_xml) return false
    try {
      return fs.statSync(armazenamento.absoluto(nota.caminho_xml)).size > 0
    } catch {
      return false
    }
  }

  function marcar(l, situacao, mensagem = null, tentativas = l.tentativas) {
    sql.marcar.run(situacao, mensagem, tentativas, iso(), l.id)
    return situacao
  }

  // tipo: 'ok' | 'bloqueio' (múltiplas consultas: pausa e alonga o intervalo) | 'sem-resposta' (SVRS fora do ar: só pausa).
  function aposConsulta(tipo) {
    st.ultimaConsulta = agora().getTime()
    if (tipo === 'ok') {
      if (++st.semBloqueio >= CONSULTAS_PARA_DESCER) {
        st.intervaloMs = Math.max(base(), st.intervaloMs - PASSO_DESCE_MS)
        st.semBloqueio = 0
      }
    } else {
      st.voltaAs = new Date(st.ultimaConsulta + PAUSA_BLOQUEIO_MS)
      st.pausaPor = tipo
      if (tipo === 'bloqueio') {
        st.intervaloMs = Math.min(INTERVALO_MAXIMO_MS, st.intervaloMs + PASSO_SOBE_MS)
        st.semBloqueio = 0
        logger.warn('SVRS pediu pausa (múltiplas consultas)', { intervaloS: st.intervaloMs / 1000 })
      } else logger.warn('SVRS sem resposta: busca de notas antigas pausada por 5 min')
    }
    gravarRitmo()
  }

  /** Processa a primeira chave da fila. Devolve a situação final, 'bloqueado' ou null (fila vazia). */
  async function processarProxima() {
    const l = sql.proxima.get()
    if (!l) return null
    st.consultou = false
    const cliente = sql.clienteDaLinha.get(l.cliente_id)
    if (!cliente?.cert_arquivo) return marcar(l, 'erro', 'Certificado do cliente indisponível')
    if (cliente.cert_validade && new Date(cliente.cert_validade) < agora()) return marcar(l, 'erro', 'Certificado vencido')
    if (temArquivo(cliente.id, l.chave)) return marcar(l, 'ja-existia')

    let r
    try {
      const svrs = fabricaSvrs(cliente)
      st.consultou = true
      r = await svrs.baixarNfe(l.chave)
    } catch (e) {
      r = st.consultou ? { motivo: 'erro', mensagem: e.message, repetir: true } : { motivo: 'erro', mensagem: `Certificado do cliente indisponível: ${e.message}` }
    }
    // SVRS fora do ar (rede ou HTTP 5xx) não gasta tentativa da chave; 3 seguidas pausam a fila como no bloqueio.
    if (st.consultou && r.semResposta) {
      if (++st.falhasSeguidas >= FALHAS_PARA_PAUSAR) {
        st.falhasSeguidas = 0
        aposConsulta('sem-resposta')
        return 'bloqueado'
      }
      aposConsulta('ok')
      return marcar(l, 'fila', r.mensagem)
    }
    st.falhasSeguidas = 0
    if (st.consultou) aposConsulta(r.motivo === 'bloqueado' ? 'bloqueio' : 'ok')

    if (r.xml) {
      let ri
      try {
        ri = importacao.importar([{ nome: `${l.chave}-nfe.xml`, bytes: Buffer.from(r.xml, 'utf8') }], { soDaCarteira: true })
      } catch (e) {
        logger.error('Nota antiga baixada e não importada', { chave: l.chave, erro: e.message })
        return marcar(l, 'erro', `Não foi possível importar: ${e.message}`)
      }
      const importadas = ri.importadas.nfe.entrada + ri.importadas.nfe.saida
      if (importadas) {
        aoImportar(ri.clientesAfetados)
        return marcar(l, 'baixada')
      }
      if (ri.jaExistiam) return marcar(l, 'ja-existia')
      const motivo = ri.ignoradas[0]?.motivo
      return marcar(l, 'erro', MOTIVOS_IMPORTAR[motivo] || motivo || 'O Importar recusou o XML')
    }
    if (r.motivo === 'bloqueado') return 'bloqueado'
    if (r.motivo === 'nao-envolvido') return marcar(l, 'nao-envolvido', r.mensagem)
    const tentativas = l.tentativas + 1
    if (r.repetir && tentativas < TENTATIVAS) return marcar(l, 'fila', r.mensagem, tentativas)
    return marcar(l, 'erro', r.mensagem, tentativas)
  }

  async function ciclo() {
    cancelar()
    if (st.pausada || !st.iniciado) return
    const motivo = podeRodar()
    st.motivo = motivo || null
    if (motivo) return agendar(ESPERA_SEM_RODAR_MS)
    if (st.ocupado) return
    st.ocupado = true
    let r
    let fim
    st.rodada = new Promise((ok) => (fim = ok))
    try {
      r = await processarProxima()
    } catch (e) {
      logger.error('Busca de notas antigas falhou', { erro: e.message })
      r = 'erro'
    } finally {
      st.ocupado = false
      st.rodada = null
      fim()
    }
    if (st.pausada || !st.iniciado || r === null) return
    agendar(r === 'bloqueado' ? PAUSA_BLOQUEIO_MS : st.consultou ? st.intervaloMs : 0)
  }

  function iniciar() {
    st.iniciado = true
    if (!st.pausada && sql.pendentes.get()) agendar(Math.max(base(), restante()))
  }

  /** Para de agendar; devolve a promessa da consulta em curso (o banco só fecha depois dela). */
  function parar() {
    st.iniciado = false
    cancelar()
    return st.rodada || Promise.resolve()
  }

  function pausar() {
    st.pausada = true
    sql.pausar.run()
    cancelar()
  }

  function continuar() {
    st.pausada = false
    sql.continuar.run()
    if (st.iniciado && !st.ocupado && sql.pendentes.get()) agendar(restante())
  }

  function estado() {
    const volta = st.voltaAs && st.voltaAs > agora() ? st.voltaAs.toISOString() : null
    return {
      pausada: st.pausada,
      rodando: st.ocupado,
      motivo: st.motivo,
      intervaloS: st.intervaloMs / 1000,
      proximaEm: st.proximaEm ? st.proximaEm.toISOString() : null,
      voltaAs: volta,
      pausaPor: volta ? st.pausaPor : null,
      total: sql.total.get(),
      pendentes: sql.pendentes.get(),
    }
  }

  function listar({ situacao } = {}) {
    const filtro = situacao ? 'WHERE b.situacao = ?' : ''
    return db
      .prepare(`SELECT b.id, b.chave, b.situacao, b.mensagem, b.tentativas, b.atualizado_em, c.cnpj, COALESCE(NULLIF(c.apelido, ''), c.razao_social) AS nome
        FROM busca_antiga b JOIN clientes c ON c.id = b.cliente_id ${filtro} ORDER BY b.id DESC LIMIT 500`)
      .all(...(situacao ? [situacao] : []))
  }

  const limparConcluidas = () => sql.limpar.run().changes
  const configurar = (ganchos) => {
    if (ganchos.podeRodar) podeRodar = ganchos.podeRodar
    if (ganchos.aoImportar) aoImportar = ganchos.aoImportar
  }

  return { adicionar, processarProxima, iniciar, parar, pausar, continuar, estado, listar, limparConcluidas, configurar }
}

module.exports = { criarBuscaAntiga, chavesDoTexto }
