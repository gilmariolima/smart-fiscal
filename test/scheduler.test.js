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
  return { chamadas, executarCiclo: async () => (chamadas.push(1), impl ? impl() : { ok: true, clientes: [{ cnpj: '1' }, { cnpj: '2', erro: 'x' }] }) }
}

test('agenda o ciclo na expressão do .env e roda um ciclo logo depois de iniciar', async () => {
  const cron = cronFalso()
  const timer = timerFalso()
  const ciclo = cicloFalso()
  const ag = criarAgendador({ ciclo, config, logger: silencioso, cron, agendarUmaVez: timer.agendarUmaVez })
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
