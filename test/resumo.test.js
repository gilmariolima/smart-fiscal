'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarServicoResumo } = require('../src/services/resumo')
const { montarAmbiente, inserirNotas, AGORA } = require('./apoio/ambiente')

const DIA = 86400e3

test('resumo: notas do mês corrente', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const [id] = amb.ids
  inserirNotas(amb.db, id, 3, { competencia: '2026-01' })
  inserirNotas(amb.db, id, 2, { competencia: '2025-12', inicio: 10 })
  inserirNotas(amb.db, id, 1, { competencia: '2025-11', inicio: 20 })
  const r = criarServicoResumo({ db: amb.db, agora: () => new Date('2026-01-15T12:00:00Z') }).resumo()
  assert.equal(r.competenciaAtual, '2026-01')
  assert.equal(r.notasNoMes, 3)
})

test('resumo: certificados no prazo, a vencer e vencidos (só ativos com validade)', (t) => {
  const amb = montarAmbiente({ clientes: ['11111111000111', '22222222000122', '33333333000133', '44444444000144', '55555555000155'] })
  t.after(amb.limpar)
  const validade = amb.db.prepare('UPDATE clientes SET cert_validade = ? WHERE id = ?')
  validade.run(new Date(AGORA.getTime() + 200 * DIA).toISOString(), amb.ids[0])
  validade.run(new Date(AGORA.getTime() + 10 * DIA).toISOString(), amb.ids[1])
  validade.run(new Date(AGORA.getTime() - 2 * DIA).toISOString(), amb.ids[2])
  validade.run(new Date(AGORA.getTime() - 2 * DIA).toISOString(), amb.ids[3])
  amb.db.prepare('UPDATE clientes SET ativo = 0 WHERE id = ?').run(amb.ids[3])
  // ids[4] fica sem validade: não entra na conta.
  const r = criarServicoResumo({ db: amb.db, agora: () => AGORA }).resumo()
  assert.deepEqual(r.certificados, { total: 3, noPrazo: 1, aVencer: 1, vencidos: 1 })
})

test('resumo: notas sem XML por situação (canceladas fora; esgotada pelo limite de tentativas)', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const [id] = amb.ids
  inserirNotas(amb.db, id, 2, { status: 'resumo' })
  inserirNotas(amb.db, id, 1, { status: 'resumo', cancelada: 1, inicio: 10 })
  inserirNotas(amb.db, id, 3, { status: 'ciencia_enviada', tentativas_download: 1, inicio: 20 })
  inserirNotas(amb.db, id, 1, { status: 'ciencia_enviada', tentativas_download: 5, inicio: 30 })
  inserirNotas(amb.db, id, 1, { status: 'ciencia_erro', inicio: 40 })
  inserirNotas(amb.db, id, 4, { status: 'completa', inicio: 50 })
  const r = criarServicoResumo({ db: amb.db, config: { maxTentativasDownload: 5 }, agora: () => AGORA }).resumo()
  assert.deepEqual(r.semXmlPorSituacao, { aguardandoCiencia: 2, aguardandoXml: 3, esgotada: 1, cienciaErro: 1 })
  assert.equal(r.notasSemXml, 7)
})
