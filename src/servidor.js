'use strict'

// Modo do dia a dia: agendador + painel web no mesmo processo.

const { criarAgendador } = require('./scheduler')

/**
 * @param {object} ctx  criarContexto(...)
 * @param {object} [opcoes]
 * @param {number|false} [opcoes.atrasoInicialMs] primeiro ciclo logo após iniciar (false desliga)
 * @param {boolean} [opcoes.comPainel] sobe o painel web (padrão true)
 * @param {object} [opcoes.relogio] { depois(fn, ms), aCada(fn, ms) } → função que cancela (injetável nos testes)
 * @param {Function} [opcoes.estoque] () => motor do SPED, para onde o painel repassa /estoque
 * @param {object} [opcoes.atualizacao] { estado(), verificar() } da atualização automática do app
 * @returns {Promise<{ agendador, painel, parar: () => Promise<void> }>}
 */
const BACKUP_INICIAL_MS = 60e3
const BACKUP_INTERVALO_MS = 3600e3

const relogioReal = {
  depois: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  aCada: (fn, ms) => {
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  },
}

async function iniciarServidor(ctx, { atrasoInicialMs, cron, comPainel = true, relogio = relogioReal, estoque, atualizacao } = {}) {
  const { config, logger } = ctx
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config, logger, automacao: ctx.automacao, atrasoInicialMs, ...(cron ? { cron } : {}) })
  let painel = null
  if (comPainel) painel = await require('./web/server').iniciarPainel({ ctx, agendador, estoque, atualizacao })
  agendador.iniciar()

  // Backup: 1 min depois de ligar e a cada hora; o serviço só copia se houver pasta escolhida
  // (a pasta pode ser escolhida depois, na tela Backup) e ainda não houver a cópia do dia.
  const cancelarBackup = []
  if (ctx.backup) {
    const backup = () => ctx.backup.fazerBackup()
    cancelarBackup.push(relogio.depois(backup, BACKUP_INICIAL_MS), relogio.aCada(backup, BACKUP_INTERVALO_MS))
  }
  logger.info('Servidor iniciado', {
    ambiente: config.tpAmb === '1' ? 'produção' : 'homologação',
    sefazSimulada: config.sefazMock,
    cron: config.cronCaptura,
    painel: painel?.url || null,
  })

  let parando = null
  function parar() {
    parando ||= (async () => {
      logger.info('Encerrando o servidor')
      if (painel) await painel.fechar()
      for (const cancelar of cancelarBackup) cancelar()
      await agendador.parar()
      if (ctx.backup) await ctx.backup.aguardar()
      logger.info('Servidor encerrado')
    })()
    return parando
  }

  return { agendador, painel, parar }
}

/** Mantém o processo vivo até Ctrl+C / sinal de parada do serviço (NSSM envia Ctrl+C). */
function aguardarEncerramento(servidor, logger) {
  return new Promise((resolve) => {
    const encerrar = (sinal) => {
      logger.info('Sinal de parada recebido', { sinal })
      servidor.parar().then(resolve, resolve)
    }
    process.once('SIGINT', encerrar)
    process.once('SIGTERM', encerrar)
    process.once('SIGBREAK', encerrar) // Windows: Ctrl+Break
    process.on('unhandledRejection', (e) => logger.error('Promessa rejeitada sem tratamento', { erro: e?.message || String(e) }))
  })
}

module.exports = { iniciarServidor, aguardarEncerramento }
