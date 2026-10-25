'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { criarApp } = require('../src/web/server')
const { criarContexto } = require('../src/contexto')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { criarAgendador } = require('../src/scheduler')
const { criarSefazMock, CNPJ_MOCK_OK, CNPJ_MOCK_656 } = require('../src/sefaz/mock-client')
const { gerarPfx } = require('./apoio/certificado')
const { silencioso, inserirNotas } = require('./apoio/ambiente')
const { lerZip } = require('./apoio/zip')

const cert1 = gerarPfx({ cnpj: CNPJ_MOCK_OK })
const cert2 = gerarPfx({ cnpj: CNPJ_MOCK_656 })

async function montar(t, envExtra = {}, { atrasoSefazMs = 0, ehLocal, pastaPainel } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-web-'))
  if (!pastaPainel) {
    pastaPainel = path.join(base, 'painel')
    fs.mkdirSync(pastaPainel)
    fs.writeFileSync(path.join(pastaPainel, 'index.html'), '<!doctype html><title>SmartDoc</title>')
  }
  const env = {
    MASTER_KEY: crypto.randomBytes(32).toString('hex'),
    SEFAZ_MOCK: '1',
    INTERVALO_ENTRE_CHAMADAS_MS: '0',
    PASTA_XMLS: path.join(base, 'xmls'),
    PASTA_CERTS: path.join(base, 'certs'),
    PASTA_EXPORTS: path.join(base, 'exports'),
    ...envExtra,
  }
  const mock = criarSefazMock()
  const fabricaSefaz = (c) => {
    const real = mock.cliente(c.cnpj)
    if (!atrasoSefazMs) return real
    return { ...real, consultaUltNSU: async (n) => (await new Promise((r) => setTimeout(r, atrasoSefazMs)), real.consultaUltNSU(n)) }
  }
  const ctx = criarContexto({ config: carregarConfig(env), logger: silencioso, db: abrirBanco(':memory:'), fabricaSefaz })
  ctx.clientes.cadastrar({ cnpj: CNPJ_MOCK_OK, razao: 'Comercial Exemplo Ltda', uf: 'CE', apelido: 'Exemplo', pfx: cert1.pfx, senha: cert1.senha })
  ctx.clientes.cadastrar({ cnpj: CNPJ_MOCK_656, razao: 'Loja Bloqueada Ltda', uf: 'CE', pfx: cert2.pfx, senha: cert2.senha })
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  const servidor = criarApp({ ctx, agendador, pastaPainel, ...(ehLocal ? { ehLocal } : {}) }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  const url = `http://127.0.0.1:${servidor.address().port}`
  t.after(async () => {
    await new Promise((r) => servidor.close(r))
    fs.rmSync(base, { recursive: true, force: true })
  })

  const pedir = async (caminho, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(url + caminho, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Painel': '1' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    const tipo = r.headers.get('content-type') || ''
    return { status: r.status, headers: r.headers, corpo: tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }
  }
  return { ctx, agendador, url, pedir, mock, senhas: [cert1.senha, cert2.senha] }
}

// Pedido com Host forjado (fetch não deixa trocar o Host).
function pedirComHost(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    http.get({ hostname: u.hostname, port: u.port, path: '/api/resumo', headers: { Host: host } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
}

test('sem o painel compilado, / responde 503 com a orientação', async (t) => {
  const { pedir } = await montar(t, {}, { pastaPainel: path.join(os.tmpdir(), 'nao-existe-' + Date.now()) })
  const r = await pedir('/')
  assert.equal(r.status, 503)
  assert.match(r.corpo.toString(), /Painel não compilado: rode npm install/)
  assert.equal((await pedir('/api/resumo')).status, 200)
})

test('resumo traz a última captura terminada, mesmo sem o agendador', async (t) => {
  const { ctx, pedir } = await montar(t)
  assert.equal((await pedir('/api/resumo')).corpo.ultimaCaptura, null)
  ctx.db.prepare("INSERT INTO execucoes (tipo, inicio, fim) VALUES ('captura', '2026-01-01T10:00:00.000Z', '2026-01-01T10:01:00.000Z')").run()
  ctx.db.prepare("INSERT INTO execucoes (tipo, inicio, fim) VALUES ('captura', '2026-01-02T10:00:00.000Z', NULL)").run()
  ctx.db.prepare("INSERT INTO execucoes (tipo, inicio, fim) VALUES ('ciencia', '2026-01-03T10:00:00.000Z', '2026-01-03T10:01:00.000Z')").run()
  assert.equal((await pedir('/api/resumo')).corpo.ultimaCaptura, '2026-01-01T10:01:00.000Z')
})

test('serve o painel com cabeçalhos de segurança', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/')
  assert.equal(r.status, 200)
  assert.match(r.corpo.toString(), /<title>SmartDoc<\/title>/)
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('x-powered-by'), null)
  assert.deepEqual((await pedir('/api/nada')).corpo, { erro: 'Rota não encontrada.' })
})

test('só aceita o próprio computador como Host e exige X-Painel nas ações', async (t) => {
  const { url, pedir } = await montar(t)
  assert.equal(await pedirComHost(url, 'site-malicioso.com'), 403)
  assert.equal(await pedirComHost(url, `localhost:${new URL(url).port}`), 200)
  const semCabecalho = await pedir('/api/captura', { method: 'POST', body: {}, headers: { 'X-Painel': '0' } })
  assert.equal(semCabecalho.status, 403)
})

test('resumo, clientes e execuções depois de um ciclo; nenhuma senha na API', async (t) => {
  const { ctx, pedir, senhas } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const resumo = await pedir('/api/resumo')
  assert.equal(resumo.corpo.clientesAtivos, 2)
  assert.equal(resumo.corpo.ambiente.sefazSimulada, true)
  assert.equal(resumo.corpo.agendador.ativo, false)
  assert.equal(resumo.corpo.limites.tentativasDownload, 5)
  assert.equal(resumo.corpo.backup.configurado, false, 'sem PASTA_BACKUP')
  assert.match(resumo.corpo.backup.alerta, /PASTA_BACKUP/)

  const clientes = (await pedir('/api/clientes')).corpo.clientes
  const ok = clientes.find((c) => c.cnpj === CNPJ_MOCK_OK)
  assert.deepEqual(ok.notas, { resumo: 0, ciencia: 0, cienciaErro: 0, completa: 2, esgotadas: 0, noMes: 3, entradasNoMes: 3, saidasNoMes: 0 })
  assert.ok(ok.proximaConsulta)
  const bloq = clientes.find((c) => c.cnpj === CNPJ_MOCK_656)
  assert.ok(bloq.bloqueadoAte)
  assert.match(bloq.ultimoErro, /656/)

  const execucoes = (await pedir('/api/execucoes')).corpo
  assert.ok(execucoes.length >= 4)
  assert.ok(execucoes.every((e) => 'cliente_nome' in e))

  const tudo = JSON.stringify([resumo.corpo, clientes, execucoes])
  for (const s of senhas) assert.ok(!tudo.includes(s), 'senha não aparece')
  assert.ok(!/cert_senha_enc|senhaEnc/.test(tudo))
})

test('notas: filtros, paginação de 50 e validação', async (t) => {
  const { ctx, pedir } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  inserirNotas(ctx.db, id, 60, { competencia: '2026-09', status: 'ciencia_enviada', tentativas_download: 5 })

  const todas = (await pedir('/api/notas')).corpo
  assert.equal(todas.total, 63)
  assert.equal(todas.notas.length, 50)
  assert.equal(todas.porPagina, 50)
  assert.equal((await pedir('/api/notas?pagina=2')).corpo.notas.length, 13)

  const set = (await pedir('/api/notas?competencia=2026-09&status=esgotada')).corpo
  assert.equal(set.total, 60)
  assert.equal((await pedir('/api/notas?status=aguardando_xml')).corpo.total, 0, 'esgotadas não contam como aguardando XML')
  inserirNotas(ctx.db, id, 2, { competencia: '2026-09', status: 'ciencia_enviada', tentativas_download: 4, inicio: 100 })
  assert.equal((await pedir('/api/notas?status=aguardando_xml')).corpo.total, 2)
  ctx.db.prepare('DELETE FROM notas WHERE tentativas_download = 4').run()
  assert.equal((await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&status=sem_xml`)).corpo.total, 60)
  assert.equal((await pedir('/api/notas?status=cancelada')).corpo.total, 1)
  assert.equal((await pedir('/api/notas?emitente=gama')).corpo.total, 1)
  assert.equal((await pedir('/api/notas?emitente=34.567.890%2F0001-30')).corpo.total, 1, 'busca pelo CNPJ do emitente')
  assert.equal((await pedir('/api/notas?emitente=%25')).corpo.total, 0, '% é literal, não curinga')
  const faixa = (await pedir('/api/notas?valorMin=100&valorMax=1.500,00')).corpo
  assert.equal(faixa.total, 2)
  assert.equal(faixa.valorTotal, 2320.5)

  assert.equal((await pedir('/api/notas?status=qualquer')).status, 400)
  assert.equal((await pedir('/api/notas?competencia=10-2026')).status, 400)
  assert.equal((await pedir('/api/notas?valorMin=abc')).status, 400)
  const comps = (await pedir('/api/competencias')).corpo
  assert.ok(comps.includes('2026-09'))
  assert.deepEqual(comps, [...comps].sort().reverse(), 'mais recente primeiro')
})

test('download do XML: só nota completa e só de dentro da pasta de XMLs', async (t) => {
  const { ctx, pedir } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const completa = ctx.db.prepare("SELECT * FROM notas WHERE status = 'completa' LIMIT 1").get()
  const r = await pedir(`/api/notas/${completa.id}/xml`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-disposition'), new RegExp(`${completa.chave}-nfe\\.xml`))
  assert.ok(r.corpo.toString().startsWith('<?xml'))

  const resumo = ctx.db.prepare("SELECT id FROM notas WHERE status = 'resumo'").get()
  assert.equal((await pedir(`/api/notas/${resumo.id}/xml`)).status, 404)
  assert.equal((await pedir('/api/notas/123456789012345/xml')).status, 404)
  assert.equal((await pedir('/api/notas/999999/xml')).status, 404)

  ctx.db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?').run('../../../Windows/win.ini', completa.id)
  assert.equal((await pedir(`/api/notas/${completa.id}/xml`)).status, 404, 'caminho fora da pasta é recusado')
})

test('detalhe da nota: XML lido, eventos e nota de resumo sem XML', async (t) => {
  const { ctx, pedir } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const completa = ctx.db.prepare("SELECT * FROM notas WHERE status = 'completa' LIMIT 1").get()
  ctx.db
    .prepare("INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo) VALUES (?, '610600', '1', 'Registro de Autorização de CT-e para a NF-e', '2026-10-09T10:00:00-03:00', '1')")
    .run(completa.chave)
  const r = await pedir(`/api/notas/${completa.id}/detalhe`)
  assert.equal(r.status, 200)
  assert.equal(r.corpo.nota.id, completa.id)
  assert.equal(r.corpo.nota.chave, completa.chave)
  assert.equal(r.corpo.nota.cliente_cnpj, CNPJ_MOCK_OK)
  assert.equal(r.corpo.nfe.ide.chave, completa.chave)
  assert.ok(r.corpo.nfe.emitente.nome)
  assert.ok(r.corpo.eventos.some((e) => e.tp_evento === '610600'))
  assert.equal(r.corpo.erroXml, null)

  const resumo = ctx.db.prepare("SELECT id FROM notas WHERE status = 'resumo'").get()
  const semXml = await pedir(`/api/notas/${resumo.id}/detalhe`)
  assert.equal(semXml.status, 200)
  assert.equal(semXml.corpo.nfe, null)
  assert.equal(semXml.corpo.erroXml, null)
  assert.equal(semXml.corpo.nota.status, 'resumo')

  assert.equal((await pedir('/api/notas/999999/detalhe')).status, 404)

  ctx.db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?').run('../../../Windows/win.ini', completa.id)
  const fora = await pedir(`/api/notas/${completa.id}/detalhe`)
  assert.equal(fora.corpo.nfe, null, 'caminho fora da pasta não é lido')
  assert.match(fora.corpo.erroXml, /não foi encontrado/)
})

test('reprocessar: zera tentativas, devolve ciência com erro para resumo, recusa o resto', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const [esgotada] = inserirNotas(ctx.db, id, 1, { status: 'ciencia_enviada', tentativas_download: 5 })
  const [comErro] = inserirNotas(ctx.db, id, 1, { inicio: 2, status: 'ciencia_erro' })
  const [completa] = inserirNotas(ctx.db, id, 1, { inicio: 3, status: 'completa' })
  const [cancelada] = inserirNotas(ctx.db, id, 1, { inicio: 4, status: 'ciencia_enviada', cancelada: 1 })
  const nota = (c) => ctx.db.prepare('SELECT * FROM notas WHERE chave = ?').get(c)

  const reprocessar = (c) => pedir(`/api/notas/${nota(c).id}/reprocessar`, { method: 'POST' })

  assert.equal((await reprocessar(esgotada)).status, 200)
  assert.equal(nota(esgotada).tentativas_download, 0)
  assert.equal((await reprocessar(comErro)).status, 200)
  assert.equal(nota(comErro).status, 'resumo')
  assert.equal((await reprocessar(completa)).status, 409)
  assert.equal((await reprocessar(cancelada)).status, 409)
})

test('captura pelo painel: 202, recusa a segunda enquanto roda, CNPJ desconhecido 404', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { atrasoSefazMs: 150 })
  const r1 = await pedir('/api/captura', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK } })
  assert.equal(r1.status, 202)
  const r2 = await pedir('/api/captura', { method: 'POST', body: {} })
  assert.equal(r2.status, 409)
  assert.match(r2.corpo.erro, /em andamento/)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj: '00000000000000' } })).status, 404)

  for (let i = 0; i < 50 && (await pedir('/api/resumo')).corpo.capturaEmAndamento; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'completa'").get().n, 2)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: {} })).status, 202, 'livre de novo depois de terminar')
})

async function esperarFimDaCaptura(pedir) {
  for (let i = 0; i < 100 && (await pedir('/api/resumo')).corpo.capturaEmAndamento; i++) await new Promise((r) => setTimeout(r, 20))
}

test('captura com cnpjs: normaliza, tira repetidos e roda só os marcados', async (t) => {
  const { ctx, pedir } = await montar(t)
  const r = await pedir('/api/captura', { method: 'POST', body: { cnpjs: ['11.222.333/0001-81', CNPJ_MOCK_OK] } })
  assert.equal(r.status, 202)
  assert.equal(r.corpo.mensagem, 'Captura de 1 clientes iniciada.')
  await esperarFimDaCaptura(pedir)
  const feitas = ctx.db.prepare("SELECT c.cnpj FROM execucoes e JOIN clientes c ON c.id = e.cliente_id WHERE e.tipo = 'captura'").all()
  assert.ok(feitas.length >= 1)
  assert.ok(feitas.every((e) => e.cnpj === CNPJ_MOCK_OK))
})

test('captura com cnpjs: CNPJ inexistente → 404 e nada roda; escritório → 400; lista vazia ou > 500 → 400', async (t) => {
  const { ctx, pedir } = await montar(t)
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  await pedir('/api/escritorio', { method: 'POST', body: { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha } })
  const execucoes = () => ctx.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n
  const antes = execucoes()
  const post = (cnpjs) => pedir('/api/captura', { method: 'POST', body: { cnpjs } })

  const inexistente = await post([CNPJ_MOCK_OK, '00000000000000'])
  assert.equal(inexistente.status, 404)
  assert.match(inexistente.corpo.erro, /00000000000000 não cadastrado/)
  assert.equal((await post([CNPJ_NOVO])).status, 400)
  assert.equal((await post([])).status, 400)
  assert.equal((await post(Array.from({ length: 501 }, (_, i) => String(i).padStart(14, '0')))).status, 400)
  assert.equal((await post('x')).status, 400)
  assert.equal(execucoes(), antes, 'nada rodou')
})

test('GET /api/clientes mostra capturandoAgora e filaCaptura durante a captura', async (t) => {
  const { pedir } = await montar(t, {}, { atrasoSefazMs: 200 })
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK, CNPJ_MOCK_656] } })).status, 202)
  await new Promise((r) => setTimeout(r, 80))
  const durante = (await pedir('/api/clientes')).corpo
  assert.equal(durante.capturandoAgora, CNPJ_MOCK_OK)
  assert.deepEqual(durante.filaCaptura, [CNPJ_MOCK_656])
  await esperarFimDaCaptura(pedir)
  const fim = (await pedir('/api/clientes')).corpo
  assert.equal(fim.capturandoAgora, null)
  assert.deepEqual(fim.filaCaptura, [])
})

test('GET /api/clientes devolve { clientes, capturandoAgora, filaCaptura }', async (t) => {
  const { pedir } = await montar(t)
  const r = (await pedir('/api/clientes')).corpo
  assert.deepEqual(Object.keys(r).sort(), ['capturandoAgora', 'clientes', 'filaCaptura'])
  assert.equal(r.clientes.length, 2)
  assert.equal(r.capturandoAgora, null)
  assert.deepEqual(r.filaCaptura, [])
})

test('meses do cliente agrupados por ano, do mais recente ao mais antigo', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const grupo = (qtd, inicio, competencia, tipo) => {
    for (const chave of inserirNotas(ctx.db, id, qtd, { inicio, competencia })) ctx.db.prepare('UPDATE notas SET tipo = ? WHERE chave = ?').run(tipo, chave)
  }
  grupo(2, 1, '2026-10', 'entrada')
  grupo(1, 3, '2026-10', 'saida')
  grupo(1, 4, '2026-08', 'entrada')
  grupo(1, 5, '2025-12', 'entrada')
  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo, [
    { ano: 2026, entradas: 3, saidas: 1, meses: [{ mes: 10, entradas: 2, saidas: 1 }, { mes: 8, entradas: 1, saidas: 0 }] },
    { ano: 2025, entradas: 1, saidas: 0, meses: [{ mes: 12, entradas: 1, saidas: 0 }] },
  ])
})

test('meses: CNPJ desconhecido ou do escritório → 404; cliente sem notas → []', async (t) => {
  const { pedir } = await montar(t)
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  await pedir('/api/escritorio', { method: 'POST', body: { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha } })
  assert.equal((await pedir('/api/clientes/00000000000000/meses')).status, 404)
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/meses`)).status, 404)
  const vazio = await pedir(`/api/clientes/${CNPJ_MOCK_656}/meses`)
  assert.equal(vazio.status, 200)
  assert.deepEqual(vazio.corpo, [])
})

test('exportar pelo painel e baixar o ZIP; nome de arquivo forjado é recusado', async (t) => {
  const { ctx, pedir } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const competencia = ctx.db.prepare('SELECT competencia FROM notas LIMIT 1').get().competencia
  const r = await pedir('/api/exportar', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, competencia } })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.xmls, 2)
  assert.equal(r.corpo.url, `/api/exportacoes/${CNPJ_MOCK_OK}_Exemplo_${competencia}.zip`)
  const zip = await pedir(r.corpo.url)
  assert.equal(zip.status, 200)
  assert.equal(zip.headers.get('content-type'), 'application/zip')
  assert.ok(lerZip(zip.corpo).has('resumo.csv'))

  assert.equal((await pedir('/api/exportacoes/..%2F..%2Fdata%2Fnfe.db')).status, 404)
  assert.equal((await pedir(`/api/exportacoes/${CNPJ_MOCK_OK}_x_2020-01.zip`)).status, 404)
  assert.equal((await pedir('/api/exportar', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, competencia: '2026-13' } })).status, 400)
  assert.equal((await pedir('/api/exportar', { method: 'POST', body: {} })).status, 400)
})

