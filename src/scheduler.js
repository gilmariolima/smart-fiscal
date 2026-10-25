'use strict'

// Agendador: dispara o ciclo completo (consulta → ciência → download) no horário de CRON_CAPTURA.
// Clientes bloqueados (656) ou na espera de 1 h (137) são pulados dentro do próprio ciclo.

const nodeCron = require('node-cron')

/**
 * @param {object} deps
 * @param {object} deps.ciclo          criarServicoCiclo(...)
 * @param {object} deps.config         usa cronCaptura
 * @param {object} deps.logger
 * @param {object} [deps.cron]         node-cron (injetável nos testes)
 * @param {object} [deps.automacao]    criarAutomacao(...); com a busca automática desligada, só roda o que for disparado à mão
 * @param {number|false} [deps.atrasoInicialMs] roda um ciclo logo depois de iniciar (false desliga)
 * @param {Function} [deps.agendarUmaVez] setTimeout injetável
 */
function criarAgendador({ ciclo, config, logger, automacao, cron = nodeCron, atrasoInicialMs = 15000, agendarUmaVez = setTimeout, agora = () => new Date() }) {
  let tarefa = null
  let timerInicial = null
  let emExecucao = null
  let ultima = null

  const automatica = () => !automacao || automacao.obter().captura

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
        const r = await ciclo.executarCiclo()
        const comErro = (r.clientes || []).filter((c) => c.erro || c.captura?.ok === false || c.ciencia?.ok === false || c.download?.ok === false)
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
    if (tarefa) return
    if (!cron.validate(config.cronCaptura)) throw new Error(`CRON_CAPTURA inválido: ${config.cronCaptura}`)
    tarefa = cron.schedule(config.cronCaptura, () => executarAgora('agendado'), { name: 'captura-nfe', noOverlap: true })
    logger.info('Agendador iniciado', { cron: config.cronCaptura, proxima: proximaExecucao() })
    if (atrasoInicialMs !== false) {
      // Ao ligar o PC, não espera até o próximo horário do cron.
      timerInicial = agendarUmaVez(() => {
        timerInicial = null
        executarAgora('inicio')
      }, atrasoInicialMs)
    }
  }

  /** Para de agendar e espera o ciclo em andamento terminar. */
  async function parar() {
    if (timerInicial) clearTimeout(timerInicial)
    timerInicial = null
    if (tarefa) await tarefa.destroy()
    tarefa = null
    if (emExecucao) {
      logger.info('Aguardando o ciclo em andamento terminar')
      await emExecucao
    }
    logger.info('Agendador parado')
  }

  function proximaExecucao() {
    const d = tarefa?.getNextRun?.()
    return d ? d.toISOString() : null
  }

  function estado() {
    const ligada = automatica()
    return { ativo: !!tarefa, automatica: ligada, cron: config.cronCaptura, proximaExecucao: ligada ? proximaExecucao() : null, rodandoAgora: !!emExecucao, ultimaExecucao: ultima }
  }

  return { iniciar, parar, executarAgora, proximaExecucao, estado }
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
