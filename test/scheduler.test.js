'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const nodeCron = require('node-cron')
const { criarAgendador, proximosHorarios } = require('../src/scheduler')
const { iniciarServidor } = require('../src/servidor')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { montarAmbiente, silencioso } = require('./apoio/ambiente')

// node-cron falso: guarda a tarefa para o teste disparar na mão.
function cronFalso() {
  const tarefas = []
  return {
    tarefas,
    validate: nodeCron.validate,
    schedule(expressao, fn, opcoes) {
      const t = { expressao, fn, opcoes, destruida: false, destroy() { t.destruida = true }, getNextRun: () => new Date('2026-10-09T14:00:00Z') }
      tarefas.push(t)
      return t
    },
  }
}

function timerFalso() {
  const chamadas = []
  return { chamadas, agendarUmaVez: (fn, ms) => (chamadas.push({ fn, ms }), 1) }
}

const config = { cronCaptura: '0 */2 * * *' }

function cicloFalso(impl) {
  const chamadas = []
  return { chamadas, encerrarOrfas: () => 0, parar: async () => {}, progresso: () => null, executarCiclo: async () => (chamadas.push(1), impl ? impl() : { ok: true, clientes: [{ cnpj: '1' }, { cnpj: '2', erro: 'x' }] }) }
}

test('agenda o ciclo na expressão do .env e , com atraso pedido (servidor pelo terminal), roda um ciclo logo depois de iniciar', async () => {
  const cron = cronFalso()
  const timer = timerFalso()
  const ciclo = cicloFalso()
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron, atrasoInicialMs: 15000, agendarUmaVez: timer.agendarUmaVez })
  ag.iniciar()
  ag.iniciar() // idempotente
  assert.equal(cron.tarefas.length, 1)
  assert.equal(cron.tarefas[0].expressao, '0 */2 * * *')
  assert.equal(cron.tarefas[0].opcoes.noOverlap, true)
  assert.deepEqual(timer.chamadas.map((c) => c.ms), [15000])
  assert.equal(ag.estado().proximaExecucao, '2026-10-09T14:00:00.000Z')

  await timer.chamadas[0].fn() // primeiro ciclo, logo depois de iniciar
  assert.equal(ciclo.chamadas.length, 1)
  await cron.tarefas[0].fn() // horário do cron
  await new Promise((r) => setImmediate(r))
  assert.equal(ciclo.chamadas.length, 2)
  const e = ag.estado()
  assert.equal(e.ultimaExecucao.ok, true)
  assert.equal(e.ultimaExecucao.clientes, 2)
  assert.equal(e.ultimaExecucao.clientesComErro, 1)
})

test('não empilha ciclos: disparo durante um ciclo devolve o mesmo', async () => {
  let liberar
  const ciclo = cicloFalso(() => new Promise((r) => (liberar = () => r({ ok: true, clientes: [] }))))
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron: cronFalso(), atrasoInicialMs: false })
  const p1 = ag.executarAgora()
  const p2 = ag.executarAgora()
  assert.equal(p1, p2)
  assert.equal(ag.estado().rodandoAgora, true)
  liberar()
  await p1
  assert.equal(ciclo.chamadas.length, 1)
  assert.equal(ag.estado().rodandoAgora, false)
})

test('erro no ciclo é registrado e não derruba o agendador', async () => {
  const erros = []
  const logger = { ...silencioso, error: (m, c) => erros.push(c.erro) }
  const ag = criarAgendador({ ciclo: cicloFalso(() => { throw new Error('banco travado') }), config, logger, cron: cronFalso(), atrasoInicialMs: false })
  const r = await ag.executarAgora()
  assert.equal(r.ok, false)
  assert.deepEqual(erros, ['banco travado'])
  assert.equal(ag.estado().ultimaExecucao.erro, 'banco travado')
})

test('parar cancela o timer, destrói a tarefa e espera o ciclo em andamento', async () => {
  let liberar
  const ciclo = cicloFalso(() => new Promise((r) => (liberar = () => r({ ok: true, clientes: [] }))))
  const cron = cronFalso()
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron, agendarUmaVez: () => setTimeout(() => {}, 60000) })
  ag.iniciar()
  ag.executarAgora()
  let parou = false
  const parada = ag.parar().then(() => (parou = true))
  await new Promise((r) => setImmediate(r))
  assert.equal(parou, false, 'espera o ciclo terminar')
  liberar()
  await parada
  assert.equal(cron.tarefas[0].destruida, true)
  assert.equal(ag.estado().ativo, false)
})

