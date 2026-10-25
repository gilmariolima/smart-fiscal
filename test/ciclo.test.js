'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { criarServicoManifestacao } = require('../src/services/manifestacao')
const { criarServicoDownload } = require('../src/services/download')
const { montarAmbiente, inserirNotas } = require('./apoio/ambiente')
const { criarSefazMock, CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO } = require('../src/sefaz/mock-client')

const CNPJ_B = '34567890000130'

/** Sefaz falsa que registra cada chamada de evento e de consulta por chave. */
function sefazRegistra() {
  const eventos = []
  const consultas = []
  return {
    eventos,
    consultas,
    fabrica: () => ({
      async enviarEvento({ idLote, lote }) {
        eventos.push(...lote.map((e) => e.chNFe))
        return {
          status: 200,
          data: { cStat: '128', xMotivo: 'ok', infEvento: lote.map((ev) => ({ chNFe: ev.chNFe, tpEvento: String(ev.tipoEvento), cStat: '135', xMotivo: 'x', nProt: '891260000000001', dhRegEvento: '2026-10-09T09:00:00-03:00' })) },
        }
      },
      async consultaChNFe(chave) {
        consultas.push(chave)
        return { status: 200, data: { cStat: '137', xMotivo: 'Nenhum documento localizado', docZip: [] } }
      },
    }),
  }
}

test('ciência ignora saídas', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [saida, entrada] = inserirNotas(amb.db, amb.ids[0], 2)
  amb.db.prepare("UPDATE notas SET tipo = 'saida' WHERE chave = ?").run(saida)

  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.pendentes, 1)
  assert.deepEqual(falsa.eventos, [entrada])
  assert.equal(amb.db.prepare('SELECT status FROM notas WHERE chave = ?').get(saida).status, 'resumo')
})

test('download ignora saídas', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [saida, entrada] = inserirNotas(amb.db, amb.ids[0], 2, { status: 'ciencia_enviada' })
  amb.db.prepare("UPDATE notas SET tipo = 'saida' WHERE chave = ?").run(saida)

  await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.deepEqual(falsa.consultas, [entrada])
  assert.equal(amb.db.prepare('SELECT tentativas_download n FROM notas WHERE chave = ?').get(saida).n, 0)
})

test('mesma chave em dois clientes: ciência e download de B só tocam a linha de B', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B], fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [chave] = inserirNotas(amb.db, amb.ids[0], 1, { status: 'ciencia_enviada' })
  inserirNotas(amb.db, amb.ids[1], 1)
  amb.db.prepare("UPDATE notas SET tipo = 'saida' WHERE cliente_id = ?").run(amb.ids[0])
  const linha = (id) => amb.db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?').get(id, chave)
  const antesA = linha(amb.ids[0])

  await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[1])
  assert.equal(linha(amb.ids[1]).status, 'ciencia_enviada')
  assert.ok(linha(amb.ids[1]).ciencia_protocolo)

  await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[1])
  assert.equal(linha(amb.ids[1]).tentativas_download, 1)
  assert.deepEqual(linha(amb.ids[0]), antesA)
})

test('manifestar com chave em dois clientes exige CNPJ', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B], fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [chave] = inserirNotas(amb.db, amb.ids[0], 1)
  inserirNotas(amb.db, amb.ids[1], 1)
  const ciclo = criarServicoCiclo(amb.deps)

  const r = await ciclo.manifestar({ chave, evento: 'confirmacao' })
  assert.equal(r.ok, false)
  assert.equal(r.erro, 'Chave em mais de um cliente: informe o CNPJ.')
  assert.deepEqual(falsa.eventos, [])

  const r2 = await ciclo.manifestar({ chave, evento: 'confirmacao', cnpj: CNPJ_B })
  assert.equal(r2.ok, true)
  assert.deepEqual(falsa.eventos, [chave])
  assert.equal((await ciclo.manifestar({ chave, evento: 'confirmacao', cnpj: '11111111000191' })).ok, false)
})

test('manifestar ignora a linha de saída quando a chave também é entrada de outro cliente', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B], fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [chave] = inserirNotas(amb.db, amb.ids[0], 1)
  inserirNotas(amb.db, amb.ids[1], 1)
  amb.db.prepare("UPDATE notas SET tipo = 'saida' WHERE cliente_id = ?").run(amb.ids[0])

  const r = await criarServicoCiclo(amb.deps).manifestar({ chave, evento: 'confirmacao' })
  assert.equal(r.ok, true)
})

