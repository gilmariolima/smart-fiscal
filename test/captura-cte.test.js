'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { criarServicoCapturaCte } = require('../src/services/capturaCte')
const { criarCteMock } = require('../src/sefaz/cte-mock')
const { montarAmbiente, AGORA } = require('./apoio/ambiente')
const { TRANSP, REM, DEST, EXPED, cteProc, procEventoCte, chaveCte } = require('./apoio/cte')

const UMA_HORA = new Date(AGORA.getTime() + 3600e3).toISOString()

function montar({ clientes = [REM], documentos = {}, tamanhoLote, fabricaCte } = {}) {
  const cte = criarCteMock({ documentos, tamanhoLote })
  const amb = montarAmbiente({ clientes, cte, fabricaCte })
  const avisos = []
  const servico = criarServicoCapturaCte({ ...amb.deps, logger: { info() {}, warn: (m, d) => avisos.push([m, d]), error() {} } })
  return { ...amb, servico, avisos }
}

const cliente = (db, id) => db.prepare('SELECT * FROM clientes WHERE id = ?').get(id)
const notas = (db) => db.prepare('SELECT * FROM notas ORDER BY cliente_id, numero').all()
const arquivos = (pasta) => fs.readdirSync(pasta, { recursive: true }).filter((f) => f.endsWith('.xml')).map((f) => f.replace(/\\/g, '/')).sort()

test('CT-e de saída, entrada e outro: notas, pastas, NSU e execução', async (t) => {
  const saida = cteProc({ emit: REM, rem: DEST, toma3: 0, nCT: '1', vTPrest: '100.00' })
  const entrada = cteProc({ toma3: 0, nCT: '2', vTPrest: '200.00' })
  const outro = cteProc({ toma3: 3, nCT: '3', vTPrest: '300.00' })
  const { db, servico, ids, pastaXmls, limpar } = montar({ documentos: { [REM]: [{ xml: saida }, { xml: entrada }, { xml: outro }] } })
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.deepEqual(
    { ok: r.ok, cnpj: r.cnpj, docs: r.docs, notas: r.notas, eventos: r.eventos, entradas: r.entradas, saidas: r.saidas, outros: r.outros, ignorados: r.ignorados, lotes: r.lotes, cStat: r.cStat, erro: r.erro },
    { ok: true, cnpj: REM, docs: 3, notas: 3, eventos: 0, entradas: 1, saidas: 1, outros: 1, ignorados: 0, lotes: 1, cStat: '138', erro: null },
  )

  const [n1, n2, n3] = notas(db)
  assert.deepEqual([n1.tipo, n2.tipo, n3.tipo], ['saida', 'entrada', 'outro'])
  assert.ok([n1, n2, n3].every((n) => n.modelo === 'cte' && n.status === 'completa' && n.competencia === '2026-10' && n.cancelada === 0))
  assert.deepEqual(
    { chave: n2.chave, emit: n2.emitente_cnpj, emitNome: n2.emitente_nome, ie: n2.emitente_ie, dest: n2.destinatario_cnpj, numero: n2.numero, serie: n2.serie, valor: n2.valor_total, emissao: n2.data_emissao, nsu: n2.nsu },
    { chave: chaveCte(TRANSP, '2'), emit: TRANSP, emitNome: 'TRANSPORTADORA EXEMPLO LTDA', ie: '250000001', dest: REM, numero: '2', serie: '1', valor: 200, emissao: '2026-10-08T10:00:00-03:00', nsu: '000000000000002' },
  )
  assert.equal(n3.destinatario_cnpj, DEST, 'destinatário da nota é o tomador')

  const base = 'Cliente 1/2026/Outubro/CT-e'
  assert.deepEqual(arquivos(pastaXmls), [`${base}/Saidas/${n1.chave}-cte.xml`, `${base}/Entradas/${n2.chave}-cte.xml`, `${base}/Outros/${n3.chave}-cte.xml`].sort())

  const c = cliente(db, ids[0])
  assert.deepEqual([c.cte_ult_nsu, c.cte_proxima_consulta, c.cte_ultima_consulta, c.cte_ultimo_erro], ['3', UMA_HORA, AGORA.toISOString(), null])

  const exec = db.prepare("SELECT * FROM execucoes WHERE tipo = 'captura_cte'").get()
  assert.deepEqual([exec.cliente_id, exec.c_stat, exec.docs_recebidos, exec.notas_recebidas, exec.eventos_recebidos, exec.erro], [ids[0], '138', 3, 3, 0, null])
  assert.ok([n1, n2, n3].every((n) => n.captura_id === exec.id))
})