test('expressão cron inválida é recusada', () => {
  const ag = criarAgendador({ ciclo: cicloFalso(), config: { cronCaptura: 'a cada hora' }, logger: silencioso, cron: cronFalso() })
  assert.throws(() => ag.iniciar(), /CRON_CAPTURA inválido/)
  assert.throws(() => carregarConfig({ MASTER_KEY: 'a'.repeat(64), CRON_CAPTURA: '99 * * * *' }), /CRON_CAPTURA inválido/)
})

test('proximosHorarios usa o node-cron de verdade', () => {
  const [h1, h2] = proximosHorarios('0 */2 * * *', 2)
  const d1 = new Date(h1)
  assert.equal(d1.getMinutes(), 0)
  assert.equal(d1.getHours() % 2, 0)
  assert.equal(new Date(h2) - d1, 2 * 3600e3)
  assert.deepEqual(proximosHorarios('inválido'), [])
})

test('agendador com o ciclo real e a SEFAZ simulada', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const ag = criarAgendador({ ciclo: criarServicoCiclo(amb.deps), config, logger: silencioso, cron: cronFalso(), atrasoInicialMs: false })
  const r = await ag.executarAgora()
  assert.equal(r.ok, true)
  assert.equal(amb.db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'completa'").get().n, 2)
})

test('agendador: podeCapturar falso pula agendado e inicio, registra no log e não chama o ciclo', async () => {
  const infos = []
  const logger = { ...silencioso, info: (m, c) => infos.push([m, c?.origem]) }
  const ciclo = cicloFalso()
  let pode = false
  const ag = criarAgendador({ ciclo, config, logger, cron: cronFalso(), atrasoInicialMs: false, podeCapturar: () => pode })
  for (const origem of ['agendado', 'inicio']) {
    const r = await ag.executarAgora(origem)
    assert.equal(r.ok, true)
    assert.match(r.pulado, /pasta/)
    assert.deepEqual(r.clientes, [])
  }
  assert.equal(ciclo.chamadas.length, 0)
  assert.equal(ag.estado().rodandoAgora, false)
  assert.equal(infos.filter(([m]) => /pasta/i.test(m)).length, 2)
  // Painel e bandeja também são barrados, com o motivo em pulado.
  for (const origem of ['painel', 'bandeja']) {
    const r = await ag.executarAgora(origem)
    assert.equal(r.ok, true)
    assert.match(r.pulado, /pasta/)
    assert.deepEqual(r.clientes, [])
  }
  assert.equal(ciclo.chamadas.length, 0)
  const ag2 = criarAgendador({ ciclo, config, logger, cron: cronFalso(), podeCapturar: () => false, motivoPulo: () => 'Escolha a pasta principal na tela Pastas antes de capturar.' })
  assert.equal((await ag2.executarAgora('bandeja')).pulado, 'Escolha a pasta principal na tela Pastas antes de capturar.')
  // Com a condição satisfeita o ciclo roda.
  pode = true
  await ag.executarAgora('agendado')
  assert.equal(ciclo.chamadas.length, 1)
})

function ctxComPastas({ temPasta, movendo }) {
  const ciclo = cicloFalso()
  const pastas = { temPasta: () => temPasta.valor, movendoAgora: () => movendo.valor }
  return { ctx: { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo, pastas }, ciclo }
}

test('iniciarServidor com exigirPasta: sem pasta o ciclo agendado não roda; com pasta roda', async () => {
  const temPasta = { valor: false }
  const { ctx, ciclo } = ctxComPastas({ temPasta, movendo: { valor: false } })
  const cron = cronFalso()
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false, exigirPasta: true })
  await cron.tarefas[0].fn()
  assert.equal(ciclo.chamadas.length, 0)
  temPasta.valor = true
  await cron.tarefas[0].fn()
  assert.equal(ciclo.chamadas.length, 1)
  await s.parar()
})

test('iniciarServidor: troca de pasta em andamento impede o ciclo agendado, com ou sem exigirPasta', async () => {
  for (const exigirPasta of [false, true]) {
    const movendo = { valor: true }
    const { ctx, ciclo } = ctxComPastas({ temPasta: { valor: true }, movendo })
    const cron = cronFalso()
    const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false, exigirPasta })
    await cron.tarefas[0].fn()
    assert.equal(ciclo.chamadas.length, 0, `exigirPasta=${exigirPasta}`)
    movendo.valor = false
    await cron.tarefas[0].fn()
    assert.equal(ciclo.chamadas.length, 1)
    await s.parar()
  }
})

