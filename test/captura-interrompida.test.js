'use strict'

// App fechado ou atualizado no meio da captura: a execução não pode ficar aberta para sempre,
// o botão não pode travar em "Capturando…" e fechar não pode esperar a fila inteira.

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { criarServicoCapturaNfse } = require('../src/services/capturaNfse')
const { criarServicoCapturaCte } = require('../src/services/capturaCte')
const { montarAmbiente, AGORA } = require('./apoio/ambiente')
const { criarSefazMock, CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const CNPJ_B = '34567890000130'
const abrirExecucao = (db, id, inicio, tipo = 'captura') =>
  db.prepare('INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, ?, ?)').run(id, tipo, inicio).lastInsertRowid
const execucao = (db, id) => db.prepare('SELECT * FROM execucoes WHERE id = ?').get(id)
const ultimaExecucao = (db) => db.prepare('SELECT * FROM execucoes ORDER BY id DESC LIMIT 1').get()

// SEFAZ com a fila sempre maior que o lote: só termina se alguém mandar parar.
async function filaSemFim(aoConsultar) {
  const { docZip } = (await criarSefazMock({ cienciaDoDono: true, dataBase: AGORA }).cliente(CNPJ_MOCK_OK).consultaUltNSU('0')).data
  let chamadas = 0
  return {
    chamadas: () => chamadas,
    fabrica: (c) => ({
      async consultaUltNSU(nsu) {
        chamadas++
        await aoConsultar(chamadas, c)
        return { status: 200, data: { cStat: '138', xMotivo: 'ok', ultNSU: String(Number(nsu) + 10), maxNSU: '999999', docZip: chamadas === 1 ? docZip : [] } }
      },
      async consultaChNFe() {
        return { status: 200, data: { cStat: '137', docZip: [] } }
      },
    }),
  }
}

test('ao abrir, a execução sem fim deixada pelo app fechado é encerrada e não trava a captura', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const id = abrirExecucao(amb.db, amb.ids[0], new Date(AGORA.getTime() - 5 * 60e3).toISOString())
  const ciclo = criarServicoCiclo(amb.deps)
  assert.ok(ciclo.cicloEmAndamento(), 'antes: a linha aberta segura a trava')

  assert.equal(ciclo.encerrarOrfas(), 1)

  assert.equal(ciclo.cicloEmAndamento(), null)
  const e = execucao(amb.db, id)
  assert.ok(e.fim)
  assert.match(e.erro, /Interrompida/)
})

test('encerrar as órfãs não mexe em execução já terminada', (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const id = abrirExecucao(amb.db, amb.ids[0], '2026-10-01T10:00:00.000Z')
  amb.db.prepare("UPDATE execucoes SET fim = '2026-10-01T10:05:00.000Z' WHERE id = ?").run(id)
  assert.equal(criarServicoCiclo(amb.deps).encerrarOrfas(), 0)
  assert.equal(execucao(amb.db, id).fim, '2026-10-01T10:05:00.000Z')
  assert.equal(execucao(amb.db, id).erro, null)
})

test('parar: termina o lote atual, fecha a execução, guarda o NSU e não começa o próximo cliente', async (t) => {
  let ciclo
  let fimDoParar
  const sefaz = await filaSemFim((n) => {
    if (n === 1) fimDoParar = ciclo.parar()
  })
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B], fabrica: sefaz.fabrica })
  t.after(amb.limpar)
  ciclo = criarServicoCiclo(amb.deps)

  const r = await ciclo.executarCiclo({ modelos: ['nfe'] })
  await fimDoParar

  assert.equal(sefaz.chamadas(), 1, 'nenhuma consulta depois do pedido de parada')
  assert.equal(r.clientes.length, 1, 'o segundo cliente nem começa')
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM execucoes WHERE fim IS NULL').get().n, 0)
  assert.equal(Number(amb.db.prepare('SELECT ult_nsu FROM clientes WHERE id = ?').get(amb.ids[0]).ult_nsu), 10, 'a próxima captura continua daqui')
  assert.equal(ciclo.cicloEmAndamento(), null)
})

test('parar sem captura rodando termina na hora', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  await criarServicoCiclo(amb.deps).parar()
})

test('os documentos sobem na execução durante a captura, lote a lote', async (t) => {
  let ciclo
  let vistoNoSegundoLote
  const amb = {}
  const sefaz = await filaSemFim((n) => {
    if (n === 2) {
      vistoNoSegundoLote = ultimaExecucao(amb.db)
      ciclo.parar()
    }
  })
  Object.assign(amb, montarAmbiente({ fabrica: sefaz.fabrica }))
  t.after(amb.limpar)
  ciclo = criarServicoCiclo(amb.deps)

  await ciclo.executarCiclo({ modelos: ['nfe'] })

  assert.equal(vistoNoSegundoLote.fim, null)
  assert.ok(vistoNoSegundoLote.docs_recebidos > 0, 'o lote gravado já aparece enquanto roda')
})

test('o andamento diz qual empresa está rodando, na captura agendada também', async (t) => {
  let ciclo
  const vistos = []
  const sefaz = await filaSemFim(() => {
    vistos.push(ciclo.progresso())
    ciclo.parar()
  })
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B], fabrica: sefaz.fabrica })
  t.after(amb.limpar)
  ciclo = criarServicoCiclo(amb.deps)
  assert.equal(ciclo.progresso(), null)

  await ciclo.executarCiclo({ automatica: true, modelos: ['nfe'] })

  assert.deepEqual(vistos[0], { cnpj: CNPJ_MOCK_OK, nome: 'Cliente 1', posicao: 1, total: 2 })
  assert.equal(ciclo.progresso(), null, 'terminou: sem andamento')
})

for (const [nome, criar, chaveFabrica] of [
  ['NFS-e', criarServicoCapturaNfse, 'fabricaAdn'],
  ['CT-e', criarServicoCapturaCte, 'fabricaCte'],
]) {
  test(`${nome}: parada pedida antes de começar não abre execução`, async (t) => {
    const amb = montarAmbiente()
    t.after(amb.limpar)
    const r = await criar({ ...amb.deps, deveParar: () => true }).capturarCliente(amb.ids[0], { forcar: true })
    assert.ok(r.pulado)
    assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n, 0)
  })

  test(`${nome}: parada pedida no meio não consulta de novo e fecha a execução`, async (t) => {
    let consultas = 0
    const fabrica = () => ({
      consultarLote: async () => {
        consultas++
        return { ok: true, status: 200, documentos: [] }
      },
    })
    const amb = montarAmbiente({ [chaveFabrica]: fabrica })
    t.after(amb.limpar)
    let perguntas = 0
    const r = await criar({ ...amb.deps, deveParar: () => perguntas++ > 0 }).capturarCliente(amb.ids[0], { forcar: true })
    assert.equal(consultas, 0)
    assert.equal(r.ok, true)
    assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM execucoes WHERE fim IS NULL').get().n, 0)
    assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n, 1)
  })
}