test('fila vazia: 137, espera de 1 h; sem forcar pula, com forcar consulta', async (t) => {
  const { db, servico, ids, cte, limpar } = montar()
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, true)
  assert.equal(r.cStat, '137')
  assert.equal(r.docs, 0)
  assert.equal(cliente(db, ids[0]).cte_proxima_consulta, UMA_HORA)
  assert.equal(cte.chamadas.length, 1)

  const pulado = await servico.capturarCliente(ids[0])
  assert.match(pulado.pulado, /próxima consulta/)
  assert.equal(cte.chamadas.length, 1)

  const forcado = await servico.capturarCliente(ids[0], { forcar: true })
  assert.equal(forcado.pulado, undefined)
  assert.equal(forcado.cStat, '137')
  assert.equal(cte.chamadas.length, 2)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM execucoes WHERE tipo = 'captura_cte'").get().n, 2)
})

test('656: bloqueio de 1 h que nem o forcar fura', async (t) => {
  const { db, servico, ids, cte, limpar } = montar()
  t.after(limpar)
  cte.responder(REM, { cStat: '656', xMotivo: 'Consumo Indevido' })

  const r = await servico.capturarCliente(ids[0])
  const p = (n) => String(n).padStart(2, '0')
  const fim = new Date(UMA_HORA)
  assert.equal(r.ok, false)
  assert.equal(r.cStat, '656')
  assert.equal(r.erro, `Bloqueado até ${p(fim.getHours())}:${p(fim.getMinutes())} (656 Consumo Indevido)`)
  const c = cliente(db, ids[0])
  assert.equal(c.cte_bloqueado_ate, UMA_HORA)
  assert.equal(c.cte_ultimo_erro, r.erro)

  const forcado = await servico.capturarCliente(ids[0], { forcar: true })
  assert.match(forcado.pulado, /bloqueado/)
  assert.equal(cte.chamadas.length, 1)
})

test('procCTeOS e documento ilegível são ignorados sem travar a fila', async (t) => {
  const bom = cteProc({ toma3: 0, nCT: '5' })
  const { db, servico, ids, avisos, limpar } = montar({
    documentos: { [REM]: [{ xml: '<procCTeOS/>', schema: 'procCTeOS_v4.00.xsd' }, { xml: null }, { xml: bom }] },
  })
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, true)
  assert.equal(r.ignorados, 2)
  assert.equal(r.notas, 1)
  assert.equal(r.docs, 3)
  assert.equal(notas(db).length, 1)
  assert.equal(cliente(db, ids[0]).cte_ult_nsu, '3')
  assert.equal(avisos.length, 2)
})

test('CT-e em que o cliente não aparece é ignorado com aviso', async (t) => {
  const alheio = cteProc({ rem: DEST, dest: EXPED, toma3: 3, nCT: '6' })
  const { db, servico, ids, avisos, limpar } = montar({ documentos: { [REM]: [{ xml: alheio }] } })
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ignorados, 1)
  assert.equal(notas(db).length, 0)
  assert.equal(cliente(db, ids[0]).cte_ult_nsu, '1')
  assert.equal(avisos.length, 1)
})

test('cancelamento antes do CT-e e CT-e em dois clientes: as duas linhas canceladas', async (t) => {
  const chave = chaveCte(TRANSP, '9')
  const xml = cteProc({ chave, nCT: '9', toma3: 3 })
  const evento = procEventoCte({ chave, tpEvento: '110111' })
  const { db, servico, ids, pastaXmls, limpar } = montar({
    clientes: [TRANSP, DEST],
    documentos: { [TRANSP]: [{ xml: evento, schema: 'procEventoCTe_v4.00.xsd' }, { xml }], [DEST]: [{ xml }] },
  })
  t.after(limpar)

  const r1 = await servico.capturarCliente(ids[0])
  assert.deepEqual([r1.eventos, r1.saidas], [1, 1])
  const r2 = await servico.capturarCliente(ids[1])
  assert.equal(r2.entradas, 1)

  const linhas = notas(db)
  assert.deepEqual(linhas.map((n) => [n.cliente_id, n.tipo, n.cancelada]), [[ids[0], 'saida', 1], [ids[1], 'entrada', 1]])
  const ev = db.prepare('SELECT * FROM eventos').all()
  assert.equal(ev.length, 1)
  assert.deepEqual([ev[0].chave, ev[0].tp_evento, ev[0].n_seq], [chave, '110111', '1'])
  assert.ok(arquivos(pastaXmls).includes(`Cliente 1/2026/Outubro/CT-e/Saidas/Eventos/${chave}-evento-110111-1.xml`))
})

test('cancelamento depois do CT-e marca a nota já gravada', async (t) => {
  const chave = chaveCte(TRANSP, '10')
  const { db, servico, ids, cte, limpar } = montar({ documentos: { [REM]: [{ xml: cteProc({ chave, nCT: '10', toma3: 0 }) }] } })
  t.after(limpar)
  await servico.capturarCliente(ids[0])
  assert.equal(notas(db)[0].cancelada, 0)

  cte.adicionar(REM, [{ xml: procEventoCte({ chave, tpEvento: '110111' }), schema: 'procEventoCTe_v4.00.xsd' }])
  const r = await servico.capturarCliente(ids[0], { forcar: true })
  assert.equal(r.eventos, 1)
  assert.equal(notas(db)[0].cancelada, 1)
})