test('iniciarServidor: o agendador devolve o motivo em pulado (bandeja e painel também)', async () => {
  const movendo = { valor: true }
  const { ctx, ciclo } = ctxComPastas({ temPasta: { valor: false }, movendo })
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, exigirPasta: true })
  assert.match((await s.agendador.executarAgora('bandeja')).pulado, /sendo trocada/)
  movendo.valor = false
  assert.equal((await s.agendador.executarAgora('bandeja')).pulado, 'Escolha a pasta principal na tela Pastas antes de capturar.')
  assert.equal((await s.agendador.executarAgora('painel')).pulado, 'Escolha a pasta principal na tela Pastas antes de capturar.')
  assert.equal(ciclo.chamadas.length, 0)
  await s.parar()
})

test('iniciarServidor sem exigirPasta e sem troca: nada muda (sem pasta, o ciclo roda)', async () => {
  const { ctx, ciclo } = ctxComPastas({ temPasta: { valor: false }, movendo: { valor: false } })
  const cron = cronFalso()
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false })
  await cron.tarefas[0].fn()
  assert.equal(ciclo.chamadas.length, 1)
  await s.parar()
})

test('iniciarServidor sobe o agendador e para sem erro', async () => {
  const cron = cronFalso()
  const ctx = { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo: cicloFalso() }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false })
  assert.equal(s.agendador.estado().ativo, true)
  await Promise.all([s.parar(), s.parar()])
  assert.equal(cron.tarefas[0].destruida, true)
})

test('iniciarServidor agenda o backup (1 min depois e a cada hora) e cancela ao parar', async () => {
  const cron = cronFalso()
  const chamadas = []
  const agendados = []
  const agendar = (tipo) => (fn, ms) => {
    const item = { tipo, fn, ms, cancelado: false }
    agendados.push(item)
    return () => (item.cancelado = true)
  }
  const relogio = { depois: agendar('depois'), aCada: agendar('aCada') }
  const backup = { ativo: true, fazerBackup: async () => chamadas.push('backup'), aguardar: async () => chamadas.push('aguardou') }
  const ctx = { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo: cicloFalso(), backup }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false, relogio })
  assert.deepEqual(agendados.map((a) => [a.tipo, a.ms]), [['depois', 60e3], ['aCada', 3600e3]])
  await agendados[0].fn()
  await agendados[1].fn()
  assert.deepEqual(chamadas, ['backup', 'backup'])
  await s.parar()
  assert.ok(agendados.every((a) => a.cancelado))
  assert.equal(chamadas.at(-1), 'aguardou')
})

test('iniciarServidor sem pasta de backup ainda agenda os horários (a pasta pode ser escolhida depois na tela Backup)', async () => {
  const agendados = []
  const relogio = { depois: (fn) => (agendados.push(fn), () => {}), aCada: (fn) => (agendados.push(fn), () => {}) }
  const chamadas = []
  const backup = { ativo: false, fazerBackup: async () => (chamadas.push(1), { ok: false, desligado: true }), aguardar: async () => {} }
  const ctx = { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo: cicloFalso(), backup }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, relogio })
  assert.equal(agendados.length, 2)
  assert.deepEqual(await agendados[0](), { ok: false, desligado: true })
  await s.parar()

  const semServico = []
  const s2 = await iniciarServidor({ ...ctx, backup: undefined }, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, relogio: { depois: () => semServico.push(1), aCada: () => semServico.push(1) } })
  await s2.parar()
  assert.equal(semServico.length, 0)
})

