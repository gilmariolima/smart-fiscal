'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const nodeCron = require('node-cron')
const { criarAutomacao } = require('../src/services/automacao')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { criarAgendador } = require('../src/scheduler')
const { montarAmbiente, silencioso } = require('./apoio/ambiente')
const { criarSefazMock, CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const ciencias = (db) => db.prepare("SELECT COUNT(*) n FROM eventos WHERE tp_evento = '210210'").get().n
const resumosPendentes = (db) => db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'resumo' AND cancelada = 0").get().n

test('automação: a busca começa ligada, muda e fica salva no banco', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const a = criarAutomacao(amb.deps)
  assert.deepEqual(a.obter(), { captura: true })
  assert.deepEqual(a.definir({ captura: false }), { captura: false })
  assert.deepEqual(criarAutomacao(amb.deps).obter(), { captura: false })
  assert.throws(() => a.definir({ captura: 'sim' }), /Valor inválido/)
  assert.throws(() => a.definir({ ciencia: true }), /desconhecida/)
})

test('o ciclo não dá ciência: a nota espera o dono e o XML chega na captura seguinte', async (t) => {
  const mock = criarSefazMock()
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK], mock })
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)

  const r = await ciclo.executarCiclo()
  assert.equal(r.ok, true)
  assert.equal(r.clientes[0].ciencia, undefined)
  assert.equal(ciencias(amb.db), 0)
  assert.equal(resumosPendentes(amb.db), 1)
  assert.ok(!mock.chamadas.some((c) => c.metodo === 'enviarEvento'))

  // O dono da empresa dá ciência no sistema dele
  const { chave } = amb.db.prepare("SELECT chave FROM notas WHERE status = 'resumo' AND cancelada = 0").get()
  await mock.cliente(CNPJ_MOCK_OK).enviarEvento({ idLote: '1', lote: [{ chNFe: chave, tipoEvento: 210210 }] })

  await ciclo.executarCiclo({ forcar: true })
  assert.equal(resumosPendentes(amb.db), 0)
  assert.equal(amb.db.prepare('SELECT status FROM notas WHERE chave = ?').get(chave).status, 'completa')
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

test('automação: horários da busca ficam salvos, em ordem e sem repetir', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const a = criarAutomacao(amb.deps)
  assert.equal(a.horarios(), null)
  assert.deepEqual(a.definirHorarios(['13:00', '08:30', '13:00']), ['08:30', '13:00'])
  assert.deepEqual(criarAutomacao(amb.deps).horarios(), ['08:30', '13:00'])
  assert.deepEqual(a.definirHorarios([]), [])
  assert.deepEqual(a.horarios(), [])
  assert.throws(() => a.definirHorarios(['24:00']), /inválido/)
  assert.throws(() => a.definirHorarios(['8h']), /inválido/)
})

test('agendador: horários do painel substituem o cron do .env e trocam sem reiniciar', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const automacao = criarAutomacao(amb.deps)
  const tarefas = []
  const cron = {
    validate: nodeCron.validate,
    schedule(expressao) {
      const t = { expressao, destruida: false, destroy() { t.destruida = true }, getNextRun: () => null }
      tarefas.push(t)
      return t
    },
  }
  const ag = criarAgendador({ ciclo: { executarCiclo: async () => ({ ok: true, clientes: [] }) }, config: { cronCaptura: '0 8,13 * * *' }, logger: silencioso, automacao, cron, atrasoInicialMs: false })
  ag.iniciar()
  assert.deepEqual(tarefas.map((x) => x.expressao), ['0 8,13 * * *'])
  assert.deepEqual(ag.estado().horarios, ['08:00', '13:00'])

  automacao.definirHorarios(['07:30', '18:00'])
  await ag.reagendar()
  assert.deepEqual(tarefas.filter((x) => !x.destruida).map((x) => x.expressao), ['30 7 * * *', '0 18 * * *'])
  assert.equal(tarefas[0].destruida, true)
  assert.deepEqual(ag.estado().horarios, ['07:30', '18:00'])

  // Sem horário nenhum: nada agendado, e o .env não volta a valer.
  automacao.definirHorarios([])
  await ag.reagendar()
  assert.equal(tarefas.filter((x) => !x.destruida).length, 0)
  assert.deepEqual(ag.estado().horarios, [])
  assert.equal(ag.estado().ativo, true)
  await ag.parar()
  assert.ok(tarefas.every((x) => x.destruida))
})