test('CT-e de homologação (tpAmb 2) é gravado normalmente', async (t) => {
  const { db, servico, ids, limpar } = montar({ documentos: { [REM]: [{ xml: cteProc({ toma3: 0, nCT: '11', tpAmb: '2' }) }] } })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.entradas, 1)
  assert.equal(notas(db).length, 1)
})

test('erro de rede: registra o erro sem mexer no NSU', async (t) => {
  const { db, servico, ids, cte, limpar } = montar()
  t.after(limpar)
  cte.falhar(REM, 'ECONNRESET')
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  assert.equal(r.erro, 'ECONNRESET')
  const c = cliente(db, ids[0])
  assert.deepEqual([c.cte_ult_nsu, c.cte_ultimo_erro, c.cte_proxima_consulta, c.cte_bloqueado_ate], ['0', 'ECONNRESET', null, null])
})

test('fila em vários lotes: consulta até ultNSU = maxNSU, com pausa entre as chamadas', async (t) => {
  const docs = ['21', '22', '23'].map((nCT) => ({ xml: cteProc({ toma3: 0, nCT }) }))
  const { db, servico, ids, cte, pausas, limpar } = montar({ documentos: { [REM]: docs }, tamanhoLote: 2 })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.deepEqual([r.lotes, r.docs, r.entradas], [2, 3, 3])
  assert.deepEqual(cte.chamadas.map((c) => c.nsu), ['0', '2'])
  assert.deepEqual(pausas, [2000])
  const c = cliente(db, ids[0])
  assert.deepEqual([c.cte_ult_nsu, c.cte_proxima_consulta], ['3', UMA_HORA])
})

// Cliente do CT-e que sempre devolve a mesma resposta (138 fora do padrão).
const respondeSempre = (resposta) => () => ({ consultarLote: async () => ({ ok: true, cStat: '138', xMotivo: 'Documento localizado', erro: null, ...resposta }) })

test('138 sem documentos legíveis: falha sem mexer no NSU', async (t) => {
  const { db, servico, ids, limpar } = montar({ fabricaCte: respondeSempre({ documentos: [], ultNSU: '000000000000009', maxNSU: '000000000000009' }) })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  const c = cliente(db, ids[0])
  assert.equal(c.cte_ult_nsu, '0')
  assert.equal(c.cte_proxima_consulta, null)
  assert.match(c.cte_ultimo_erro, /138 sem documentos legíveis/)
})

test('CT-e reconhecido pela raiz cteProc mesmo com schema ausente ou diferente', async (t) => {
  const a = cteProc({ toma3: 0, nCT: '31' })
  const b = cteProc({ toma3: 0, nCT: '32' })
  const { db, servico, ids, limpar } = montar({ fabricaCte: respondeSempre({
    documentos: [{ nsu: '000000000000001', schema: null, xml: a }, { nsu: '000000000000002', schema: 'resCTe_v1.00.xsd', xml: b }],
    ultNSU: '000000000000002', maxNSU: '000000000000002',
  }) })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, true)
  assert.equal(r.entradas, 2)
  assert.deepEqual(notas(db).map((n) => n.numero), ['31', '32'])
  assert.equal(cliente(db, ids[0]).cte_ult_nsu, '2')
})

test('lote só com documentos não suportados: NSU avança com aviso visível', async (t) => {
  const { db, servico, ids, limpar } = montar({
    documentos: { [REM]: [{ xml: '<cteOSProc versao="4.00"/>', schema: 'procCTeOS_v4.00.xsd' }, { xml: '<GTVeProc/>', schema: 'procGTVe_v4.00.xsd' }] },
  })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, true)
  assert.equal(r.ignorados, 2)
  const c = cliente(db, ids[0])
  assert.equal(c.cte_ult_nsu, '2')
  assert.equal(c.cte_ultimo_erro, 'Lote sem CT-e reconhecido (2 documentos ignorados)')
})

test('falha ao gravar o XML (EACCES): lote inteiro desfeito e NSU parado', async (t) => {
  const docs = ['41', '42'].map((nCT) => ({ xml: cteProc({ toma3: 0, nCT }) }))
  const { db, servico, ids, limpar } = montar({ documentos: { [REM]: docs } })
  t.after(limpar)
  const original = fs.writeFileSync
  let escritas = 0
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (++escritas === 2) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
    return original(...args)
  })
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  assert.match(r.erro, /EACCES/)
  assert.equal(notas(db).length, 0)
  const c = cliente(db, ids[0])
  assert.equal(c.cte_ult_nsu, '0')
  assert.match(c.cte_ultimo_erro, /EACCES/)
})
