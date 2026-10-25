'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarServicoManifestacao } = require('../src/services/manifestacao')
const { criarServicoCaptura } = require('../src/services/captura')
const { montarAmbiente, inserirNotas, nota } = require('./apoio/ambiente')

// SEFAZ falsa de eventos: grava os lotes recebidos e responde com `responder(lote)`.
function sefazEventos(responder) {
  const lotes = []
  return {
    lotes,
    fabrica: () => ({
      async enviarEvento({ idLote, lote }) {
        lotes.push({ idLote, lote })
        return responder(lote)
      },
    }),
  }
}

const retorno = (lote, cStat = () => '135') => ({
  status: 200,
  data: {
    cStat: '128',
    xMotivo: 'Lote de evento processado',
    infEvento: lote.map((ev, i) => ({ chNFe: ev.chNFe, tpEvento: String(ev.tipoEvento), cStat: cStat(ev, i), xMotivo: 'x', nProt: `89126000000${String(i).padStart(4, '0')}`, dhRegEvento: '2026-10-09T09:00:00-03:00' })),
  },
})

test('ciência em lotes de no máximo 20, com pausa entre lotes', async (t) => {
  const falsa = sefazEventos((lote) => retorno(lote))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const chaves = inserirNotas(amb.db, amb.ids[0], 45)

  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.ok, true)
  assert.deepEqual(falsa.lotes.map((l) => l.lote.length), [20, 20, 5])
  assert.ok(falsa.lotes.every((l) => l.lote.every((ev) => ev.tipoEvento === 210210)), 'só ciência')
  assert.ok(falsa.lotes.every((l) => /^\d{1,15}$/.test(l.idLote)), 'idLote numérico até 15 dígitos')
  assert.equal(new Set(falsa.lotes.map((l) => l.idLote)).size, 3, 'idLote único por envio')
  assert.deepEqual(amb.pausas, [2000, 2000])
  assert.equal(r.enviadas, 45)

  const n = nota(amb.db, chaves[0])
  assert.equal(n.status, 'ciencia_enviada')
  assert.equal(n.ciencia_protocolo, '891260000000000')
  assert.equal(n.ciencia_em, '2026-10-09T09:00:00-03:00')
  assert.equal(amb.db.prepare("SELECT COUNT(*) n FROM eventos WHERE tp_evento = '210210'").get().n, 45)
  const exec = amb.db.prepare("SELECT * FROM execucoes WHERE tipo = 'ciencia'").get()
  assert.equal(exec.docs_recebidos, 45)
  assert.ok(exec.fim)
})

test('573 conta como sucesso; rejeição vira ciencia_erro; sem retorno continua em resumo', async (t) => {
  const falsa = sefazEventos((lote) => {
    const r = retorno(lote, (ev, i) => ['135', '573', '650'][i])
    r.data.infEvento = r.data.infEvento.slice(0, 3)
    return r
  })
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [a, b, c, d] = inserirNotas(amb.db, amb.ids[0], 4)

  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.deepEqual([r.enviadas, r.erros, r.semRetorno], [2, 1, 1])
  assert.equal(nota(amb.db, a).status, 'ciencia_enviada')
  assert.equal(nota(amb.db, b).status, 'ciencia_enviada')
  assert.equal(nota(amb.db, c).status, 'ciencia_erro')
  assert.equal(nota(amb.db, c).ciencia_erro, '650 x')
  assert.equal(nota(amb.db, d).status, 'resumo')
})

test('falha de comunicação mantém as notas em resumo e para o cliente', async (t) => {
  const falsa = sefazEventos(() => ({ error: 'ECONNRESET', data: {} }))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const chaves = inserirNotas(amb.db, amb.ids[0], 30)

  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.ok, false)
  assert.equal(falsa.lotes.length, 1, 'não insiste nos outros lotes')
  assert.ok(chaves.every((ch) => nota(amb.db, ch).status === 'resumo'))
  assert.match(amb.db.prepare("SELECT erro FROM execucoes WHERE tipo = 'ciencia'").get().erro, /ECONNRESET/)
})