test('com PAINEL_SENHA o painel pede a senha (Basic)', async (t) => {
  const { pedir } = await montar(t, { PAINEL_SENHA: 'senha-do-painel' })
  const sem = await pedir('/api/resumo')
  assert.equal(sem.status, 401)
  assert.match(sem.headers.get('www-authenticate'), /Basic/)
  const errada = await pedir('/api/resumo', { headers: { Authorization: `Basic ${Buffer.from('painel:outra').toString('base64')}` } })
  assert.equal(errada.status, 401)
  const certa = await pedir('/api/resumo', { headers: { Authorization: `Basic ${Buffer.from('painel:senha-do-painel').toString('base64')}` } })
  assert.equal(certa.status, 200)
})

test('JSON inválido no corpo vira 400 com mensagem', async (t) => {
  const { url } = await montar(t)
  const r = await fetch(`${url}/api/exportar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Painel': '1' }, body: '{quebrado' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { erro: 'Corpo da requisição inválido.' })
})

// ---------- cadastro pelo painel (só no próprio computador) ----------

const CNPJ_NOVO = '11444777000161'
const pfxBase64 = (c) => c.pfx.toString('base64')

test('cadastro pelo painel: cria o cliente, recusa repetido, senha errada e dados inválidos', async (t) => {
  const { pedir, ctx } = await montar(t)
  assert.equal((await pedir('/api/resumo')).corpo.cadastroLiberado, true)

  const novo = gerarPfx({ cnpj: CNPJ_NOVO, diasValidade: 10 })
  const dados = { cnpj: '11.444.777/0001-61', razao: 'Padaria Teste Ltda', uf: 'ce', apelido: 'Padaria', pfx: pfxBase64(novo), senha: novo.senha }
  const r = await pedir('/api/clientes', { method: 'POST', body: dados })
  assert.equal(r.status, 201)
  assert.equal(r.corpo.cnpj, CNPJ_NOVO)
  assert.equal(r.corpo.uf, 'CE')
  assert.equal(r.corpo.cnpjCertificado, CNPJ_NOVO)
  assert.match(r.corpo.avisos.join(' '), /vence em/)
  assert.ok(!JSON.stringify(r.corpo).includes(novo.senha))
  assert.ok(fs.existsSync(path.join(ctx.config.pastaCerts, `${CNPJ_NOVO}.pfx`)))
  assert.equal((await pedir('/api/clientes')).corpo.clientes.length, 3)

  const repetido = await pedir('/api/clientes', { method: 'POST', body: dados })
  assert.equal(repetido.status, 409)

  const outro = gerarPfx({ cnpj: '11222333000181' })
  const senhaErrada = await pedir('/api/clientes', { method: 'POST', body: { ...dados, cnpj: '45723174000110', pfx: pfxBase64(outro), senha: 'errada' } })
  assert.equal(senhaErrada.status, 400)
  assert.match(senhaErrada.corpo.erro, /Senha do certificado incorreta/)

  const semArquivo = await pedir('/api/clientes', { method: 'POST', body: { ...dados, pfx: '' } })
  assert.equal(semArquivo.status, 400)
  assert.match(semArquivo.corpo.erro, /arquivo do certificado/)

  const cnpjRuim = await pedir('/api/clientes', { method: 'POST', body: { ...dados, cnpj: '12.345.678/0001-00' } })
  assert.equal(cnpjRuim.status, 400)
  assert.match(cnpjRuim.corpo.erro, /CNPJ inválido/)
})

test('troca de certificado e ativar/desativar pelo painel', async (t) => {
  const { pedir } = await montar(t)
  const novo = gerarPfx({ cnpj: CNPJ_MOCK_OK, diasValidade: 700 })
  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/certificado`, { method: 'POST', body: { pfx: pfxBase64(novo), senha: novo.senha } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo.avisos, [])
  const cliente = (await pedir('/api/clientes')).corpo.clientes.find((c) => c.cnpj === CNPJ_MOCK_OK)
  assert.ok(cliente.certDias > 600)

  const deOutraEmpresa = gerarPfx({ cnpj: CNPJ_NOVO })
  const recusado = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/certificado`, { method: 'POST', body: { pfx: pfxBase64(deOutraEmpresa), senha: deOutraEmpresa.senha } })
  assert.equal(recusado.status, 400)
  assert.match(recusado.corpo.erro, /outra empresa/)

  const naoCadastrado = await pedir(`/api/clientes/${CNPJ_NOVO}/certificado`, { method: 'POST', body: { pfx: pfxBase64(deOutraEmpresa), senha: deOutraEmpresa.senha } })
  assert.equal(naoCadastrado.status, 404)

  const desativar = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/ativo`, { method: 'POST', body: { ativo: false } })
  assert.equal(desativar.status, 200)
  assert.equal((await pedir('/api/clientes')).corpo.clientes.find((c) => c.cnpj === CNPJ_MOCK_OK).ativo, false)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/ativo`, { method: 'POST', body: { ativo: 'sim' } })).status, 400)
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/ativo`, { method: 'POST', body: { ativo: true } })).status, 404)
})

