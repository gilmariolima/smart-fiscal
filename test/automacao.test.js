'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const nodeCron = require('node-cron')
const { criarAutomacao } = require('../src/services/automacao')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { criarAgendador } = require('../src/scheduler')
const { montarAmbiente, silencioso } = require('./apoio/ambiente')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const ciencias = (db) => db.prepare("SELECT COUNT(*) n FROM eventos WHERE tp_evento = '210210'").get().n
const resumosPendentes = (db) => db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'resumo' AND cancelada = 0").get().n

test('automação: as duas começam ligadas, mudam e ficam salvas no banco', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const a = criarAutomacao(amb.deps)
  assert.deepEqual(a.obter(), { captura: true, ciencia: true })
  assert.deepEqual(a.definir({ ciencia: false }), { captura: true, ciencia: false })
  assert.deepEqual(criarAutomacao(amb.deps).obter(), { captura: true, ciencia: false })
  assert.deepEqual(a.definir({ captura: false, ciencia: true }), { captura: false, ciencia: true })
  assert.throws(() => a.definir({ ciencia: 'sim' }), /Valor inválido/)
  assert.throws(() => a.definir({ outra: true }), /desconhecida/)
})

test('ciência automática desligada: o ciclo só busca; "Dar ciência" envia e baixa', async (t) => {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK] })
  t.after(amb.limpar)
  criarAutomacao(amb.deps).definir({ ciencia: false })
  const ciclo = criarServicoCiclo(amb.deps)

  const r = await ciclo.executarCiclo()
  assert.equal(r.ok, true)
  assert.equal(r.clientes[0].ciencia.pulado, 'ciência automática desligada')
  assert.equal(ciencias(amb.db), 0)
  assert.ok(resumosPendentes(amb.db) > 0)

  const r2 = await ciclo.cienciaEDownload({ cnpj: CNPJ_MOCK_OK })
  assert.equal(r2.ok, true)
  assert.ok(r2.clientes[0].ciencia.enviadas > 0)
  assert.ok(ciencias(amb.db) > 0)
  assert.equal(resumosPendentes(amb.db), 0)
  assert.equal(amb.db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'ciencia_enviada'").get().n, 0)
})

test('busca automática desligada: horário e início são ignorados; disparo à mão roda', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const automacao = criarAutomacao(amb.deps)
  const chamadas = []
  const ciclo = { executarCiclo: async () => (chamadas.push(1), { ok: true, clientes: [] }) }
  const tarefas = []
  const cron = { validate: nodeCron.validate, schedule: (e, fn) => (tarefas.push(fn), { destroy() {}, getNextRun: () => new Date('2026-10-10T11:00:00Z') }) }
  const iniciais = []
  const ag = criarAgendador({ ciclo, config: { cronCaptura: '0 8,13 * * *' }, logger: silencioso, automacao, cron, agendarUmaVez: (fn) => iniciais.push(fn) })
  ag.iniciar()

  automacao.definir({ captura: false })
  iniciais[0]()
  assert.equal((await tarefas[0]()).pulado, 'busca automática desligada')
  assert.equal(chamadas.length, 0)
  assert.equal(ag.estado().automatica, false)
  assert.equal(ag.estado().proximaExecucao, null)

  await ag.executarAgora('painel')
  assert.equal(chamadas.length, 1)

  automacao.definir({ captura: true })
  await tarefas[0]()
  assert.equal(chamadas.length, 2)
  assert.equal(ag.estado().proximaExecucao, '2026-10-10T11:00:00.000Z')
})