test('lote rejeitado: serviço paralisado (108) mantém resumo; outra rejeição marca erro', async (t) => {
  for (const [cStat, esperado] of [['108', 'resumo'], ['215', 'ciencia_erro']]) {
    const falsa = sefazEventos(() => ({ status: 200, data: { cStat, xMotivo: 'Rejeicao', infEvento: [] } }))
    const amb = montarAmbiente({ fabrica: falsa.fabrica })
    t.after(amb.limpar)
    const [ch] = inserirNotas(amb.db, amb.ids[0], 2)
    const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
    assert.equal(r.ok, false)
    assert.equal(nota(amb.db, ch).status, esperado, `cStat ${cStat}`)
  }
})

test('não envia ciência de nota cancelada, denegada ou que já passou da fase de resumo', async (t) => {
  const falsa = sefazEventos((lote) => retorno(lote))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  inserirNotas(amb.db, amb.ids[0], 1, { cancelada: 1 })
  inserirNotas(amb.db, amb.ids[0], 1, { inicio: 2, situacao_sefaz: '2' })
  inserirNotas(amb.db, amb.ids[0], 1, { inicio: 3, status: 'ciencia_erro' })
  inserirNotas(amb.db, amb.ids[0], 1, { inicio: 4, status: 'completa' })
  const [ok] = inserirNotas(amb.db, amb.ids[0], 1, { inicio: 5 })

  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.pendentes, 1)
  assert.deepEqual(falsa.lotes[0].lote.map((e) => e.chNFe), [ok])
})

test('sem pendências não chama a SEFAZ nem registra execução', async (t) => {
  const falsa = sefazEventos((lote) => retorno(lote))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.pendentes, 0)
  assert.equal(falsa.lotes.length, 0)
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n, 0)
})

test('com a SEFAZ simulada: ciência das notas capturadas; a cancelada fica de fora', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  await criarServicoCaptura(amb.deps).capturarCliente(amb.ids[0])
  const r = await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  assert.equal(r.pendentes, 1)
  assert.equal(r.enviadas, 1)
  const status = amb.db.prepare('SELECT status, cancelada FROM notas ORDER BY id').all()
  assert.deepEqual(status, [
    { status: 'ciencia_enviada', cancelada: 0 },
    { status: 'resumo', cancelada: 1 },
    { status: 'completa', cancelada: 0 },
  ])
})

test('manifestação manual: valida evento e justificativa, registra o evento e não muda o status', async (t) => {
  const falsa = sefazEventos((lote) => retorno(lote))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [ch] = inserirNotas(amb.db, amb.ids[0], 1, { status: 'completa' })
  const s = criarServicoManifestacao(amb.deps)

  assert.match((await s.manifestar({ chave: ch, evento: 'ciencia' })).erro, /Evento inválido/)
  assert.match((await s.manifestar({ chave: ch, evento: 'nao-realizada', justificativa: 'curta' })).erro, /15 a 255/)
  assert.match((await s.manifestar({ chave: '9'.repeat(44), evento: 'confirmacao' })).erro, /não encontrada/)
  assert.equal(falsa.lotes.length, 0)

  const r = await s.manifestar({ chave: ch, evento: 'nao-realizada', justificativa: 'Mercadoria nao foi entregue no endereco' })
  assert.equal(r.ok, true)
  assert.deepEqual(falsa.lotes[0].lote, [{ chNFe: ch, tipoEvento: 210240, justificativa: 'Mercadoria nao foi entregue no endereco' }])
  assert.equal(nota(amb.db, ch).status, 'completa')
  assert.equal(amb.db.prepare("SELECT descricao FROM eventos WHERE tp_evento = '210240'").get().descricao, 'Operacao nao Realizada')

  const conf = await s.manifestar({ chave: ch, evento: 'confirmacao' })
  assert.equal(conf.ok, true)
  assert.equal(falsa.lotes[1].lote[0].tipoEvento, 210200)
})

test('manifestação manual rejeitada devolve o motivo', async (t) => {
  const falsa = sefazEventos((lote) => retorno(lote, () => '596'))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  const [ch] = inserirNotas(amb.db, amb.ids[0], 1)
  const r = await criarServicoManifestacao(amb.deps).manifestar({ chave: ch, evento: 'desconhecimento' })
  assert.equal(r.ok, false)
  assert.equal(r.cStat, '596')
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 0)
})
