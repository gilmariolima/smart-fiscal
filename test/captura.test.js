'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { criarServicoCaptura } = require('../src/services/captura')
const { criarSefazMock, CNPJ_MOCK_OK, CNPJ_MOCK_656, CNPJ_MOCK_ESCRITORIO, CNPJ_FORA_CARTEIRA } = require('../src/sefaz/mock-client')
const { xmlParaJson } = require('../src/sefaz/xml')

const silencioso = { info() {}, warn() {}, error() {} }
const AGORA = new Date('2026-10-09T12:00:00Z')

function montar({ mock = criarSefazMock(), clientes = [CNPJ_MOCK_OK], agora = () => AGORA, fabrica } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-xmls-'))
  const db = abrirBanco(':memory:')
  const ins = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, ?, ?, 'CE', 'x.pfx', 'a:b:c')`)
  const ids = clientes.map((cnpj, i) => ins.run(cnpj, `Cliente ${i + 1} Ltda`, `Cliente ${i + 1}`).lastInsertRowid)
  const pausas = []
  const servico = criarServicoCaptura({
    db,
    config: { pastaXmls, intervaloEntreChamadasMs: 2000 },
    logger: silencioso,
    fabricaSefaz: fabrica || ((c) => mock.cliente(c.cnpj)),
    dormir: async (ms) => pausas.push(ms),
    agora,
  })
  const limpar = () => fs.rmSync(pastaXmls, { recursive: true, force: true })
  return { db, servico, mock, ids, pausas, pastaXmls, limpar }
}

function arquivos(pasta) {
  return fs.readdirSync(pasta, { recursive: true }).filter((f) => f.endsWith('.xml')).map((f) => f.replace(/\\/g, '/')).sort()
}

const cliente = (db, id) => db.prepare('SELECT * FROM clientes WHERE id = ?').get(id)
const notas = (db) => db.prepare('SELECT * FROM notas ORDER BY emitente_nome').all()

test('laço de NSU: processa os lotes, grava ultNSU e espera 1 h com a fila zerada', async (t) => {
  const { db, servico, mock, ids, pausas, pastaXmls, limpar } = montar()
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, true)
  assert.equal(r.lotes, 2)
  assert.deepEqual({ resumo: r.resumo, completa: r.completa, evento: r.evento }, { resumo: 2, completa: 1, evento: 1 })
  assert.deepEqual(pausas, [2000]) // pausa só entre chamadas

  const c = cliente(db, ids[0])
  assert.equal(c.ult_nsu, '000000000000004')
  assert.equal(c.max_nsu, '000000000000004')
  assert.equal(c.proxima_consulta, new Date(AGORA.getTime() + 3600e3).toISOString())
  assert.equal(c.ultimo_erro, null)

  const [alfa, beta, gama] = notas(db).sort((a, b) => Number(a.numero) - Number(b.numero))
  assert.equal(alfa.status, 'resumo')
  assert.equal(alfa.cancelada, 0)
  assert.equal(beta.status, 'resumo')
  assert.equal(beta.cancelada, 1, 'cancelamento 110111 marca a nota')
  assert.equal(gama.status, 'completa', 'procNFe sem resumo entra como completa')
  assert.equal(gama.valor_total, 99.9)
  assert.match(gama.caminho_xml, /-nfe\.xml$/)
  assert.equal(alfa.competencia, '2026-10')
  assert.equal(alfa.emitente_nome, 'Fornecedor Alfa Ltda')
  assert.equal(alfa.valor_total, 1500)
  assert.equal(alfa.numero, String(1000 + (1122 % 900)))
  assert.equal(alfa.serie, '1')

  const ev = db.prepare('SELECT * FROM eventos').all()
  assert.equal(ev.length, 1)
  assert.equal(ev[0].tp_evento, '110111')
  assert.equal(ev[0].chave, beta.chave)

  const pasta = `${CNPJ_MOCK_OK}_Cliente_1/2026/10/NF-e/Entradas`
  assert.deepEqual(arquivos(pastaXmls), [
    `${pasta}/Resumos/${alfa.chave}-resumo.xml`,
    `${pasta}/Eventos/${beta.chave}-evento-110111-1.xml`,
    `${pasta}/Resumos/${beta.chave}-resumo.xml`,
    `${pasta}/${gama.chave}-nfe.xml`,
  ].sort())
  const xml = fs.readFileSync(path.join(pastaXmls, gama.caminho_xml), 'utf8')
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><nfeProc'))

  const exec = db.prepare('SELECT * FROM execucoes').all()
  assert.equal(exec.length, 1)
  assert.equal(exec[0].tipo, 'captura')
  assert.equal(exec[0].docs_recebidos, 4)
  assert.equal(exec[0].notas_recebidas, 3, 'resumos A e B + procNFe C')
  assert.equal(exec[0].eventos_recebidos, 1, 'cancelamento de B')
  assert.ok(exec[0].fim)
  assert.equal(mock.chamadas.length, 2)
})

test('rodar de novo: respeita a espera de 1 h e, forçado, não duplica nada', async (t) => {
  const { db, servico, mock, ids, pastaXmls, limpar } = montar()
  t.after(limpar)
  await servico.capturarCliente(ids[0])
  const antesArquivos = arquivos(pastaXmls)

  const pulado = await servico.capturarCliente(ids[0])
  assert.match(pulado.pulado, /próxima consulta/)
  assert.equal(mock.chamadas.length, 2, 'não chamou a SEFAZ')

  const forcado = await servico.capturarCliente(ids[0], { forcar: true })
  assert.equal(forcado.cStat, '137')
  assert.equal(notas(db).length, 3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1)
  assert.deepEqual(arquivos(pastaXmls), antesArquivos)
})

test('reprocessar os mesmos NSUs (ultNSU zerado) é idempotente', async (t) => {
  const { db, servico, ids, pastaXmls, limpar } = montar()
  t.after(limpar)
  await servico.capturarCliente(ids[0])
  // atualizado_em e captura_id mudam a cada captura; o resto fica igual.
  const antes = notas(db).map(({ atualizado_em, captura_id, ...n }) => n)
  const antesArquivos = arquivos(pastaXmls)

  db.prepare("UPDATE clientes SET ult_nsu = '000000000000000', proxima_consulta = NULL").run()
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.docs, 4)
  assert.deepEqual(notas(db).map(({ atualizado_em, captura_id, ...n }) => n), antes)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1)
  assert.deepEqual(arquivos(pastaXmls), antesArquivos)
})

test('ultNSU é salvo a cada lote: falha no 2º lote mantém o 1º', async (t) => {
  const mock = criarSefazMock()
  let chamadas = 0
  const fabrica = (c) => {
    const real = mock.cliente(c.cnpj)
    return { ...real, consultaUltNSU: async (n) => (++chamadas === 2 ? { error: 'timeout simulado', data: {} } : real.consultaUltNSU(n)) }
  }
  const { db, servico, ids, limpar } = montar({ mock, fabrica })
  t.after(limpar)

  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  const c = cliente(db, ids[0])
  assert.equal(c.ult_nsu, '000000000000002')
  assert.match(c.ultimo_erro, /timeout simulado/)
  assert.equal(c.proxima_consulta, null)
  assert.equal(notas(db).length, 2)
  assert.match(db.prepare('SELECT erro FROM execucoes').get().erro, /timeout simulado/)

  // Na próxima rodada continua do NSU 2.
  const r2 = await servico.capturarCliente(ids[0])
  assert.equal(r2.ok, true)
  assert.equal(cliente(db, ids[0]).ult_nsu, '000000000000004')
  assert.equal(cliente(db, ids[0]).ultimo_erro, null)
})

test('erro ao gravar o lote desfaz o lote inteiro e não avança o NSU', async (t) => {
  const { db, servico, ids, pastaXmls, limpar } = montar()
  t.after(limpar)
  // Um arquivo no lugar da pasta do cliente faz o mkdir falhar.
  fs.writeFileSync(path.join(pastaXmls, `${CNPJ_MOCK_OK}_Cliente_1`), 'bloqueio')
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  assert.equal(cliente(db, ids[0]).ult_nsu, '000000000000000')
  assert.equal(notas(db).length, 0)
})

test('656 bloqueia o CNPJ por 1 h e não impede os outros', async (t) => {
  const { db, servico, ids, limpar } = montar({ clientes: [CNPJ_MOCK_656, CNPJ_MOCK_OK] })
  t.after(limpar)
  const res = await servico.capturarTodos()
  assert.equal(res.length, 2)
  assert.equal(res[0].ok, false)
  assert.equal(res[0].cStat, '656')
  assert.equal(res[1].ok, true)

  const bloqueado = cliente(db, ids[0])
  assert.equal(bloqueado.bloqueado_ate, new Date(AGORA.getTime() + 3600e3).toISOString())
  assert.equal(bloqueado.ult_nsu, '000000000000000')
  assert.match(bloqueado.ultimo_erro, /656/)
  assert.equal(notas(db).length, 3)

  const depois = await servico.capturarCliente(ids[0])
  assert.match(depois.pulado, /bloqueado/)
  const forcado = await servico.capturarCliente(ids[0], { forcar: true })
  assert.match(forcado.pulado, /bloqueado/, 'forçar não fura o bloqueio do 656')
})

test('bloqueio vence depois de 1 h', async (t) => {
  let agora = AGORA
  const { servico, ids, mock, limpar } = montar({ clientes: [CNPJ_MOCK_656], agora: () => agora })
  t.after(limpar)
  await servico.capturarCliente(ids[0])
  agora = new Date(AGORA.getTime() + 3600e3 + 1000)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.pulado, undefined)
  assert.equal(mock.chamadas.length, 2)
})

test('erro de rede e cStat desconhecido registram ultimo_erro e seguem para o próximo', async (t) => {
  const mock = criarSefazMock({ cenarios: { '12345678000195': { modo: 'erro' } } })
  const estranho = { consultaUltNSU: async () => ({ status: 200, data: { cStat: '593', xMotivo: 'Rejeicao: CNPJ do certificado difere' } }) }
  const fabrica = (c) => (c.cnpj === '23456789000195' ? estranho : mock.cliente(c.cnpj))
  const { db, servico, ids, limpar } = montar({ mock, fabrica, clientes: ['12345678000195', '23456789000195', CNPJ_MOCK_OK] })
  t.after(limpar)

  const res = await servico.capturarTodos()
  assert.deepEqual(res.map((r) => r.ok), [false, false, true])
  assert.match(cliente(db, ids[0]).ultimo_erro, /ECONNREFUSED/)
  assert.equal(cliente(db, ids[1]).ultimo_erro, 'cStat 593 Rejeicao: CNPJ do certificado difere')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM execucoes WHERE erro IS NOT NULL').get().n, 2)
})

test('exceção dentro do cliente SEFAZ não derruba o ciclo', async (t) => {
  const fabrica = () => { throw new Error('pfx corrompido') }
  const { db, servico, ids, limpar } = montar({ fabrica, clientes: [CNPJ_MOCK_OK] })
  t.after(limpar)
  const [r] = await servico.capturarTodos()
  assert.equal(r.ok, false)
  assert.match(cliente(db, ids[0]).ultimo_erro, /pfx corrompido/)
})

test('SEFAZ que não avança o NSU interrompe o laço', async (t) => {
  const preso = { consultaUltNSU: async () => ({ status: 200, data: { cStat: '138', ultNSU: '000000000000000', maxNSU: '000000000000009', docZip: [] } }) }
  const { servico, ids, limpar } = montar({ fabrica: () => preso })
  t.after(limpar)
  const r = await servico.capturarCliente(ids[0])
  assert.equal(r.ok, false)
  assert.match(r.erro, /sem avançar/)
})

test('capturarTodos ignora inativos e aceita filtro por CNPJ', async (t) => {
  const { db, servico, mock, ids, limpar } = montar({ clientes: [CNPJ_MOCK_OK, '34567890000130'] })
  t.after(limpar)
  db.prepare('UPDATE clientes SET ativo = 0 WHERE id = ?').run(ids[1])
  assert.equal((await servico.capturarTodos()).length, 1)
  const [r] = await servico.capturarTodos({ cnpj: '34567890000130' })
  assert.equal(r.cnpj, '34567890000130')
  assert.ok(mock.chamadas.some((c) => c.cnpj === '34567890000130'))
})

test('cancelamento que chega antes da nota é aplicado quando a nota chega', async (t) => {
  const { db, servico, ids, limpar } = montar()
  t.after(limpar)
  const mock = criarSefazMock()
  const docs = [...(await mock.cliente(CNPJ_MOCK_OK).consultaUltNSU('0')).data.docZip, ...(await mock.cliente(CNPJ_MOCK_OK).consultaUltNSU('2')).data.docZip]
  const [, resumoB, , cancelB] = docs
  const c = cliente(db, ids[0])
  assert.equal(servico.processarDocumento(c, cancelB), 'evento')
  assert.equal(servico.processarDocumento(c, resumoB), 'resumo')
  assert.equal(notas(db)[0].cancelada, 1)
})

test('procNFe depois do resumo completa a nota sem perder dados', async (t) => {
  const { db, servico, ids, limpar } = montar()
  t.after(limpar)
  const mock = criarSefazMock()
  const sefaz = mock.cliente(CNPJ_MOCK_OK)
  const [resumoA] = (await sefaz.consultaUltNSU('0')).data.docZip
  const c = cliente(db, ids[0])
  servico.processarDocumento(c, resumoA)
  const chave = resumoA.json.resNFe.chNFe
  await sefaz.enviarEvento({ idLote: '1', lote: [{ chNFe: chave, tipoEvento: 210210 }] })
  const [proc] = (await sefaz.consultaChNFe(chave)).data.docZip
  assert.equal(servico.processarDocumento(c, proc), 'completa')
  const n = notas(db)[0]
  assert.equal(n.status, 'completa')
  assert.equal(n.situacao_sefaz, '1', 'situação do resumo é mantida')
  assert.equal(n.nsu, '000000000000001', 'NSU original é mantido')
  assert.match(n.caminho_xml, new RegExp(`${chave}-nfe\\.xml$`))

  // Um resumo repetido depois não rebaixa o status.
  servico.processarDocumento(c, resumoA)
  assert.equal(notas(db)[0].status, 'completa')
})

test('mesma chave em dois clientes: cada um com a sua cópia', async (t) => {
  const { db, servico, ids, pastaXmls, limpar } = montar({ clientes: [CNPJ_MOCK_OK, '34567890000130'] })
  t.after(limpar)
  const [procC] = (await criarSefazMock().cliente(CNPJ_MOCK_OK).consultaUltNSU('2')).data.docZip
  assert.equal(servico.processarDocumento(cliente(db, ids[0]), procC), 'completa')
  assert.equal(servico.processarDocumento(cliente(db, ids[1]), procC), 'completa')
  const linhas = db.prepare('SELECT * FROM notas ORDER BY cliente_id').all()
  assert.deepEqual(linhas.map((n) => n.cliente_id), [ids[0], ids[1]])
  assert.equal(linhas[0].chave, linhas[1].chave)
  const chave = linhas[0].chave
  const xmls = arquivos(pastaXmls)
  assert.equal(xmls.length, 2)
  assert.ok(xmls.some((f) => f.startsWith(`${CNPJ_MOCK_OK}_Cliente_1/`) && f.endsWith(`${chave}-nfe.xml`)))
  assert.ok(xmls.some((f) => f.startsWith('34567890000130_Cliente_2/') && f.endsWith(`${chave}-nfe.xml`)))
})

/** Clientes CNPJ_MOCK_OK (cliente) e o escritório, com a mesma SEFAZ simulada. */
function montarComEscritorio(extras = []) {
  const m = montar({ clientes: [CNPJ_MOCK_OK, CNPJ_MOCK_ESCRITORIO, ...extras] })
  m.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(m.ids[1])
  return m
}

test('escritório: saída, entrada que completa resumo, fora da carteira e resNFe ignorado', async (t) => {
  const { db, servico, mock, ids, pastaXmls, limpar } = montarComEscritorio()
  t.after(limpar)
  await servico.capturarCliente(ids[0])
  const [resumoA] = (await mock.cliente(CNPJ_MOCK_OK).consultaUltNSU('0')).data.docZip
  const chaveA = resumoA.json.resNFe.chNFe
  assert.equal(db.prepare('SELECT status FROM notas WHERE chave = ?').get(chaveA).status, 'resumo')
  const antes = db.prepare('SELECT COUNT(*) n FROM notas').get().n

  const r = await servico.capturarCliente(ids[1])
  assert.equal(r.ok, true)
  assert.equal(r.fora, 1)
  assert.equal(r.saida, 2)
  assert.equal(r.ignorado, 1, 'resNFe destinado ao escritório')

  const docs = mock.estado(CNPJ_MOCK_ESCRITORIO).docs
  const chaveDe = (d) => d.json.nfeProc.protNFe.infProt.chNFe
  const [s1, s2, , f1] = docs.map((d) => (d.json.nfeProc ? chaveDe(d) : null))
  const nota = (chave) => db.prepare('SELECT * FROM notas WHERE chave = ?').all(chave)

  for (const chave of [s1, s2]) {
    const [n] = nota(chave)
    assert.equal(nota(chave).length, 1)
    assert.equal(n.cliente_id, ids[0])
    assert.equal(n.tipo, 'saida')
    assert.equal(n.status, 'completa')
    assert.equal(n.destinatario_cnpj, CNPJ_FORA_CARTEIRA)
  }
  assert.equal(nota(s1)[0].cancelada, 0)
  assert.equal(nota(s2)[0].cancelada, 1)

  const [a] = nota(chaveA)
  assert.equal(nota(chaveA).length, 1)
  assert.equal(a.status, 'completa')
  assert.equal(a.tipo, 'entrada')
  assert.equal(a.cliente_id, ids[0])
  assert.equal(a.destinatario_cnpj, CNPJ_MOCK_OK)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas').get().n, antes + 2)

  assert.equal(nota(f1).length, 0)
  const pastaFora = new RegExp(`^${CNPJ_MOCK_ESCRITORIO}_Cliente_2/fora-da-carteira/\\d{4}/\\d{2}/NF-e/Entradas/${f1}-nfe\\.xml$`)
  assert.ok(arquivos(pastaXmls).some((f) => pastaFora.test(f)), 'XML fora da carteira na pasta do escritório')

  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas WHERE cliente_id = ?').get(ids[1]).n, 0)
  const evento = db.prepare('SELECT * FROM eventos WHERE chave = ?').get(s2)
  assert.ok(evento.caminho_xml.startsWith(`${CNPJ_MOCK_OK}_Cliente_1`), 'evento na pasta do dono da nota')
  assert.match(evento.caminho_xml.replace(/\\/g, '/'), /\/NF-e\/Saidas\/Eventos\//, 'evento da saída em Saidas/Eventos')
})

test('nota de A para B pelo escritório vira saída em A e entrada em B', async (t) => {
  const B = '66777888000191'
  const { db, servico, mock, ids, limpar } = montarComEscritorio([B])
  t.after(limpar)
  const [s1] = mock.estado(CNPJ_MOCK_ESCRITORIO).docs
  const xml = s1.xml.replace(CNPJ_FORA_CARTEIRA, B)
  const doc = { nsu: '000000000000001', schema: s1.schema, xml, json: xmlParaJson(xml) }
  assert.equal(servico.processarDocumento(cliente(db, ids[1]), doc), 'completa')
  const linhas = db.prepare('SELECT cliente_id, tipo FROM notas ORDER BY cliente_id').all()
  assert.deepEqual(linhas, [{ cliente_id: ids[0], tipo: 'saida' }, { cliente_id: ids[2], tipo: 'entrada' }])
})

test('cancelamento pelo certificado de um cliente cancela a saída guardada em outro', async (t) => {
  const B = '66777888000191'
  const { db, servico, mock, ids, limpar } = montarComEscritorio([B])
  t.after(limpar)
  const docs = mock.estado(CNPJ_MOCK_ESCRITORIO).docs
  const s2 = docs[1]
  const cancelS2 = docs.find((d) => d.json.procEventoNFe)
  servico.processarDocumento(cliente(db, ids[1]), s2)
  assert.equal(servico.processarDocumento(cliente(db, ids[2]), cancelS2), 'evento')
  const [n] = db.prepare('SELECT * FROM notas').all()
  assert.equal(n.cliente_id, ids[0])
  assert.equal(n.cancelada, 1)
})

test('cliente que recebe procNFe emitido por ele mesmo grava como saída', async (t) => {
  const { db, servico, mock, ids, limpar } = montar()
  t.after(limpar)
  const [s1] = mock.estado(CNPJ_MOCK_ESCRITORIO).docs
  assert.equal(servico.processarDocumento(cliente(db, ids[0]), s1), 'completa')
  const [n] = notas(db)
  assert.equal(n.tipo, 'saida')
  assert.equal(n.destinatario_cnpj, CNPJ_FORA_CARTEIRA)
})

test('documento de tipo desconhecido ou sem chave é ignorado', async (t) => {
  const { db, servico, ids, limpar } = montar()
  t.after(limpar)
  const c = cliente(db, ids[0])
  assert.equal(servico.processarDocumento(c, { nsu: '1', schema: 'outro_v1.xsd', xml: '<x/>', json: {} }), 'ignorado')
  const semChave = '<resNFe versao="1.01"><xNome>Sem chave</xNome></resNFe>'
  assert.equal(servico.processarDocumento(c, { nsu: '2', schema: 'resNFe_v1.01.xsd', xml: semChave, json: xmlParaJson(semChave) }), 'ignorado')
  assert.equal(notas(db).length, 0)
})