test('processo real: servidor roda o primeiro ciclo e continua no ar', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-srv-'))
  const env = {
    ...process.env,
    MASTER_KEY: crypto.randomBytes(32).toString('hex'),
    SEFAZ_MOCK: '1',
    TP_AMB: '2', // independe do .env real (que pode estar em produção)
    INTERVALO_ENTRE_CHAMADAS_MS: '0',
    PASTA_DADOS: path.join(base, 'data'),
    PASTA_LOGS: path.join(base, 'logs'),
    PASTA_XMLS: path.join(base, 'xmls'),
    PASTA_CERTS: path.join(base, 'certs'),
    PAINEL_PORTA: '0', // porta livre qualquer
    PASTA_BACKUP: '', // não usa a pasta de backup do .env real
  }
  const cli = path.resolve(__dirname, '..', 'src', 'cli.js')
  const demo = await new Promise((resolve) => spawn(process.execPath, [cli, 'cliente:demo'], { env }).on('exit', resolve))
  assert.equal(demo, 0)

  const filho = spawn(process.execPath, [cli, 'servidor', '--atraso-inicial', '0'], { env })
  t.after(async () => {
    // No Windows o banco fica preso até o processo sair de fato.
    if (filho.exitCode === null) await new Promise((r) => (filho.once('exit', r), filho.kill()))
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  let saida = ''
  await new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`servidor não concluiu o ciclo:\n${saida}`)), 30000)
    const ler = (d) => {
      saida += d
      if (saida.includes('Ciclo concluído')) {
        clearTimeout(limite)
        resolve()
      }
    }
    filho.stdout.on('data', ler)
    filho.stderr.on('data', ler)
  })
  assert.match(saida, /Servidor rodando \(homologação, SEFAZ simulada\)/)
  assert.match(saida, /Agendamento: 0 8,13 \* \* \*/)
  const url = /Painel: (http:\/\/127\.0\.0\.1:\d+)/.exec(saida)[1]
  const resumo = await (await fetch(`${url}/api/resumo`)).json()
  assert.equal(resumo.clientesAtivos, 2)
  assert.match(await (await fetch(url)).text(), /<title>Smart Fiscal<\/title>/)
  assert.equal(filho.exitCode, null, 'continua rodando depois do ciclo')

  const db = abrirBanco(path.join(base, 'data', 'nfe.db'))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notas WHERE modelo = 'nfe' AND status = 'completa'").get().n, 2)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notas WHERE modelo = 'nfse'").get().n, 3, 'o ciclo do servidor também traz as NFS-e')
  db.close()
})

test('falha do escritório entra na contagem de erros do ciclo', async () => {
  const ciclo = cicloFalso(() => ({ ok: true, clientes: [{ cnpj: '1' }], escritorio: { cnpj: '9', captura: { ok: false, erro: 'cert vencido' } } }))
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron: cronFalso(), agendarUmaVez: timerFalso().agendarUmaVez })
  await ag.executarAgora('manual')
  assert.equal(ag.estado().ultimaExecucao.clientesComErro, 1)
})

test('horário e início usam a escolha de cada cliente (automatica); o painel captura tudo', async () => {
  const opcoes = []
  const ciclo = { executarCiclo: async (o) => (opcoes.push(o), { ok: true, clientes: [] }) }
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron: cronFalso(), atrasoInicialMs: false })
  await ag.executarAgora('agendado')
  await ag.executarAgora('inicio')
  await ag.executarAgora('painel')
  assert.deepEqual(opcoes.map((o) => o.automatica), [true, true, false])
})

test('como o app abre (sem atraso pedido): não captura ao iniciar, só no horário', async () => {
  const cron = cronFalso()
  const timer = timerFalso()
  const ciclo = cicloFalso()
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron, agendarUmaVez: timer.agendarUmaVez })
  ag.iniciar()
  assert.deepEqual(timer.chamadas, [], 'nada agendado para logo depois de abrir')
  assert.equal(ciclo.chamadas.length, 0)
  await cron.tarefas[0].fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(ciclo.chamadas.length, 1, 'no horário, captura')
})

test('iniciarServidor agenda a organização da pasta 30 s depois de abrir, com conferência, e a para ao fechar', async () => {
  const cron = cronFalso()
  const agendados = []
  const relogio = { depois: (fn, ms) => (agendados.push({ fn, ms }), () => {}), aCada: () => () => {} }
  const chamadas = []
  const organizador = { agendar: (o) => chamadas.push(['agendar', o]), parar: async () => chamadas.push(['parar']) }
  const ctx = { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo: cicloFalso(), organizador }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false, relogio })
  const item = agendados.find((a) => a.ms === 30e3)
  item.fn()
  assert.deepEqual(chamadas, [['agendar', { conferirArquivos: true }]])
  await s.parar()
  assert.deepEqual(chamadas.at(-1), ['parar'])
})

test('iniciarServidor liga o fim do ciclo ao organizador', async () => {
  const cron = cronFalso()
  const chamadas = []
  const ctx = { config: { ...config, tpAmb: '2', sefazMock: true }, logger: silencioso, ciclo: cicloFalso(), deps: {}, organizador: { agendar: (...a) => chamadas.push(a), parar: async () => {} } }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false })
  ctx.deps.aoTerminarCiclo()
  assert.deepEqual(chamadas, [[]])
  await s.parar()
})

