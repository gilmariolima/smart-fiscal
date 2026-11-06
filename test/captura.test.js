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
const { VERSAO_XML } = require('../src/services/migracaoPastas')

const silencioso = { info() {}, warn() {}, error() {} }
const AGORA = new Date('2026-10-09T12:00:00Z')

function montar({ mock = criarSefazMock({ dataBase: AGORA }), clientes = [CNPJ_MOCK_OK], agora = () => AGORA, fabrica } = {}) {
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
// procNFe mínimo da nota do resumo.
function procDe(_mock, chave) {
  const xml = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00"><ide><nNF>1</nNF><serie>1</serie><dhEmi>2026-10-05T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${chave.slice(6, 20)}</CNPJ><xNome>Emitente</xNome></emit><dest><CNPJ>${CNPJ_MOCK_OK}</CNPJ><xNome>Destino</xNome></dest><total><ICMSTot><vNF>10.00</vNF></ICMSTot></total></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`
  return { xml, json: xmlParaJson(xml), schema: 'procNFe_v4.00.xsd', nsu: '000000000000099' }
}
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

  const pasta = 'Cliente 1/2026/10-Outubro/Entradas/NF-e/XML'
  const avulsos = 'Cliente 1/2026/10-Outubro/Eventos e Resumos/NF-e'
  assert.deepEqual(arquivos(pastaXmls), [
    `${avulsos}/${alfa.chave}-resumo.xml`,
    `${avulsos}/${beta.chave}-evento-110111-1.xml`,
    `${avulsos}/${beta.chave}-resumo.xml`,
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
  // Um arquivo no lugar da pasta da empresa faz o mkdir falhar.
  fs.writeFileSync(path.join(pastaXmls, 'Cliente 1'), 'bloqueio')
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
  assert.ok(xmls.some((f) => f.startsWith('Cliente 1/') && f.endsWith(`${chave}-nfe.xml`)))
  assert.ok(xmls.some((f) => f.startsWith('Cliente 2/') && f.endsWith(`${chave}-nfe.xml`)))
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
  const pastaFora = new RegExp(`^Cliente 2 Ltda/Sem cliente cadastrado/\\d{4}/[^/]+/Entradas/NF-e/XML/${f1}-nfe\\.xml$`)
  assert.ok(arquivos(pastaXmls).some((f) => pastaFora.test(f)), 'XML fora da carteira na pasta do escritório')

  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas WHERE cliente_id = ?').get(ids[1]).n, 0)
  const evento = db.prepare('SELECT * FROM eventos WHERE chave = ?').get(s2)
  assert.ok(evento.caminho_xml.startsWith('Cliente 1'), 'evento na pasta do dono da nota')
  assert.ok(evento.caminho_xml.replace(/\\/g, '/').includes('/Eventos e Resumos/NF-e/'), 'evento fora de entradas e saídas')
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

test('escritório que também é cliente: guarda a nota destinada a ele como entrada própria', async (t) => {
  const { db, servico, mock, ids, limpar } = montarComEscritorio()
  t.after(limpar)
  db.prepare('UPDATE clientes SET tambem_cliente = 1 WHERE id = ?').run(ids[1])
  const docs = mock.estado(CNPJ_MOCK_ESCRITORIO).docs
  const resumo = docs.find((d) => d.json.resNFe)
  assert.equal(servico.processarDocumento(cliente(db, ids[1]), resumo), 'resumo')

  // procNFe de fora da carteira destinado ao escritório: entrada dele, não "fora da carteira".
  const [s1] = docs
  const xml = s1.xml.replace(CNPJ_FORA_CARTEIRA, CNPJ_MOCK_ESCRITORIO)
  const doc = { nsu: '000000000000009', schema: s1.schema, xml, json: xmlParaJson(xml) }
  assert.equal(servico.processarDocumento(cliente(db, ids[1]), doc), 'completa')

  const doEscritorio = db.prepare('SELECT tipo, status FROM notas WHERE cliente_id = ? ORDER BY status').all(ids[1])
  assert.deepEqual(doEscritorio, [{ tipo: 'entrada', status: 'completa' }, { tipo: 'entrada', status: 'resumo' }])
  assert.equal(db.prepare('SELECT tipo FROM notas WHERE cliente_id = ?').get(ids[0]).tipo, 'saida', 'a saída do cliente continua nele')
})

test('nota de saída que chega pelo escritório fica na empresa sem certificado, mesmo desativada', async (t) => {
  const { db, servico, mock, ids, limpar } = montarComEscritorio()
  t.after(limpar)
  db.prepare("UPDATE clientes SET cert_arquivo = '', cert_senha_enc = '', cert_validade = NULL, ativo = 0 WHERE id = ?").run(ids[0])
  const r = await servico.capturarCliente(ids[1])
  assert.equal(r.ok, true)
  assert.equal(r.saida, 2)
  const [s1] = mock.estado(CNPJ_MOCK_ESCRITORIO).docs.map((d) => d.json.nfeProc?.protNFe.infProt.chNFe)
  const [n] = db.prepare('SELECT * FROM notas WHERE chave = ?').all(s1)
  assert.equal(n.cliente_id, ids[0])
  assert.equal(n.tipo, 'saida')
  assert.equal(n.status, 'completa')
})

test('nota completa tira o resumo dela; os outros ficam, e resumo repetido depois não volta', async (t) => {
  const { db, servico, mock, ids, pastaXmls, limpar } = montar()
  t.after(limpar)
  const sefaz = mock.cliente(CNPJ_MOCK_OK)
  const c = cliente(db, ids[0])
  const [resumoA, resumoB] = (await sefaz.consultaUltNSU('0')).data.docZip
  servico.processarDocumento(c, resumoA)
  servico.processarDocumento(c, resumoB)
  const chave = resumoA.json.resNFe.chNFe
  const outra = resumoB.json.resNFe.chNFe
  const resumos = () => arquivos(pastaXmls).filter((f) => f.endsWith('-resumo.xml'))
  assert.equal(resumos().length, 2)

  servico.processarDocumento(c, { ...procDe(mock, chave), nsu: '000000000000099' })

  assert.equal(db.prepare('SELECT status FROM notas WHERE chave = ?').get(chave).status, 'completa')
  assert.equal(resumos().length, 1)
  assert.ok(resumos()[0].includes(outra), 'o da nota que não chegou fica')
  assert.ok(arquivos(pastaXmls).some((f) => f.endsWith(`${chave}-nfe.xml`)))

  servico.processarDocumento(c, resumoA)
  assert.equal(resumos().length, 1, 'resumo repetido da nota completa não é regravado')
  assert.equal(db.prepare('SELECT status FROM notas WHERE chave = ?').get(chave).status, 'completa')
})

test('resumo preso não impede a nota completa de ser gravada', async (t) => {
  const { db, servico, mock, ids, pastaXmls, limpar } = montar()
  t.after(limpar)
  const c = cliente(db, ids[0])
  const [resumoA] = (await mock.cliente(CNPJ_MOCK_OK).consultaUltNSU('0')).data.docZip
  servico.processarDocumento(c, resumoA)
  const chave = resumoA.json.resNFe.chNFe
  const rm = fs.rmSync
  t.mock.method(fs, 'rmSync', (alvo, ...resto) => {
    if (String(alvo).endsWith('-resumo.xml')) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
    return rm(alvo, ...resto)
  })
  assert.equal(servico.processarDocumento(c, procDe(mock, chave)), 'completa')
  t.mock.restoreAll()
  assert.equal(db.prepare('SELECT status FROM notas WHERE chave = ?').get(chave).status, 'completa')
  assert.ok(arquivos(pastaXmls).some((f) => f.endsWith(`${chave}-resumo.xml`)), 'fica; a limpeza não é crítica')
})

// ---------- notas de terceiros gravadas como entrada do escritório ----------

const EMITENTE = '34567890000130'
const CHAVE_EMITENTE = (n) => `2326${'11'}${EMITENTE}55001${String(n).padStart(9, '0')}1${'0'.repeat(7)}${n % 10}`.slice(0, 44).padEnd(44, '0')
const PASTA_ESC = path.join('Cliente 2 Ltda', '2026', '10-Outubro', 'Entradas', 'NF-e')

function comNotaDeTerceiro(t, { dest = { CPF: '12345678909' }, emit = EMITENTE, n = 1, emitenteCadastrado = true } = {}) {
  const m = montarComEscritorio()
  t.after(m.limpar)
  m.db.prepare("UPDATE clientes SET razao_social = 'Cliente 2 Ltda', tambem_cliente = 1 WHERE id = ?").run(m.ids[1])
  if (emitenteCadastrado) m.db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Emitente Ltda', 'Emitente', 'CE', 'x.pfx', 'a:b:c')").run(emit)
  m.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(VERSAO_XML)
  const chave = CHAVE_EMITENTE(n)
  const destXml = dest.CPF ? `<CPF>${dest.CPF}</CPF>` : `<CNPJ>${dest.CNPJ}</CNPJ>`
  const xml = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00"><ide><nNF>${n}</nNF><serie>1</serie><dhEmi>2026-10-05T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${emit}</CNPJ><xNome>Emitente</xNome></emit><dest>${destXml}<xNome>Destino</xNome></dest><total><ICMSTot><vNF>10.00</vNF></ICMSTot></total><autXML><CNPJ>${CNPJ_MOCK_ESCRITORIO}</CNPJ></autXML></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`
  const rel = path.join(PASTA_ESC, 'XML', `${chave}-nfe.xml`)
  const abs = (...r) => path.join(m.pastaXmls, ...r)
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), xml)
  fs.mkdirSync(abs(PASTA_ESC, 'PDF'), { recursive: true })
  fs.writeFileSync(abs(PASTA_ESC, 'PDF', `${chave}-nfe.pdf`), 'pdf')
  m.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml, nsu) VALUES (?, ?, 'nfe', 'entrada', 'completa', '2026-10', ?, '000000000000050')").run(m.ids[1], chave, rel)
  m.db.prepare("INSERT INTO pasta_grupos (cliente_id, competencia, modelo, direcao, assinatura, gerado_em) VALUES (?, '2026-10', 'nfe', 'entrada', 'x', 'y')").run(m.ids[1])
  fs.writeFileSync(abs(PASTA_ESC, 'Relatorio NF-e Entradas Outubro 2026.pdf'), 'r')
  fs.writeFileSync(abs(PASTA_ESC, 'Cliente 2 Ltda NF-e Entradas Outubro 2026.zip'), 'z')
  const linhas = (id) => m.db.prepare('SELECT * FROM notas WHERE cliente_id = ?').all(id)
  const idEmitente = emitenteCadastrado ? m.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').pluck().get(emit) : null
  return { ...m, chave, rel, abs, xml, linhas, idEmitente, corrigir: () => m.servico.corrigirNotasDoEscritorio() }
}

