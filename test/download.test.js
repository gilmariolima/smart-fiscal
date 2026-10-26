'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { criarServicoDownload } = require('../src/services/download')
const { criarServicoCaptura } = require('../src/services/captura')
const { criarServicoManifestacao } = require('../src/services/manifestacao')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { montarAmbiente, inserirNotas, nota, AGORA } = require('./apoio/ambiente')
const { CNPJ_MOCK_OK, CNPJ_MOCK_656, criarSefazMock } = require('../src/sefaz/mock-client')

function sefazChave(responder) {
  const consultas = []
  return {
    consultas,
    fabrica: () => ({
      async consultaChNFe(chave) {
        consultas.push(chave)
        return responder(chave, consultas.length)
      },
    }),
  }
}

const so137 = () => ({ status: 200, data: { cStat: '137', xMotivo: 'Nenhum documento localizado', docZip: [] } })

test('com a SEFAZ simulada: captura → ciência → download deixa a nota completa', async (t) => {
  const amb = montarAmbiente({ mock: criarSefazMock() })
  t.after(amb.limpar)
  await criarServicoCaptura(amb.deps).capturarCliente(amb.ids[0])
  await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])

  const r = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(r.ok, true)
  assert.deepEqual([r.consultas, r.baixadas], [1, 1])
  const n = amb.db.prepare("SELECT * FROM notas WHERE ciencia_protocolo IS NOT NULL").get()
  assert.equal(n.status, 'completa')
  assert.equal(n.tentativas_download, 1)
  assert.ok(fs.existsSync(path.join(amb.pastaXmls, n.caminho_xml)))
  assert.equal(amb.db.prepare("SELECT docs_recebidos FROM execucoes WHERE tipo = 'download'").get().docs_recebidos, 1)

  const de_novo = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(de_novo.consultas, 0)
})

test('limita as consultas por chave por ciclo e conta as tentativas', async (t) => {
  const falsa = sefazChave(so137)
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  inserirNotas(amb.db, amb.ids[0], 30, { status: 'ciencia_enviada' })

  const r = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(r.consultas, 20)
  assert.equal(r.indisponiveis, 20)
  assert.equal(amb.pausas.length, 19)
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM notas WHERE tentativas_download = 1').get().n, 20)

  // No ciclo seguinte, as 10 que ainda não foram tentadas vêm primeiro.
  await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM notas WHERE tentativas_download = 0').get().n, 0)
})

test('nota que atingiu MAX_TENTATIVAS_DOWNLOAD não é mais consultada', async (t) => {
  const falsa = sefazChave(so137)
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  inserirNotas(amb.db, amb.ids[0], 1, { status: 'ciencia_enviada', tentativas_download: 5 })
  const [ch] = inserirNotas(amb.db, amb.ids[0], 1, { inicio: 2, status: 'ciencia_enviada', tentativas_download: 4 })
  await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.deepEqual(falsa.consultas, [ch])
})