test('ciclo: escritório primeiro, sem ciência e sem download', async (t) => {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO] })
  t.after(amb.limpar)
  amb.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(amb.ids[1])

  const r = await criarServicoCiclo(amb.deps).executarCiclo()
  assert.equal(r.ok, true)
  assert.equal(r.escritorio.cnpj, CNPJ_MOCK_ESCRITORIO)
  assert.equal(r.escritorio.captura.ok, true)
  assert.deepEqual(r.clientes.map((c) => c.cnpj), [CNPJ_MOCK_OK])

  assert.equal(amb.mock.chamadas[0].cnpj, CNPJ_MOCK_ESCRITORIO)
  const doEsc = amb.mock.chamadas.filter((c) => c.cnpj === CNPJ_MOCK_ESCRITORIO)
  assert.ok(doEsc.length > 0)
  assert.ok(doEsc.every((c) => c.metodo === 'consultaUltNSU'))
  assert.ok(amb.mock.chamadas.some((c) => c.cnpj === CNPJ_MOCK_OK))

  // A nota "a" do cliente chegou completa pelo escritório, sem ciência.
  const entradas = amb.db.prepare("SELECT * FROM notas WHERE tipo = 'entrada' AND cliente_id = ?").all(amb.ids[0])
  assert.ok(entradas.some((n) => n.status === 'completa' && !n.ciencia_protocolo))
  assert.equal(amb.db.prepare("SELECT COUNT(*) n FROM notas WHERE cliente_id = ?").get(amb.ids[1]).n, 0)
})

test('ciclo: --cnpj do escritório roda só a captura dele', async (t) => {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO] })
  t.after(amb.limpar)
  amb.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(amb.ids[1])

  const r = await criarServicoCiclo(amb.deps).executarCiclo({ cnpj: CNPJ_MOCK_ESCRITORIO })
  assert.equal(r.ok, true)
  assert.equal(r.escritorio.cnpj, CNPJ_MOCK_ESCRITORIO)
  assert.deepEqual(r.clientes, [])
  assert.ok(amb.mock.chamadas.every((c) => c.cnpj === CNPJ_MOCK_ESCRITORIO))
})

test('manifestar com CNPJ recusa nota de saída', async (t) => {
  const falsa = sefazRegistra()
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [chave] = inserirNotas(amb.db, amb.ids[0], 1)
  amb.db.prepare("UPDATE notas SET tipo = 'saida'").run()

  const r = await criarServicoCiclo(amb.deps).manifestar({ chave, evento: 'confirmacao', cnpj: CNPJ_MOCK_OK })
  assert.equal(r.ok, false)
  assert.equal(r.erro, 'Manifestação só vale para nota de entrada.')
  assert.deepEqual(falsa.eventos, [])
})

test('ciclo: captura do escritório que falha não impede os clientes', async (t) => {
  const mock = criarSefazMock()
  const fabrica = (c) => {
    if (c.cnpj === CNPJ_MOCK_ESCRITORIO) throw new Error('certificado do escritório inválido')
    return mock.cliente(c.cnpj)
  }
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO], mock, fabrica })
  t.after(amb.limpar)
  amb.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(amb.ids[1])

  const r = await criarServicoCiclo(amb.deps).executarCiclo()
  assert.equal(r.ok, true)
  assert.equal(r.escritorio.cnpj, CNPJ_MOCK_ESCRITORIO)
  assert.equal(r.escritorio.captura.ok, false)
  assert.match(r.escritorio.captura.erro || r.escritorio.erro, /certificado do escritório inválido/)
  assert.equal(r.clientes.length, 1)
  assert.equal(r.clientes[0].captura.ok, true)
})

test('somenteCiencia e somenteDownload com o CNPJ do escritório não fazem nada', async (t) => {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO] })
  t.after(amb.limpar)
  amb.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(amb.ids[1])
  const ciclo = criarServicoCiclo(amb.deps)

  for (const r of [await ciclo.somenteCiencia({ cnpj: CNPJ_MOCK_ESCRITORIO }), await ciclo.somenteDownload({ cnpj: CNPJ_MOCK_ESCRITORIO }), await ciclo.cienciaEDownload({ cnpj: CNPJ_MOCK_ESCRITORIO })]) {
    assert.equal(r.ok, true)
    assert.deepEqual(r.clientes, [])
    assert.equal(r.escritorio, undefined)
  }
  assert.deepEqual(amb.mock.chamadas, [])
})