test('correção: nota de terceiro sai do escritório e vira saída do emitente, com o XML inteiro', (t) => {
  const a = comNotaDeTerceiro(t)
  const r = a.corrigir()
  assert.deepEqual(r, { movidas: 1, resgatadas: 0, copias: 0, semDono: 0, falhas: 0 })
  assert.equal(a.linhas(a.ids[1]).length, 0)
  const [nota] = a.linhas(a.idEmitente)
  assert.equal(nota.tipo, 'saida')
  assert.equal(nota.status, 'completa')
  assert.equal(nota.caminho_xml, path.join('Emitente', '2026', '10-Outubro', 'Saidas', 'NF-e', 'XML', `${a.chave}-nfe.xml`))
  assert.ok(fs.readFileSync(a.abs(nota.caminho_xml), 'utf8').includes('<autXML>'))
  assert.ok(!fs.existsSync(a.abs(a.rel)), 'o XML sai do escritório')
  assert.ok(!fs.existsSync(a.abs(PASTA_ESC)), 'mês sem notas: relatório, ZIP e PDF saem do escritório')
  assert.equal(a.db.prepare('SELECT COUNT(*) n FROM pasta_grupos WHERE cliente_id = ?').get(a.ids[1]).n, 0)
})

test('correção: destinatário cadastrado também recebe a nota, como entrada', (t) => {
  const a = comNotaDeTerceiro(t, { dest: { CNPJ: CNPJ_MOCK_OK } })
  assert.equal(a.corrigir().movidas, 1)
  assert.equal(a.linhas(a.idEmitente)[0].tipo, 'saida')
  assert.equal(a.linhas(a.ids[0]).find((n) => n.chave === a.chave).tipo, 'entrada')
  assert.equal(a.linhas(a.ids[1]).length, 0)
})