test('cadastro recusado fora do próprio computador e sem X-Painel', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  assert.equal((await pedir('/api/resumo')).corpo.cadastroLiberado, false)
  const novo = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: CNPJ_NOVO, razao: 'Padaria Teste Ltda', uf: 'CE', pfx: pfxBase64(novo), senha: novo.senha }
  for (const [caminho, body] of [['/api/clientes', corpo], [`/api/clientes/${CNPJ_MOCK_OK}/certificado`, corpo], [`/api/clientes/${CNPJ_MOCK_OK}/ativo`, { ativo: false }]]) {
    const r = await pedir(caminho, { method: 'POST', body })
    assert.equal(r.status, 403, caminho)
    assert.match(r.corpo.erro, /próprio computador/)
  }
  assert.equal((await pedir('/api/clientes')).corpo.clientes.length, 2)

  const local = await montar(t)
  const semCabecalho = await fetch(`${local.url}/api/clientes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
  assert.equal(semCabecalho.status, 403)
})

test('cadastro: arquivo grande demais vira 400', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/api/clientes', { method: 'POST', body: { cnpj: CNPJ_NOVO, razao: 'X', uf: 'CE', pfx: 'A'.repeat(400 * 1024), senha: 's' } })
  assert.equal(r.status, 400)
  assert.equal(r.corpo.erro, 'Corpo da requisição inválido.')
})

// ---------- notas de saída e escritório ----------

const INSERIR_NOTA = `INSERT INTO notas (cliente_id, chave, tipo, status, cancelada, competencia, tentativas_download, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome, valor_total, data_emissao)
  VALUES (@cliente_id, @chave, @tipo, @status, 0, '2026-10', 0, @emitente_cnpj, @emitente_nome, @destinatario_cnpj, @destinatario_nome, 10, '2026-10-05')`
const nota44 = (n) => '2326101234567800019555001' + String(n).padStart(9, '0') + '1' + '00000000' + '0'
function inserirNota(db, campos) {
  const r = db.prepare(INSERIR_NOTA).run({ tipo: 'entrada', status: 'resumo', emitente_cnpj: null, emitente_nome: null, destinatario_cnpj: null, destinatario_nome: null, ...campos })
  return Number(r.lastInsertRowid)
}

test('notas: filtro por tipo e contraparte acha o destinatário', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(1), tipo: 'entrada', emitente_cnpj: '34567890000130', emitente_nome: 'Gama Atacado' })
  const idSaida = inserirNota(ctx.db, { cliente_id: id, chave: nota44(2), tipo: 'saida', status: 'completa', emitente_cnpj: CNPJ_MOCK_OK, emitente_nome: 'Comercial Exemplo', destinatario_cnpj: '98765432000199', destinatario_nome: 'Mercadinho Beta' })

  assert.equal((await pedir('/api/notas?tipo=saida')).corpo.total, 1)
  assert.equal((await pedir('/api/notas?tipo=entrada')).corpo.total, 1)
  const porNome = (await pedir('/api/notas?contraparte=beta')).corpo
  assert.equal(porNome.total, 1)
  assert.equal(porNome.notas[0].id, idSaida)
  assert.equal(porNome.notas[0].tipo, 'saida')
  assert.equal(porNome.notas[0].destinatario_cnpj, '98765432000199')
  assert.equal(porNome.notas[0].destinatario_nome, 'Mercadinho Beta')
  assert.equal((await pedir('/api/notas?contraparte=98.765.432%2F0001-99')).corpo.total, 1, 'busca pelo CNPJ do destinatário')
  assert.equal((await pedir('/api/notas?emitente=gama')).corpo.total, 1, 'emitente= continua como apelido')
  assert.equal((await pedir('/api/notas?tipo=saida&contraparte=gama')).corpo.total, 0)
  const ruim = await pedir('/api/notas?tipo=outro')
  assert.equal(ruim.status, 400)
  assert.equal(ruim.corpo.erro, 'Tipo inválido.')
})

test('XML e reprocessar por id; chave de 44 dígitos na rota antiga vira 404', async (t) => {
  const { ctx, pedir } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const completa = ctx.db.prepare("SELECT id, chave FROM notas WHERE status = 'completa' LIMIT 1").get()
  assert.equal((await pedir(`/api/notas/${completa.id}/xml`)).status, 200)
  for (const caminho of [`/api/notas/${completa.chave}/xml`, `/api/notas/${completa.chave}/reprocessar`, '/api/notas/abc/xml', '/api/notas/0/xml']) {
    const r = await pedir(caminho, { method: caminho.endsWith('reprocessar') ? 'POST' : 'GET' })
    assert.equal(r.status, 404, caminho)
    assert.equal(r.corpo.erro, 'Nota não encontrada.')
  }
})

test('reprocessar saída é recusado; mesma chave em outro cliente não é afetada', async (t) => {
  const { ctx, pedir } = await montar(t)
  const idA = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const idB = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_656).id
  const chave = nota44(7)
  const saida = inserirNota(ctx.db, { cliente_id: idA, chave, tipo: 'saida', status: 'ciencia_erro' })
  const entrada = inserirNota(ctx.db, { cliente_id: idB, chave, tipo: 'entrada', status: 'ciencia_erro' })
  const linha = (id) => ctx.db.prepare('SELECT * FROM notas WHERE id = ?').get(id)
  const antesA = linha(saida)

  const recusado = await pedir(`/api/notas/${saida}/reprocessar`, { method: 'POST' })
  assert.equal(recusado.status, 409)
  assert.equal(recusado.corpo.erro, 'Nota de saída não passa por ciência nem download.')
  assert.deepEqual(linha(saida), antesA)

  assert.equal((await pedir(`/api/notas/${entrada}/reprocessar`, { method: 'POST' })).status, 200)
  assert.equal(linha(entrada).status, 'resumo')
  assert.deepEqual(linha(saida), antesA, 'a saída do outro cliente fica idêntica')
})

test('escritório pelo painel: cadastra só do próprio PC, aparece em /api/escritorio e não em /api/clientes', async (t) => {
  const { pedir, ctx } = await montar(t)
  assert.equal((await pedir('/api/escritorio')).corpo, null)

  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: '11.444.777/0001-61', razao: 'Contabilidade Teste', uf: 'ce', pfx: pfxBase64(cert), senha: cert.senha }
  const r = await pedir('/api/escritorio', { method: 'POST', body: corpo })
  assert.equal(r.status, 201)
  assert.equal(r.corpo.cnpj, CNPJ_NOVO)
  assert.ok(!JSON.stringify(r.corpo).includes(cert.senha))
  assert.equal((await pedir('/api/escritorio', { method: 'POST', body: corpo })).status, 409)

  const esc = (await pedir('/api/escritorio')).corpo
  assert.equal(esc.cnpj, CNPJ_NOVO)
  assert.equal(esc.razaoSocial, 'Contabilidade Teste')
  assert.equal(esc.uf, 'CE')
  assert.equal(esc.ativo, true)
  assert.equal(esc.saidasNoMes, 0)
  for (const k of ['ultimaConsulta', 'ultimoErro', 'proximaConsulta', 'bloqueadoAte', 'certValidade', 'certDias']) assert.ok(k in esc, k)
  assert.ok(!JSON.stringify(esc).includes(cert.senha))
  const clientes = (await pedir('/api/clientes')).corpo.clientes
  assert.equal(clientes.length, 2)
  assert.ok(!clientes.some((c) => c.cnpj === CNPJ_NOVO))
  assert.ok(clientes.every((c) => c.notas.entradasNoMes === 0 && c.notas.saidasNoMes === 0))

  const nova = gerarPfx({ cnpj: CNPJ_NOVO, diasValidade: 700 })
  const troca = await pedir('/api/escritorio/certificado', { method: 'POST', body: { pfx: pfxBase64(nova), senha: nova.senha } })
  assert.equal(troca.status, 200)
  assert.ok((await pedir('/api/escritorio')).corpo.certDias > 600)

  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj: CNPJ_NOVO } })).status, 202)
  for (let i = 0; i < 50 && (await pedir('/api/resumo')).corpo.capturaEmAndamento; i++) await new Promise((res) => setTimeout(res, 20))
  assert.ok(ctx.clientes.obterEscritorio())
})

test('escritório: cadastro e troca de certificado recusados fora do próprio PC', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha }
  for (const caminho of ['/api/escritorio', '/api/escritorio/certificado']) {
    const r = await pedir(caminho, { method: 'POST', body: corpo })
    assert.equal(r.status, 403, caminho)
  }
  assert.equal((await pedir('/api/escritorio')).corpo, null)
})

// ---------- chaves de automação e ciência à mão ----------

test('automação pelo painel: liga e desliga, recusa valor inválido; ciência à mão', async (t) => {
  const { pedir } = await montar(t)
  assert.deepEqual((await pedir('/api/resumo')).corpo.automacao, { captura: true, ciencia: true })

  const desligar = await pedir('/api/automacao', { method: 'POST', body: { ciencia: false } })
  assert.equal(desligar.status, 200)
  assert.deepEqual(desligar.corpo.automacao, { captura: true, ciencia: false })
  const semBusca = await pedir('/api/automacao', { method: 'POST', body: { captura: false } })
  assert.equal(semBusca.corpo.agendador.automatica, false)
  assert.deepEqual((await pedir('/api/resumo')).corpo.automacao, { captura: false, ciencia: false })

  assert.equal((await pedir('/api/automacao', { method: 'POST', body: { ciencia: 'sim' } })).status, 400)
  assert.equal((await pedir('/api/automacao', { method: 'POST', body: {} })).status, 400)
  assert.equal((await pedir('/api/automacao', { method: 'POST', body: { ciencia: true }, headers: { 'X-Painel': '0' } })).status, 403)

  assert.equal((await pedir('/api/ciencia', { method: 'POST', body: { cnpj: '11444777000161' } })).status, 404)
  const ciencia = await pedir('/api/ciencia', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK } })
  assert.equal(ciencia.status, 202)
  assert.match(ciencia.corpo.mensagem, /Ciência de 11222333000181 iniciada/)
})

test('busca casa com nome, CNPJ e número', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const nota = inserirNota(ctx.db, { cliente_id: id, chave: nota44(1), emitente_cnpj: '05669695000112', emitente_nome: 'TRIGO NORTE' })
  ctx.db.prepare("UPDATE notas SET numero = '7781' WHERE id = ?").run(nota)
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(2), emitente_cnpj: '11111111000111', emitente_nome: 'OUTRA' })
  for (const termo of ['trigo', '0566969', '7781']) {
    const r = (await pedir(`/api/notas?busca=${termo}`)).corpo
    assert.equal(r.total, 1, termo)
    assert.equal(r.notas[0].id, nota)
  }
})

test('busca com % e _ é literal', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const primeira = inserirNota(ctx.db, { cliente_id: id, chave: nota44(1), emitente_nome: 'LOJA 50% OFF' })
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(2), emitente_nome: 'LOJA 500' })
  const r = (await pedir('/api/notas?busca=50%25')).corpo
  assert.equal(r.total, 1)
  assert.equal(r.notas[0].id, primeira)
})

test('ordem por valor asc/desc e coluna inválida → 400', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const valores = [30, 10, 20]
  valores.forEach((v, i) => ctx.db.prepare('UPDATE notas SET valor_total = ? WHERE id = ?').run(v, inserirNota(ctx.db, { cliente_id: id, chave: nota44(i + 1) })))
  const lista = async (ordem) => (await pedir(`/api/notas?ordem=${ordem}`)).corpo.notas.map((n) => n.valor_total)
  assert.deepEqual(await lista('valor-asc'), [10, 20, 30])
  assert.deepEqual(await lista('valor-desc'), [30, 20, 10])
  assert.equal((await pedir('/api/notas?ordem=senha-asc')).status, 400)
  assert.equal((await pedir('/api/notas?ordem=valor-asc;DROP')).status, 400)
  assert.equal((await pedir('/api/notas?ordem=valor')).status, 400)
})

test('somenteIds devolve todos os ids do filtro, sem paginar, até 2.001', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const inserirVarias = (de, ate) => {
    ctx.db.exec('BEGIN')
    for (let i = de; i <= ate; i++) inserirNota(ctx.db, { cliente_id: id, chave: nota44(i) })
    ctx.db.exec('COMMIT')
  }
  inserirVarias(1, 120)
  const r = (await pedir('/api/notas?somenteIds=1')).corpo
  assert.equal(r.ids.length, 120)
  assert.ok(r.ids.every(Number.isInteger))
  assert.deepEqual(Object.keys(r), ['ids'])
  const paginada = (await pedir('/api/notas?ordem=emissao-desc')).corpo.notas.map((n) => n.id)
  assert.deepEqual(r.ids.slice(0, 50), paginada, 'mesma ordem da listagem')
  inserirVarias(121, 2050)
  assert.equal((await pedir('/api/notas?somenteIds=1')).corpo.ids.length, 2001)
})

test('contagemTipo ignora o filtro de tipo e respeita os outros', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(1), tipo: 'entrada' })
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(2), tipo: 'entrada' })
  inserirNota(ctx.db, { cliente_id: id, chave: nota44(3), tipo: 'saida' })
  const outraComp = inserirNota(ctx.db, { cliente_id: id, chave: nota44(4), tipo: 'entrada' })
  ctx.db.prepare("UPDATE notas SET competencia = '2026-09' WHERE id = ?").run(outraComp)
  const r = (await pedir('/api/notas?tipo=saida&competencia=2026-10')).corpo
  assert.equal(r.total, 1)
  assert.deepEqual(r.contagemTipo, { entradas: 2, saidas: 1 })
  assert.deepEqual((await pedir('/api/notas')).corpo.contagemTipo, { entradas: 3, saidas: 1 })
})

// ---------- ZIP das notas selecionadas ----------

function gravarXml(ctx, relativo, conteudo) {
  const destino = path.join(ctx.config.pastaXmls, relativo)
  fs.mkdirSync(path.dirname(destino), { recursive: true })
  fs.writeFileSync(destino, conteudo)
  return relativo
}

test('ZIP das selecionadas: pastas por tipo, canceladas com o evento e avisos', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const [c1, c2, c3, c4, c5] = [1, 2, 3, 4, 5].map(nota44)
  const caminho = (c) => `${CNPJ_MOCK_OK}_Exemplo/2026-10/${c}-nfe.xml`
  const n1 = inserirNota(ctx.db, { cliente_id: id, chave: c1, tipo: 'entrada', status: 'completa' })
  const n2 = inserirNota(ctx.db, { cliente_id: id, chave: c2, tipo: 'saida', status: 'completa' })
  const n3 = inserirNota(ctx.db, { cliente_id: id, chave: c3, tipo: 'entrada', status: 'completa' })
  const n4 = inserirNota(ctx.db, { cliente_id: id, chave: c4, tipo: 'entrada', status: 'resumo' })
  const n5 = inserirNota(ctx.db, { cliente_id: id, chave: c5, tipo: 'saida', status: 'completa' })
  const atualizar = ctx.db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?')
  gravarXml(ctx, caminho(c1), '<nfe>1</nfe>')
  gravarXml(ctx, caminho(c2), '<nfe>2</nfe>')
  gravarXml(ctx, caminho(c3), '<nfe>3</nfe>')
  for (const [n, c] of [[n1, c1], [n2, c2], [n3, c3], [n5, c5]]) atualizar.run(caminho(c), n)
  ctx.db.prepare('UPDATE notas SET cancelada = 1 WHERE id = ?').run(n3)
  const evento = `${CNPJ_MOCK_OK}_Exemplo/eventos/2026-10/${c3}-evento-110111-1.xml`
  gravarXml(ctx, evento, '<evento/>')
  ctx.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(c3, evento)
  const execucoesAntes = ctx.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n

  const r = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [n1, n2, n3, n4, n5] } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/zip')
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="11222333000181_Exemplo_selecionadas_\d{8}-\d{6}\.zip"/)
  const zip = lerZip(r.corpo)
  assert.deepEqual([...zip.keys()].sort(), [
    'avisos.txt',
    `canceladas/${c3}-evento-110111-1.xml`,
    `canceladas/${c3}-nfe.xml`,
    `entradas/${c1}-nfe.xml`,
    `saidas/${c2}-nfe.xml`,
  ].sort())
  assert.equal(zip.get(`entradas/${c1}-nfe.xml`).toString(), '<nfe>1</nfe>')
  const avisos = zip.get('avisos.txt').toString()
  assert.ok(avisos.includes(`Nota ${c4}: sem XML completo.`))
  assert.ok(avisos.includes(`Nota ${c5}: XML não encontrado no disco.`))
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM notas WHERE exportada_em IS NOT NULL').get().n, 0)
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM execucoes').get().n, execucoesAntes)
})

test('ZIP: sem avisos não leva avisos.txt; cliente sem apelido usa a razão social no nome', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_656).id
  const c = nota44(1)
  const n = inserirNota(ctx.db, { cliente_id: id, chave: c, status: 'completa' })
  const rel = `${CNPJ_MOCK_656}_Loja/2026-10/${c}-nfe.xml`
  gravarXml(ctx, rel, '<nfe/>')
  ctx.db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?').run(rel, n)
  const r = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [n] } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-disposition'), /99888777000100_Loja_Bloqueada_Ltda_selecionadas_/)
  assert.deepEqual([...lerZip(r.corpo).keys()], [`entradas/${c}-nfe.xml`])
})

test('ZIP: ids vazios, > 2.000 ou não inteiros → 400; id inexistente → 404; dois clientes → 400; nenhuma com XML → 409', async (t) => {
  const { ctx, pedir } = await montar(t)
  const ids = ctx.db.prepare('SELECT id FROM clientes ORDER BY id').all().map((c) => c.id)
  const a = inserirNota(ctx.db, { cliente_id: ids[0], chave: nota44(1), status: 'completa' })
  const b = inserirNota(ctx.db, { cliente_id: ids[1], chave: nota44(2), status: 'completa' })
  const zip = (body) => pedir('/api/notas/zip', { method: 'POST', body })
  assert.equal((await zip({ ids: [] })).status, 400)
  assert.equal((await zip({})).status, 400)
  assert.equal((await zip({ ids: [1.5] })).status, 400)
  assert.equal((await zip({ ids: ['1'] })).status, 400)
  assert.equal((await zip({ ids: Array.from({ length: 2001 }, (_, i) => i + 1) })).status, 400)
  assert.equal((await zip({ ids: [a, 99999] })).status, 404)
  assert.equal((await zip({ ids: [a, b] })).status, 400)
  const r = await zip({ ids: [a] })
  assert.equal(r.status, 409)
  assert.match(r.corpo.erro, /Nenhuma das notas marcadas tem XML completo/)
})

test('ZIP: sem X-Painel → 403', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [1] }, headers: { 'X-Painel': '0' } })
  assert.equal(r.status, 403)
})

test('XML + eventos: ZIP com a nota e os eventos que têm arquivo', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const c = nota44(1)
  const n = inserirNota(ctx.db, { cliente_id: id, chave: c, status: 'completa' })
  const rel = gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/2026-10/${c}-nfe.xml`, '<nfe/>')
  ctx.db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?').run(rel, n)
  const cancel = gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/eventos/2026-10/${c}-evento-110111-1.xml`, '<cancelamento/>')
  const cce = gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/eventos/2026-10/${c}-evento-110110-1.xml`, '<cce/>')
  const evento = ctx.db.prepare('INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, ?, ?, ?)')
  evento.run(c, '110111', '1', cancel)
  evento.run(c, '110110', '1', cce)
  evento.run(c, '210210', '1', null) // ciência enviada por nós: sem arquivo
  evento.run(c, '110110', '2', `${CNPJ_MOCK_OK}_Exemplo/eventos/2026-10/sumiu.xml`) // arquivo apagado do disco

  const r = await pedir(`/api/notas/${n}/xml-eventos`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/zip')
  assert.match(r.headers.get('content-disposition'), new RegExp(`attachment; filename="${c}-nfe-eventos.zip"`))
  const zip = lerZip(r.corpo)
  assert.deepEqual([...zip.keys()].sort(), [`${c}-evento-110110-1.xml`, `${c}-evento-110111-1.xml`, `${c}-nfe.xml`])
  assert.equal(zip.get(`${c}-evento-110111-1.xml`).toString(), '<cancelamento/>')
})

test('XML + eventos: nota sem XML → 404; id inválido → 404', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const n = inserirNota(ctx.db, { cliente_id: id, chave: nota44(1), status: 'resumo' })
  const r = await pedir(`/api/notas/${n}/xml-eventos`)
  assert.equal(r.status, 404)
  assert.match(r.corpo.erro, /ainda não tem o XML completo/)
  assert.equal((await pedir('/api/notas/abc/xml-eventos')).status, 404)
})
