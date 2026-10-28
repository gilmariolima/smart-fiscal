'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { criarServicoCapturaNfse } = require('../src/services/capturaNfse')
const { criarAdnMock, nfse, eventoNfse, chaveNfse, documentosPadrao, PRESTADOR_MOCK } = require('../src/sefaz/adn-mock')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const AGORA = new Date('2026-10-27T12:00:00Z')
const UMA_HORA = new Date(AGORA.getTime() + 3600e3).toISOString()

function montar({ mock = criarAdnMock(), config = {} } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-'))
  const db = abrirBanco(':memory:')
  const id = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Cliente 1 Ltda', 'Cliente 1', 'CE', 'x.pfx', 'a:b:c')`).run(CNPJ_MOCK_OK).lastInsertRowid
  const avisos = []
  const pausas = []
  const servico = criarServicoCapturaNfse({
    db,
    config: { pastaXmls, intervaloEntreChamadasMs: 2000, ...config },
    logger: { info() {}, warn: (m, d) => avisos.push([m, d]), error() {} },
    fabricaAdn: (c) => mock.cliente(c.cnpj),
    dormir: async (ms) => pausas.push(ms),
    agora: () => AGORA,
  })
  return { db, servico, mock, id, avisos, pausas, pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const cliente = (db, id) => db.prepare('SELECT * FROM clientes WHERE id = ?').get(id)
const notas = (db) => db.prepare('SELECT * FROM notas ORDER BY numero').all()
const arquivos = (pasta) => fs.readdirSync(pasta, { recursive: true }).filter((f) => f.endsWith('.xml')).map((f) => f.replace(/\\/g, '/')).sort()

test('grava entradas e saídas nas pastas certas e marca a espera de 1 h', async (t) => {
  const { db, servico, id, pastaXmls, limpar } = montar()
  t.after(limpar)
  const r = await servico.capturarCliente(id)
  assert.deepEqual({ ok: r.ok, docs: r.docs, notas: r.notas, eventos: r.eventos, entradas: r.entradas, saidas: r.saidas, lotes: r.lotes }, { ok: true, docs: 4, notas: 3, eventos: 1, entradas: 2, saidas: 1, lotes: 1 })

  const [n1, n2, n3] = notas(db)
  assert.deepEqual([n1.tipo, n2.tipo, n3.tipo], ['entrada', 'entrada', 'saida'])
  assert.ok([n1, n2, n3].every((n) => n.modelo === 'nfse' && n.status === 'completa' && n.competencia === '2026-10'))
  assert.equal(n1.cancelada, 1, 'o evento 101101 cancela a nota')
  assert.equal(n2.valor_total, 320.55)
  assert.equal(n1.emitente_cnpj, PRESTADOR_MOCK)
  assert.equal(n1.destinatario_cnpj, CNPJ_MOCK_OK)

  const base = `${CNPJ_MOCK_OK}_Cliente_1/2026/10/NFS-e`
  assert.deepEqual(arquivos(pastaXmls), [
    `${base}/Entradas/${n1.chave}-nfse.xml`,
    `${base}/Entradas/${n2.chave}-nfse.xml`,
    `${base}/Entradas/Eventos/${n1.chave}-evento-101101-001.xml`,
    `${base}/Saidas/${n3.chave}-nfse.xml`,
  ].sort())

  const c = cliente(db, id)
  assert.deepEqual([c.nfse_ult_nsu, c.nfse_proxima_consulta, c.nfse_ultima_consulta, c.nfse_ultimo_erro], ['4', UMA_HORA, AGORA.toISOString(), null])
  assert.equal(c.ult_nsu, '000000000000000', 'NSU da NF-e intocado')
  const e = db.prepare("SELECT * FROM execucoes WHERE tipo = 'captura_nfse'").get()
  assert.deepEqual([e.docs_recebidos, e.notas_recebidas, e.eventos_recebidos, e.c_stat, e.erro], [4, 3, 1, 'DOCUMENTOS_LOCALIZADOS', null])
})

test('vários lotes: segue enquanto o lote vem cheio', async (t) => {
  const mock = criarAdnMock({ tamanhoLote: 2 })
  mock.adicionar(CNPJ_MOCK_OK, [nfse({ chave: chaveNfse(PRESTADOR_MOCK, 5), prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK, numero: '5' })])
  const { db, servico, id, pausas, limpar } = montar({ mock, config: { adnTamanhoLote: 2 } })
  t.after(limpar)
  const r = await servico.capturarCliente(id)
  assert.equal(r.lotes, 3)
  assert.deepEqual(pausas, [2000, 2000])
  assert.equal(cliente(db, id).nfse_ult_nsu, '5')
  assert.deepEqual(mock.chamadas.map((c) => c.nsu), ['0', '2', '4'])
})

test('espera de 1 h: pula; com forcar, roda', async (t) => {
  const { servico, id, mock, limpar } = montar()
  t.after(limpar)
  await servico.capturarCliente(id)
  const pulado = await servico.capturarCliente(id)
  assert.ok(pulado.pulado)
  assert.equal(mock.chamadas.length, 1)
  await servico.capturarCliente(id, { forcar: true })
  assert.equal(mock.chamadas.length, 2)
})

test('erro não avança o NSU e não mexe na NF-e', async (t) => {
  const { db, servico, id, mock, limpar } = montar()
  t.after(limpar)
  mock.falhar(CNPJ_MOCK_OK, 'HTTP 403')
  const r = await servico.capturarCliente(id)
  assert.equal(r.ok, false)
  const c = cliente(db, id)
  assert.deepEqual([c.nfse_ult_nsu, c.nfse_ultimo_erro, c.nfse_proxima_consulta], ['0', 'HTTP 403', null])
  assert.deepEqual([c.ult_nsu, c.ultimo_erro, c.ultima_consulta], ['000000000000000', null, null])
  assert.equal(db.prepare("SELECT erro FROM execucoes WHERE tipo = 'captura_nfse'").get().erro, 'HTTP 403')
  assert.equal(notas(db).length, 0)
})

test('cancelamento chegando antes da nota: a nota já nasce cancelada', async (t) => {
  const chave = chaveNfse(PRESTADOR_MOCK, 9)
  const mock = criarAdnMock({ documentos: { [CNPJ_MOCK_OK]: [eventoNfse({ chave }), nfse({ chave, prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK })] } })
  const { db, servico, id, limpar } = montar({ mock })
  t.after(limpar)
  await servico.capturarCliente(id)
  assert.equal(notas(db)[0].cancelada, 1)
})

test('o mesmo documento duas vezes não duplica nada', async (t) => {
  const { db, servico, id, pastaXmls, limpar } = montar()
  t.after(limpar)
  await servico.capturarCliente(id)
  const antes = { notas: notas(db).length, eventos: db.prepare('SELECT COUNT(*) n FROM eventos').get().n, arquivos: arquivos(pastaXmls) }
  db.prepare("UPDATE clientes SET nfse_ult_nsu = '0'").run()
  await servico.capturarCliente(id, { forcar: true })
  assert.deepEqual({ notas: notas(db).length, eventos: db.prepare('SELECT COUNT(*) n FROM eventos').get().n, arquivos: arquivos(pastaXmls) }, antes)
  assert.equal(notas(db)[0].cancelada, 1, 'continua cancelada')
})

test('cliente só como intermediário: entra como entrada e avisa no log', async (t) => {
  const chave = chaveNfse(PRESTADOR_MOCK, 7)
  const doc = nfse({ chave, prestador: PRESTADOR_MOCK, tomador: '77666555000144' })
  doc.xml = doc.xml.replace('</toma>', `</toma><interm><CNPJ>${CNPJ_MOCK_OK}</CNPJ></interm>`)
  const { db, servico, id, avisos, limpar } = montar({ mock: criarAdnMock({ documentos: { [CNPJ_MOCK_OK]: [doc] } }) })
  t.after(limpar)
  await servico.capturarCliente(id)
  assert.equal(notas(db)[0].tipo, 'entrada')
  assert.ok(avisos.some(([m]) => /intermediário/i.test(m)))
})

test('padrão do simulador continua com 4 documentos', () => {
  assert.equal(documentosPadrao(CNPJ_MOCK_OK).length, 4)
})

test('documento ilegível vai para o log e não trava a fila', async (t) => {
  const ok1 = nfse({ chave: chaveNfse(PRESTADOR_MOCK, 1), prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK, numero: '1' })
  const ok2 = nfse({ chave: chaveNfse(PRESTADOR_MOCK, 3), prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK, numero: '3' })
  const quebrado = { tipo: 'NFSE', chave: chaveNfse(PRESTADOR_MOCK, 2), xml: null }
  const { db, servico, id, limpar } = montar({ mock: criarAdnMock({ documentos: { [CNPJ_MOCK_OK]: [ok1, quebrado, ok2] } }) })
  t.after(limpar)
  const r = await servico.capturarCliente(id)
  assert.equal(r.ok, true)
  assert.equal(r.notas, 2)
  assert.equal(r.ignorados, 1)
  assert.equal(cliente(db, id).nfse_ult_nsu, '3', 'a fila anda')
})