test('correção: nota em que o escritório é destinatário fica; o mês continua com relatório', (t) => {
  const a = comNotaDeTerceiro(t, { dest: { CNPJ: CNPJ_MOCK_ESCRITORIO } })
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 0, semDono: 0, falhas: 0 })
  assert.equal(a.linhas(a.ids[1]).length, 1)
  assert.ok(fs.existsSync(a.abs(a.rel)))
  assert.ok(fs.existsSync(a.abs(PASTA_ESC, 'Relatorio NF-e Entradas Outubro 2026.pdf')))
})

test('correção: sem emitente nem destinatário cadastrados, fica onde está', (t) => {
  const a = comNotaDeTerceiro(t, { emitenteCadastrado: false })
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 0, semDono: 1, falhas: 0 })
  assert.equal(a.linhas(a.ids[1]).length, 1)
  assert.ok(fs.existsSync(a.abs(a.rel)))
})

test('correção: sem escritório não faz nada, e depois de concluída não repete', (t) => {
  const a = comNotaDeTerceiro(t)
  a.db.prepare("UPDATE clientes SET papel = 'cliente' WHERE id = ?").run(a.ids[1])
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 0, semDono: 0, falhas: 0 })
  assert.equal(a.linhas(a.ids[1]).length, 1)

  a.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(a.ids[1])
  assert.equal(a.corrigir().movidas, 1)
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, 'z', 'nfe', 'entrada', 'completa', '2026-10', ?)").run(a.ids[1], a.rel)
  assert.equal(a.corrigir().movidas, 0)
})

