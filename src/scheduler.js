'use strict'

// Agendador: dispara o ciclo completo (consulta → download) nos horários escolhidos no painel
// (sem nenhum escolhido, no CRON_CAPTURA do .env).
// Clientes bloqueados (656) ou na espera de 1 h (137) são pulados dentro do próprio ciclo.

const nodeCron = require('node-cron')

/**
 * @param {object} deps
 * @param {object} deps.ciclo          criarServicoCiclo(...)
 * @param {object} deps.config         usa cronCaptura
 * @param {object} deps.logger
 * @param {object} [deps.cron]         node-cron (injetável nos testes)
 * @param {object} [deps.automacao]    criarAutomacao(...); com a busca automática desligada, só roda o que for disparado à mão;
 *                                     os horários dela substituem o cron do .env
 * @param {number|false} [deps.atrasoInicialMs] roda um ciclo logo depois de iniciar (false desliga)
 * @param {Function} [deps.agendarUmaVez] setTimeout injetável
 */
function criarAgendador({ ciclo, config, logger, automacao, cron = nodeCron, atrasoInicialMs = 15000, agendarUmaVez = setTimeout, agora = () => new Date() }) {
  let tarefas = []
  let iniciado = false
  let timerInicial = null
  let emExecucao = null
  let ultima = null

  const automatica = () => !automacao || automacao.obter().captura

  // Horários "HH:MM" em uso: os do painel ou, sem eles, os do cron do .env quando ele é do tipo "M H1,H2 * * *".
  function horarios() {
    const escolhidos = automacao?.horarios?.()
    if (escolhidos) return escolhidos
    const m = /^(\d{1,2}) ([\d,]+) \* \* \*$/.exec(config.cronCaptura)
    if (!m) return null
    const doCron = m[2].split(',').map((h) => `${h.padStart(2, '0')}:${m[1].padStart(2, '0')}`)
    return [...new Set(doCron)].sort()
  }

  function expressoes() {
    const escolhidos = automacao?.horarios?.()
    if (!escolhidos) return [config.cronCaptura]
    return escolhidos.map((h) => {
      const [hh, mm] = h.split(':').map(Number)
      return `${mm} ${hh} * * *`
    })
  }

  function agendar() {
    const lista = expressoes()
    for (const e of lista) if (!cron.validate(e)) throw new Error(e === config.cronCaptura ? `CRON_CAPTURA inválido: ${e}` : `Horário de captura inválido: ${e}`)
    tarefas = lista.map((e, i) => cron.schedule(e, () => executarAgora('agendado'), { name: `captura-nfe-${i}`, noOverlap: true }))
  }

  /** Roda um ciclo agora; se já houver um rodando, devolve o mesmo (não empilha). */
  function executarAgora(origem = 'agendado') {
    if ((origem === 'agendado' || origem === 'inicio') && !automatica()) {
      logger.info('Busca automática desligada; horário ignorado', { origem })
      return Promise.resolve({ ok: true, pulado: 'busca automática desligada', clientes: [] })
    }
    if (emExecucao) {
      logger.warn('Ciclo anterior ainda em andamento; disparo ignorado', { origem })
      return emExecucao
    }
    const inicio = agora().toISOString()
    logger.info('Ciclo iniciado', { origem })
    emExecucao = (async () => {
      try {
        // Horários e abertura do app seguem a escolha de cada cliente; "Capturar" pelo painel pega tudo o que foi marcado.
        const r = await ciclo.executarCiclo({ automatica: origem === 'agendado' || origem === 'inicio' })
        const comErro = (r.clientes || []).filter((c) => c.erro || c.captura?.ok === false || c.download?.ok === false)
        if (r.escritorio && (r.escritorio.erro || r.escritorio.captura?.ok === false)) comErro.push(r.escritorio)
        ultima = { inicio, fim: agora().toISOString(), origem, ok: r.ok, erro: r.erro || null, clientes: (r.clientes || []).length, clientesComErro: comErro.length }
        if (r.ok) logger.info('Ciclo concluído', { origem, clientes: ultima.clientes, clientesComErro: ultima.clientesComErro })
        else logger.warn('Ciclo não executado', { origem, motivo: r.erro })
        return r
      } catch (e) {
        ultima = { inicio, fim: agora().toISOString(), origem, ok: false, erro: e.message, clientes: 0, clientesComErro: 0 }
        logger.error('Erro inesperado no ciclo agendado', { origem, erro: e.message })
        return { ok: false, erro: e.message, clientes: [] }
      } finally {
        emExecucao = null
      }
    })()
    return emExecucao
  }

  function iniciar() {
    if (iniciado) return
    agendar()
    iniciado = true
    logger.info('Agendador iniciado', { horarios: horarios() || config.cronCaptura, proxima: proximaExecucao() })
    if (atrasoInicialMs !== false) {
      // Ao ligar o PC, não espera até o próximo horário do cron.
      timerInicial = agendarUmaVez(() => {
        timerInicial = null
        executarAgora('inicio')
      }, atrasoInicialMs)
    }
  }

  /** Troca os horários na hora, sem reiniciar (chamado quando o painel muda os horários). */
  async function reagendar() {
    if (!iniciado) return
    const antigas = tarefas
    agendar()
    await Promise.all(antigas.map((t) => t.destroy()))
    logger.info('Horários da busca automática trocados', { horarios: horarios(), proxima: proximaExecucao() })
  }

  /** Para de agendar e espera o ciclo em andamento terminar. */
  async function parar() {
    if (timerInicial) clearTimeout(timerInicial)
    timerInicial = null
    await Promise.all(tarefas.map((t) => t.destroy()))
    tarefas = []
    iniciado = false
    if (emExecucao) {
      logger.info('Aguardando o ciclo em andamento terminar')
      await emExecucao
    }
    logger.info('Agendador parado')
  }

  function proximaExecucao() {
    const proximas = tarefas.map((t) => t.getNextRun?.()).filter(Boolean)
    return proximas.length ? new Date(Math.min(...proximas.map((d) => d.getTime()))).toISOString() : null
  }

  function estado() {
    const ligada = automatica()
    return { ativo: iniciado, automatica: ligada, cron: config.cronCaptura, horarios: horarios(), proximaExecucao: ligada ? proximaExecucao() : null, rodandoAgora: !!emExecucao, ultimaExecucao: ultima }
  }

  return { iniciar, parar, reagendar, executarAgora, proximaExecucao, estado }
}

/** Próximos horários de uma expressão cron, sem agendar nada (usado no `status`). */
function proximosHorarios(expressao, quantidade = 1, cron = nodeCron) {
  if (!cron.validate(expressao)) return []
  const t = cron.createTask(expressao, () => {})
  try {
    return t.getNextRuns(quantidade).map((d) => d.toISOString())
  } finally {
    t.destroy()
  }
}

module.exports = { criarAgendador, proximosHorarios }