const CNPJ_C = '45678901000140'

function ambienteLista() {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_OK, CNPJ_B, CNPJ_C, CNPJ_MOCK_ESCRITORIO] })
  amb.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(amb.ids[3])
  const ordem = () => [...new Set(amb.mock.chamadas.filter((c) => c.metodo === 'consultaUltNSU').map((c) => c.cnpj))]
  return { amb, ordem }
}

test('executarCiclo com cnpjs roda o escritório antes e só os clientes da lista', async (t) => {
  const { amb, ordem } = ambienteLista()
  t.after(amb.limpar)

  const r = await criarServicoCiclo(amb.deps).executarCiclo({ cnpjs: [CNPJ_C, CNPJ_MOCK_OK] })
  assert.equal(r.ok, true)
  assert.deepEqual(ordem(), [CNPJ_MOCK_ESCRITORIO, CNPJ_MOCK_OK, CNPJ_C])
  assert.deepEqual(r.clientes.map((c) => c.cnpj), [CNPJ_MOCK_OK, CNPJ_C])
})

test('executarCiclo com cnpjs ignora cliente desativado da lista', async (t) => {
  const { amb } = ambienteLista()
  t.after(amb.limpar)
  amb.db.prepare('UPDATE clientes SET ativo = 0 WHERE id = ?').run(amb.ids[1])

  const r = await criarServicoCiclo(amb.deps).executarCiclo({ cnpjs: [CNPJ_MOCK_OK, CNPJ_B, CNPJ_C] })
  assert.deepEqual(r.clientes.map((c) => c.cnpj), [CNPJ_MOCK_OK, CNPJ_C])
})

test('executarCiclo com cnpjs recusa CNPJ inexistente e do escritório', async (t) => {
  const { amb } = ambienteLista()
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)

  const a = await ciclo.executarCiclo({ cnpjs: [CNPJ_MOCK_OK, '00000000000000'] })
  assert.deepEqual(a, { ok: false, erro: 'CNPJ 00000000000000 não cadastrado.', clientes: [] })
  const b = await ciclo.executarCiclo({ cnpjs: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO] })
  assert.equal(b.ok, false)
  assert.match(b.erro, /é do escritório/)
  assert.deepEqual(amb.mock.chamadas, [])
})

test('aoIniciarCliente é chamado para o escritório e para cada cliente, em ordem', async (t) => {
  const { amb } = ambienteLista()
  t.after(amb.limpar)
  const chamadas = []

  await criarServicoCiclo(amb.deps).executarCiclo({ cnpjs: [CNPJ_C, CNPJ_MOCK_OK], aoIniciarCliente: (c) => chamadas.push(c) })
  assert.deepEqual(chamadas, [CNPJ_MOCK_ESCRITORIO, CNPJ_MOCK_OK, CNPJ_C])
})

test('aoIniciarCliente que lança não interrompe o ciclo', async (t) => {
  const { amb } = ambienteLista()
  t.after(amb.limpar)

  const r = await criarServicoCiclo(amb.deps).executarCiclo({ cnpjs: [CNPJ_MOCK_OK], aoIniciarCliente: () => { throw new Error('falha') } })
  assert.equal(r.ok, true)
  assert.equal(r.clientes.length, 1)
  assert.equal(r.clientes[0].captura.ok, true)
})

test('cliente bloqueado pelo 656 na lista é pulado com o motivo', async (t) => {
  const { amb } = ambienteLista()
  t.after(amb.limpar)
  const futuro = new Date(amb.deps.agora().getTime() + 3600e3).toISOString()
  amb.db.prepare('UPDATE clientes SET bloqueado_ate = ? WHERE id = ?').run(futuro, amb.ids[1])

  const r = await criarServicoCiclo(amb.deps).executarCiclo({ cnpjs: [CNPJ_B] })
  assert.match(r.clientes[0].captura.pulado, /^bloqueado até/)
})