test('correção: gravar o XML novo falhou: a nota fica no escritório e tenta de novo depois', (t) => {
  const a = comNotaDeTerceiro(t)
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (de, ...resto) => {
    if (String(de).endsWith('.tmp')) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
    return rename(de, ...resto)
  })
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 0, semDono: 0, falhas: 1 })
  t.mock.restoreAll()
  assert.equal(a.linhas(a.ids[1]).length, 1)
  assert.ok(fs.existsSync(a.abs(a.rel)))
  assert.equal(a.corrigir().movidas, 1)
  assert.equal(a.linhas(a.ids[1]).length, 0)
})

test('correção: origem presa ao apagar: a nota já mudou de dono e o arquivo só sobra', (t) => {
  const a = comNotaDeTerceiro(t)
  const rm = fs.rmSync
  t.mock.method(fs, 'rmSync', (alvo, ...resto) => {
    if (String(alvo) === a.abs(a.rel)) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
    return rm(alvo, ...resto)
  })
  assert.equal(a.corrigir().movidas, 1)
  t.mock.restoreAll()
  assert.equal(a.linhas(a.ids[1]).length, 0)
  assert.ok(fs.existsSync(a.abs(a.rel)))
})

// ---------- notas guardadas em fora-da-carteira ----------

function comNotaFora(t, opcoes) {
  const a = comNotaDeTerceiro(t, opcoes)
  a.db.prepare('DELETE FROM notas').run()
  a.db.prepare('DELETE FROM pasta_grupos').run()
  const rel = path.join('Cliente 2 Ltda', 'Sem cliente cadastrado', '2026', '10-Outubro', 'Entradas', 'NF-e', 'XML', `${a.chave}-nfe.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), a.xml)
  fs.rmSync(a.abs(PASTA_ESC), { recursive: true, force: true })
  return { ...a, relFora: rel }
}

test('correção: nota que só existe em fora-da-carteira vai para o emitente como saída e sai de lá', (t) => {
  const a = comNotaFora(t)
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 1, copias: 0, semDono: 0, falhas: 0 })
  const [nota] = a.linhas(a.idEmitente)
  assert.equal(nota.tipo, 'saida')
  assert.equal(nota.chave, a.chave)
  assert.ok(fs.readFileSync(a.abs(nota.caminho_xml), 'utf8').includes('<autXML>'))
  assert.ok(!fs.existsSync(a.abs(a.relFora)))
  assert.ok(!fs.existsSync(a.abs('Cliente 2 Ltda', 'Sem cliente cadastrado')), 'pasta vazia some')
})

test('correção: cópia de nota que já está com o dono sai da pasta, e a pasta vazia some', (t) => {
  const a = comNotaFora(t)
  const rel = path.join('Emitente', 'nota.xml')
  fs.mkdirSync(a.abs('Emitente'), { recursive: true })
  fs.writeFileSync(a.abs(rel), a.xml)
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'saida', 'completa', '2026-10', ?)").run(a.idEmitente, a.chave, rel)
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 1, semDono: 0, falhas: 0 })
  assert.ok(!fs.existsSync(a.abs('Cliente 2 Ltda', 'Sem cliente cadastrado')))
  assert.ok(fs.existsSync(a.abs(rel)), 'a nota do dono fica')
})

test('correção: cópia fica se o arquivo do dono não está no disco, ou se a nota está com outra empresa', (t) => {
  const a = comNotaFora(t)
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'saida', 'completa', '2026-10', 'sumiu.xml')").run(a.idEmitente, a.chave)
  assert.equal(a.corrigir().copias, 0)
  assert.ok(fs.existsSync(a.abs(a.relFora)))

  const b = comNotaFora(t)
  fs.mkdirSync(b.abs('Outra'), { recursive: true })
  fs.writeFileSync(b.abs('Outra', 'nota.xml'), b.xml)
  b.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'entrada', 'completa', '2026-10', ?)").run(b.ids[0], b.chave, path.join('Outra', 'nota.xml'))
  assert.equal(b.corrigir().copias, 0)
  assert.ok(fs.existsSync(b.abs(b.relFora)))
})

test('nota sem cliente cadastrado cria a pasta com o nome novo só quando chega', async (t) => {
  const { servico, mock, ids, pastaXmls, limpar, db } = montarComEscritorio()
  t.after(limpar)
  assert.ok(!arquivos(pastaXmls).some((f) => f.includes('Sem cliente cadastrado')))
  await servico.capturarCliente(ids[1])
  assert.ok(arquivos(pastaXmls).some((f) => f.includes('/Sem cliente cadastrado/')))
  assert.ok(!arquivos(pastaXmls).some((f) => f.includes('fora-da-carteira')))
  assert.ok(db && mock)
})

test('correção: nota de fora-da-carteira sem cliente cadastrado fica lá', (t) => {
  const a = comNotaFora(t, { emitenteCadastrado: false })
  assert.deepEqual(a.corrigir(), { movidas: 0, resgatadas: 0, copias: 0, semDono: 1, falhas: 0 })
  assert.ok(fs.existsSync(a.abs(a.relFora)))
})

test('correção: nota de fora-da-carteira que não grava fica lá e tenta de novo', (t) => {
  const a = comNotaFora(t)
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (de, ...resto) => {
    if (String(de).endsWith('.tmp')) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
    return rename(de, ...resto)
  })
  assert.equal(a.corrigir().falhas, 1)
  t.mock.restoreAll()
  assert.ok(fs.existsSync(a.abs(a.relFora)))
  assert.equal(a.corrigir().resgatadas, 1)
})