test('só o resumo de volta: nota continua em ciencia_enviada', async (t) => {
  const mock = criarSefazMock()
  const amb = montarAmbiente({ mock })
  t.after(amb.limpar)
  await criarServicoCaptura(amb.deps).capturarCliente(amb.ids[0])
  // Marca como ciência enviada sem passar pela SEFAZ simulada (que liberaria o XML).
  amb.db.prepare("UPDATE notas SET status = 'ciencia_enviada' WHERE status = 'resumo' AND cancelada = 0").run()
  const r = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.deepEqual([r.consultas, r.baixadas, r.indisponiveis], [1, 0, 1])
  assert.equal(amb.db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'ciencia_enviada'").get().n, 1)
})

test('656 no download bloqueia o cliente por 1 h e para', async (t) => {
  const falsa = sefazChave(() => ({ status: 200, data: { cStat: '656', xMotivo: 'Rejeicao: Consumo Indevido' } }))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  inserirNotas(amb.db, amb.ids[0], 5, { status: 'ciencia_enviada' })
  const r = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(r.ok, false)
  assert.equal(falsa.consultas.length, 1)
  const c = amb.db.prepare('SELECT * FROM clientes').get()
  assert.equal(c.bloqueado_ate, new Date(AGORA.getTime() + 3600e3).toISOString())

  const depois = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.match(depois.pulado, /bloqueado/)
  assert.equal(falsa.consultas.length, 1)
})

test('erro de comunicação para o download do cliente', async (t) => {
  const falsa = sefazChave(() => ({ error: 'timeout', data: {} }))
  const amb = montarAmbiente({ fabrica: falsa.fabrica })
  t.after(amb.limpar)
  inserirNotas(amb.db, amb.ids[0], 5, { status: 'ciencia_enviada' })
  const r = await criarServicoDownload(amb.deps).baixarPendentes(amb.ids[0])
  assert.equal(r.ok, false)
  assert.equal(falsa.consultas.length, 1)
})

test('ciclo completo com a SEFAZ simulada; rodar de novo não duplica nada', async (t) => {
  const amb = montarAmbiente({ clientes: [CNPJ_MOCK_656, CNPJ_MOCK_OK] })
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)

  const r = await ciclo.executarCiclo()
  assert.equal(r.ok, true)
  assert.equal(r.clientes.length, 2)
  assert.equal(r.clientes[0].captura.cStat, '656')
  assert.equal(r.clientes[1].ciencia, undefined)
  assert.equal(r.clientes[1].download.consultas, 0, 'o XML veio pela fila de NSU, depois da ciência do dono')

  const status = amb.db.prepare('SELECT status, cancelada FROM notas ORDER BY id').all()
  assert.deepEqual(status, [
    { status: 'completa', cancelada: 0 },
    { status: 'resumo', cancelada: 1 },
    { status: 'completa', cancelada: 0 },
  ])
  const arquivos = () => fs.readdirSync(amb.pastaXmls, { recursive: true }).filter((f) => f.endsWith('.xml')).sort()
  const antes = arquivos()

  const r2 = await ciclo.executarCiclo({ forcar: true })
  assert.equal(r2.ok, true)
  assert.equal(amb.db.prepare('SELECT COUNT(*) n FROM notas').get().n, 3)
  assert.deepEqual(arquivos(), antes)
})

test('trava: dois ciclos ao mesmo tempo no mesmo processo', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)
  const [a, b] = await Promise.all([ciclo.executarCiclo(), ciclo.executarCiclo()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.match(b.erro, /já existe um ciclo/i)
  assert.equal(ciclo.cicloEmAndamento(), null, 'trava liberada no fim')
})

test('trava pelo banco: execução aberta recente bloqueia; antiga (processo caído) não', async (t) => {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)
  const ins = amb.db.prepare("INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (NULL, 'captura', ?)")

  const recente = ins.run(new Date(AGORA.getTime() - 5 * 60e3).toISOString()).lastInsertRowid
  const r = await ciclo.executarCiclo()
  assert.equal(r.ok, false)
  assert.match(r.erro, /em andamento/)

  amb.db.prepare('UPDATE execucoes SET inicio = ? WHERE id = ?').run(new Date(AGORA.getTime() - 31 * 60e3).toISOString(), recente)
  assert.equal((await ciclo.executarCiclo()).ok, true)
})

test('ciclo: CNPJ não cadastrado e download isolado das notas com ciência enviada antes', async (t) => {
  const amb = montarAmbiente({ mock: criarSefazMock() })
  t.after(amb.limpar)
  const ciclo = criarServicoCiclo(amb.deps)
  assert.match((await ciclo.executarCiclo({ cnpj: '00000000000000' })).erro, /não cadastrado/)

  await criarServicoCaptura(amb.deps).capturarCliente(amb.ids[0])
  await criarServicoManifestacao(amb.deps).enviarCiencias(amb.ids[0])
  const d = await ciclo.somenteDownload({ cnpj: CNPJ_MOCK_OK })
  assert.equal(d.clientes[0].download.baixadas, 1)
  assert.ok(nota(amb.db, amb.db.prepare("SELECT chave FROM notas WHERE ciencia_protocolo IS NOT NULL").get().chave).caminho_xml)
})
