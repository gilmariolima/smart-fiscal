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
 * @param {boolean} [opcoes.exigirPasta] sem pasta principal escolhida nada captura (o app passa true; terminal e testes, não)
 * @param {Function} [opcoes.aoPularSemPasta] chamado a cada horário de captura pulado por falta de pasta
 * @returns {Promise<{ agendador, painel, parar: () => Promise<void> }>}
 */
const BACKUP_INICIAL_MS = 60e3
const BACKUP_INTERVALO_MS = 3600e3
const CONFERENCIA_INICIAL_MS = 20e3
const ORGANIZACAO_INICIAL_MS = 30e3
const LIMITE_AO_FECHAR_MS = 30e3

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

async function iniciarServidor(ctx, { atrasoInicialMs, cron, comPainel = true, relogio = relogioReal, estoque, atualizacao, escolherPasta, exigirPasta = false, aoPularSemPasta } = {}) {
  const { config, logger } = ctx
  ctx.ciclo.encerrarOrfas()
  // Nenhuma captura automática durante a troca de pasta; sem pasta escolhida, só quando exigirPasta.
  const motivoPulo = () => {
    if (ctx.pastas?.movendoAgora()) return 'A pasta está sendo trocada. Espere terminar para capturar.'
    if (exigirPasta && !ctx.pastas?.temPasta()) return 'Escolha a pasta principal na tela Pastas antes de capturar.'
    return null
  }
  const podeCapturar = () => motivoPulo() === null
  const faltaPasta = () => !ctx.pastas?.movendoAgora() && exigirPasta && !ctx.pastas?.temPasta()
  // Depois de cada ciclo de captura, a pasta organizada é atualizada em segundo plano.
  if (ctx.deps && ctx.organizador) ctx.deps.aoTerminarCiclo = () => ctx.organizador.agendar()
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config, logger, automacao: ctx.automacao, atrasoInicialMs, podeCapturar, motivoPulo, faltaPasta, ...(aoPularSemPasta ? { aoPularSemPasta } : {}), ...(cron ? { cron } : {}) })
  // Uma vez, se existe escritório: antes de qualquer captura ou geração.
  await ctx.ciclo?.corrigirNotasDoEscritorio?.()
  // Notas em Sem cliente cadastrado cujo cliente já existe (NF-e, CT-e e NFS-e) vão para ele, sem atrasar a janela.
  ctx.notasSemCliente
    ?.levar()
    .then((r) => r.clientesAfetados.length && ctx.organizador?.agendar({ conferirArquivos: true }))
    .catch((e) => logger.warn('Notas sem cliente não levadas ao abrir', { erro: e.message }))
  let painel = null
  if (comPainel) painel = await require('./web/server').iniciarPainel({ ctx, agendador, estoque, atualizacao, escolherPasta, exigirPasta })
  agendador.iniciar()
  // Notas antigas pela SVRS: espera a captura e a troca de pasta; cada nota importada atualiza a pasta organizada.
  ctx.buscaAntiga?.configurar({
    podeRodar: () => {
      if (ctx.pastas?.movendoAgora()) return 'Esperando a troca da pasta'
      if (exigirPasta && !ctx.pastas?.temPasta()) return 'Escolha a pasta principal na tela Pastas'
      if (agendador.estado().rodandoAgora || ctx.ciclo.cicloEmAndamento()) return 'Esperando a captura terminar'
      return null
    },
    aoImportar: () => ctx.organizador?.agendar({ conferirArquivos: true }),
  })
  ctx.buscaAntiga?.iniciar()

  // Backup: 1 min depois de ligar e a cada hora; o serviço só copia se houver pasta escolhida
  // (a pasta pode ser escolhida depois, na tela Backup) e ainda não houver a cópia do dia.
  const cancelarBackup = []
  if (ctx.backup) {
    const backup = () => ctx.backup.fazerBackup()
    cancelarBackup.push(relogio.depois(backup, BACKUP_INICIAL_MS), relogio.aCada(backup, BACKUP_INTERVALO_MS))
  }
  if (ctx.conferenciaXmls) cancelarBackup.push(relogio.depois(() => ctx.conferenciaXmls.conferir(), CONFERENCIA_INICIAL_MS))
  if (ctx.organizador) cancelarBackup.push(relogio.depois(() => ctx.organizador.agendar({ conferirArquivos: true }), ORGANIZACAO_INICIAL_MS))
  logger.info('Servidor iniciado', {
    ambiente: config.tpAmb === '1' ? 'produção' : 'homologação',
    sefazSimulada: config.sefazMock,
    cron: config.cronCaptura,
    painel: painel?.url || null,
  })

  // Rede travada não pode prender o fechamento do app: estourou o limite, segue fechando.
  function comLimite(espera, oQue) {
    if (!espera) return undefined
    return new Promise((resolve) => {
      const cancelar = relogio.depois(() => {
        logger.warn(`${oQue} passou de ${LIMITE_AO_FECHAR_MS / 1000} s ao fechar: seguindo sem esperar`)
        resolve()
      }, LIMITE_AO_FECHAR_MS)
      const fim = () => {
        cancelar()
        resolve()
      }
      espera.then(fim, fim)
    })
  }

  let parando = null
  function parar() {
    parando ||= (async () => {
      logger.info('Encerrando o servidor')
      // Pede a parada antes de tudo; a captura pelo painel não passa pelo agendador e também precisa terminar antes de o banco fechar.
      const fimDoCiclo = ctx.ciclo.parar()
      const fimDaTroca = ctx.pastas?.pararTroca?.()
      const fimDaBusca = ctx.buscaAntiga?.parar()
      if (painel) await painel.fechar()
      for (const cancelar of cancelarBackup) cancelar()
      await agendador.parar()
      await fimDoCiclo
      await comLimite(fimDaTroca, 'A troca de pasta')
      await comLimite(fimDaBusca, 'A busca de notas antigas')
      await ctx.conferenciaXmls?.parar()
      await comLimite(ctx.organizador?.parar(), 'A organização da pasta')
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