test('I8: horário pulado por falta de pasta: warn e chamada de aoPularSemPasta; troca em andamento segue em info e sem aviso', async () => {
  const logs = { info: [], warn: [] }
  const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {} }
  const movendo = { valor: false }
  const { ctx, ciclo } = ctxComPastas({ temPasta: { valor: false }, movendo })
  ctx.logger = logger
  const pulos = []
  const cron = cronFalso()
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron, comPainel: false, exigirPasta: true, aoPularSemPasta: () => pulos.push(1) })
  await cron.tarefas[0].fn()
  assert.equal(pulos.length, 1)
  assert.ok(logs.warn.some((m) => /captura ignorada/.test(m)))
  // Quem pediu à mão recebe o motivo na resposta: sem notificação repetida.
  await s.agendador.executarAgora('bandeja')
  assert.equal(pulos.length, 1)
  logs.info.length = 0
  logs.warn.length = 0
  movendo.valor = true
  await cron.tarefas[0].fn()
  assert.equal(pulos.length, 1)
  assert.ok(logs.info.some((m) => /captura ignorada/.test(m)))
  assert.ok(!logs.warn.some((m) => /captura ignorada/.test(m)))
  assert.equal(ciclo.chamadas.length, 0)
  await s.parar()
})

test('I8: erro em aoPularSemPasta não derruba o agendador', async () => {
  const { ctx } = ctxComPastas({ temPasta: { valor: false }, movendo: { valor: false } })
  const cron = cronFalso()
  const s = await iniciarServidor(ctx, {
    atrasoInicialMs: false,
    cron,
    comPainel: false,
    exigirPasta: true,
    aoPularSemPasta: () => {
      throw new Error('sem notificação')
    },
  })
  const r = await cron.tarefas[0].fn()
  assert.match(r.pulado, /Escolha a pasta principal/)
  await s.parar()
})

test('I6: parar() para a troca de pasta antes de fechar o resto', async () => {
  const chamadas = []
  const { ctx } = ctxComPastas({ temPasta: { valor: true }, movendo: { valor: false } })
  ctx.pastas.pararTroca = async () => {
    await new Promise((r) => setImmediate(r))
    chamadas.push('pararTroca')
  }
  ctx.organizador = { agendar() {}, parar: async () => chamadas.push('organizador') }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, relogio: { depois: () => () => {}, aCada: () => () => {} } })
  await s.parar()
  assert.deepEqual(chamadas, ['pararTroca', 'organizador'])
})

test('saída: pararTroca e passada que nunca terminam: 30 s cada, log, e segue fechando', async () => {
  const limites = []
  const relogio = { depois: (fn, ms) => (limites.push({ fn, ms }), () => {}), aCada: () => () => {} }
  const avisos = []
  const organizadorParado = []
  const ctx = {
    config: { ...config, tpAmb: '2', sefazMock: true },
    logger: { ...silencioso, warn: (m) => avisos.push(m) },
    ciclo: cicloFalso(),
    pastas: { movendoAgora: () => false, temPasta: () => true, pararTroca: () => new Promise(() => {}) },
    organizador: { agendar() {}, parar: () => (organizadorParado.push(1), new Promise(() => {})) },
    backup: { fazerBackup() {}, aguardar: async () => avisos.push('backup aguardado') },
  }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, relogio })
  const antes = limites.length
  let fechou = false
  const fim = s.parar().then(() => (fechou = true))
  const tique = () => new Promise((r) => setImmediate(r))
  await tique()
  assert.deepEqual(limites.slice(antes).map((l) => l.ms), [30e3])
  assert.equal(fechou, false)
  limites[antes].fn()
  await tique()
  assert.deepEqual(organizadorParado, [1])
  assert.deepEqual(limites.slice(antes).map((l) => l.ms), [30e3, 30e3])
  assert.equal(fechou, false)
  limites[antes + 1].fn()
  await fim
  assert.equal(avisos.filter((m) => /30 s/.test(m)).length, 2)
  assert.ok(avisos.includes('backup aguardado'), 'segue fechando')
})

test('saída: espera que termina a tempo cancela o limite e não avisa', async () => {
  const cancelados = []
  const relogio = { depois: (fn, ms) => () => cancelados.push(ms), aCada: () => () => {} }
  const avisos = []
  const ctx = {
    config: { ...config, tpAmb: '2', sefazMock: true },
    logger: { ...silencioso, warn: (m) => avisos.push(m) },
    ciclo: cicloFalso(),
    pastas: { movendoAgora: () => false, temPasta: () => true, pararTroca: async () => {} },
    organizador: { agendar() {}, parar: async () => {} },
  }
  const s = await iniciarServidor(ctx, { atrasoInicialMs: false, cron: cronFalso(), comPainel: false, relogio })
  await s.parar()
  assert.equal(cancelados.filter((ms) => ms === 30e3).length, 3, 'a organização de abertura e os dois limites')
  assert.deepEqual(avisos, [])
})
