'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
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
const { criarGrupos } = require('../src/services/pastaOrganizada')
const { gerarPfx } = require('./apoio/certificado')
const { silencioso, inserirNotas } = require('./apoio/ambiente')
const { lerZip } = require('./apoio/zip')

const { criarAdnMock } = require('../src/sefaz/adn-mock')
const cert1 = gerarPfx({ cnpj: CNPJ_MOCK_OK })
const cert2 = gerarPfx({ cnpj: CNPJ_MOCK_656 })

async function montar(t, envExtra = {}, { atrasoSefazMs = 0, ehLocal, pastaPainel, atualizacao, adn = criarAdnMock({ documentos: {} }) } = {}) {
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
  const mock = criarSefazMock({ cienciaDoDono: true })
  const fabricaSefaz = (c) => {
    const real = mock.cliente(c.cnpj)
    if (!atrasoSefazMs) return real
    return { ...real, consultaUltNSU: async (n) => (await new Promise((r) => setTimeout(r, atrasoSefazMs)), real.consultaUltNSU(n)) }
  }
  const ctx = criarContexto({ config: carregarConfig(env), logger: silencioso, db: abrirBanco(':memory:'), fabricaSefaz, fabricaAdn: (c) => adn.cliente(c.cnpj) })
  ctx.clientes.cadastrar({ cnpj: CNPJ_MOCK_OK, razao: 'Comercial Exemplo Ltda', uf: 'CE', apelido: 'Exemplo', pfx: cert1.pfx, senha: cert1.senha })
  ctx.clientes.cadastrar({ cnpj: CNPJ_MOCK_656, razao: 'Loja Bloqueada Ltda', uf: 'CE', pfx: cert2.pfx, senha: cert2.senha })
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  const servidor = criarApp({ ctx, agendador, pastaPainel, atualizacao, ...(ehLocal ? { ehLocal } : {}) }).listen(0, '127.0.0.1')
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
  return { ctx, agendador, url, pedir, mock, adn, senhas: [cert1.senha, cert2.senha] }
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
  assert.match(resumo.corpo.backup.alerta, /tela Backup/)

  const clientes = (await pedir('/api/clientes')).corpo.clientes
  const ok = clientes.find((c) => c.cnpj === CNPJ_MOCK_OK)
  assert.deepEqual(ok.notas, { resumo: 0, ciencia: 0, cienciaErro: 0, completa: 2, esgotadas: 0, noMes: 3, entradasNoMes: 3, saidasNoMes: 0 })
  assert.ok(ok.proximaConsulta)
  const bloq = clientes.find((c) => c.cnpj === CNPJ_MOCK_656)
  assert.ok(bloq.bloqueadoAte)
  assert.match(bloq.ultimoErro, /656/)

  const execucoes = (await pedir('/api/execucoes')).corpo
  assert.ok(execucoes.length >= 2)
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
  // "Baixar XML" da tela: nota sem evento vem como XML solto, não um ZIP.
  if (!ctx.db.prepare('SELECT 1 FROM eventos WHERE chave = ?').get(completa.chave)) {
    const solto = await pedir(`/api/notas/${completa.id}/xml-eventos`)
    assert.equal(solto.status, 200)
    assert.match(solto.headers.get('content-type'), /application\/xml/)
    assert.match(solto.headers.get('content-disposition'), new RegExp(`filename="${completa.chave}-nfe\.xml"`))
  }
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

test('meses do cliente agrupados por ano, do mais recente ao mais antigo; só notas com XML', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const grupo = (qtd, inicio, competencia, tipo) => {
    for (const chave of inserirNotas(ctx.db, id, qtd, { inicio, competencia })) ctx.db.prepare("UPDATE notas SET tipo = ?, status = 'completa' WHERE chave = ?").run(tipo, chave)
  }
  grupo(2, 1, '2026-10', 'entrada')
  grupo(1, 3, '2026-10', 'saida')
  grupo(1, 4, '2026-08', 'entrada')
  grupo(1, 5, '2025-12', 'entrada')
  inserirNotas(ctx.db, id, 1, { inicio: 6, competencia: '2026-10' }) // sem XML: fica em XMLs não baixados, não conta
  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo, [
    { ano: 2026, entradas: 3, saidas: 1, outros: 0, meses: [{ mes: 10, entradas: 2, saidas: 1, outros: 0 }, { mes: 8, entradas: 1, saidas: 0, outros: 0 }] },
    { ano: 2025, entradas: 1, saidas: 0, outros: 0, meses: [{ mes: 12, entradas: 1, saidas: 0, outros: 0 }] },
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
  assert.ok(lerZip(zip.corpo).has('notas.xlsx'))

  // "Exportar mês" de um modelo: nome com _NF-e e o download funciona.
  const soNfe = await pedir('/api/exportar', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, competencia, modelo: 'nfe' } })
  assert.equal(soNfe.corpo.url, `/api/exportacoes/${CNPJ_MOCK_OK}_Exemplo_${competencia}_NF-e.zip`)
  assert.equal((await pedir(soNfe.corpo.url)).status, 200)
  // Só o relatório: PDF solto com o nome da empresa.
  const pdf = await pedir('/api/exportar', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, competencia, modelo: 'nfe', incluir: ['pdf'] } })
  assert.equal(pdf.corpo.url, `/api/exportacoes/Exemplo_${competencia}_NF-e.pdf`)
  const baixado = await pedir(pdf.corpo.url)
  assert.equal(baixado.status, 200)
  assert.equal(baixado.headers.get('content-type'), 'application/pdf')
  assert.equal((await pedir('/api/exportar', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, competencia, modelo: 'cte' } })).status, 400)

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
  const ruim = await pedir('/api/notas?tipo=xx')
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

test('escritório: edita razão social e UF; excluir apaga cadastro, certificado e execuções, e permite cadastrar de novo', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { config } = ctx
  assert.equal((await pedir('/api/escritorio/dados', { method: 'POST', body: { razao: 'X', uf: 'CE' } })).status, 404)
  assert.equal((await pedir('/api/escritorio/excluir', { method: 'POST', body: {} })).status, 404)

  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha }
  assert.equal((await pedir('/api/escritorio', { method: 'POST', body: corpo })).status, 201)

  const editar = await pedir('/api/escritorio/dados', { method: 'POST', body: { razao: '  Contabilidade Nova Ltda ', uf: 'pi' } })
  assert.equal(editar.status, 200)
  const esc = (await pedir('/api/escritorio')).corpo
  assert.deepEqual([esc.razaoSocial, esc.uf, esc.cnpj], ['Contabilidade Nova Ltda', 'PI', CNPJ_NOVO])
  assert.equal((await pedir('/api/escritorio/dados', { method: 'POST', body: { razao: ' ', uf: 'CE' } })).status, 400)
  assert.equal((await pedir('/api/escritorio/dados', { method: 'POST', body: { razao: 'Y', uf: 'XX' } })).status, 400)

  const { id, cert_arquivo } = ctx.db.prepare("SELECT id, cert_arquivo FROM clientes WHERE papel = 'escritorio'").get()
  ctx.db.prepare("INSERT INTO execucoes (cliente_id, tipo, inicio, fim) VALUES (?, 'captura', '2026-10-01', '2026-10-01')").run(id)
  const pfx = path.join(config.pastaCerts, cert_arquivo)
  assert.ok(fs.existsSync(pfx))

  const excluir = await pedir('/api/escritorio/excluir', { method: 'POST', body: {} })
  assert.equal(excluir.status, 200)
  assert.match(excluir.corpo.mensagem, /Contabilidade Nova Ltda excluído/)
  assert.equal((await pedir('/api/escritorio')).corpo, null)
  assert.ok(!fs.existsSync(pfx))
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM execucoes WHERE cliente_id = ?').get(id).n, 0)
  assert.equal((await pedir('/api/escritorio', { method: 'POST', body: corpo })).status, 201)
})

test('escritório: cadastro e troca de certificado recusados fora do próprio PC', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha }
  for (const caminho of ['/api/escritorio', '/api/escritorio/certificado', '/api/escritorio/dados', '/api/escritorio/excluir']) {
    const r = await pedir(caminho, { method: 'POST', body: corpo })
    assert.equal(r.status, 403, caminho)
  }
  assert.equal((await pedir('/api/escritorio')).corpo, null)
})

// ---------- atualização do app ----------

test('atualização pelo painel: estado e verificar; fora do app instalado fica indisponível', async (t) => {
  const { pedir } = await montar(t)
  assert.deepEqual((await pedir('/api/atualizacao')).corpo, { situacao: 'indisponivel' })
  assert.deepEqual((await pedir('/api/atualizacao/verificar', { method: 'POST', body: {} })).corpo, { situacao: 'indisponivel' })
  assert.equal((await pedir('/api/atualizacao/verificar', { method: 'POST', body: {}, headers: { 'X-Painel': '0' } })).status, 403)
})

test('atualização pelo painel: repassa o estado e o verificar do app', async (t) => {
  let verificou = 0
  const atualizacao = { estado: () => ({ situacao: 'baixando', versao: '9.9.9', progresso: 10 }), verificar: async () => (verificou++, { situacao: 'atualizado' }) }
  const { pedir } = await montar(t, {}, { atualizacao })
  assert.deepEqual((await pedir('/api/atualizacao')).corpo, { situacao: 'baixando', versao: '9.9.9', progresso: 10 })
  assert.deepEqual((await pedir('/api/atualizacao/verificar', { method: 'POST', body: {} })).corpo, { situacao: 'atualizado' })
  assert.equal(verificou, 1)
})

// ---------- backup ----------

test('backup pelo painel: escolhe a pasta, faz na hora, desliga; só do próprio PC', async (t) => {
  const { pedir, ctx } = await montar(t)
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-web-backup-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const inicio = (await pedir('/api/backup')).corpo
  assert.deepEqual([inicio.configurado, inicio.origem], [false, null])
  assert.equal((await pedir('/api/backup/agora', { method: 'POST', body: {} })).status, 409)
  assert.equal((await pedir('/api/backup/pasta', { method: 'POST', body: { pasta: 'relativa' } })).status, 400)

  const salvar = await pedir('/api/backup/pasta', { method: 'POST', body: { pasta } })
  assert.equal(salvar.status, 200)
  assert.match(salvar.corpo.mensagem, /primeiro backup já começou/)
  await ctx.backup.aguardar()
  const feito = (await pedir('/api/backup')).corpo
  assert.deepEqual([feito.configurado, feito.origem, feito.pasta, feito.alerta], [true, 'painel', pasta, null])
  assert.ok(fs.existsSync(path.join(pasta, 'diarios')))
  assert.equal((await pedir('/api/resumo')).corpo.backup.configurado, true)

  assert.equal((await pedir('/api/backup/agora', { method: 'POST', body: {} })).status, 202)
  await ctx.backup.aguardar()
  const desligar = await pedir('/api/backup/pasta', { method: 'POST', body: { pasta: '' } })
  assert.match(desligar.corpo.mensagem, /desligado/)
  assert.equal((await pedir('/api/backup')).corpo.configurado, false)
})

test('backup: trocar a pasta fora do próprio PC é recusado', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  assert.equal((await pedir('/api/backup/pasta', { method: 'POST', body: { pasta: os.tmpdir() } })).status, 403)
  assert.equal((await pedir('/api/backup')).corpo.configurado, false)
})

// ---------- pastas ----------

const xmlsEm = (pasta) => (fs.existsSync(pasta) ? fs.readdirSync(pasta, { recursive: true }).filter((n) => n.endsWith('.xml')) : [])

test('pastas: troca a dos XMLs levando os arquivos, as notas continuam abrindo', async (t) => {
  const { pedir, ctx } = await montar(t)
  await ctx.ciclo.executarCiclo()
  const padrao = ctx.config.pastaXmls
  const antes = xmlsEm(padrao)
  assert.ok(antes.length > 0)
  const nota = ctx.db.prepare('SELECT id FROM notas WHERE caminho_xml IS NOT NULL LIMIT 1').get()
  const estranho = path.join(padrao, 'anotacoes.txt') // o que não é do Smart Fiscal fica onde está
  fs.writeFileSync(estranho, 'x')
  const nova = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-web-xmls-'))
  t.after(() => fs.rmSync(nova, { recursive: true, force: true }))

  const inicio = (await pedir('/api/pastas')).corpo
  assert.deepEqual(inicio.pastas.map((p) => [p.tipo, p.ehPadrao]), [['xmls', true], ['exports', true]])
  assert.equal((await pedir('/api/pastas', { method: 'POST', body: { tipo: 'xmls', pasta: 'relativa' } })).status, 400)
  assert.equal((await pedir('/api/pastas', { method: 'POST', body: { tipo: 'xmls', pasta: path.join(padrao, 'dentro') } })).status, 400)
  assert.equal((await pedir('/api/pastas', { method: 'POST', body: { tipo: 'outra', pasta: nova } })).status, 400)

  const r = await pedir('/api/pastas', { method: 'POST', body: { tipo: 'xmls', pasta: `"${nova}"` } })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.match(r.corpo.mensagem, new RegExp(`${antes.length} arquivo`))
  assert.deepEqual(r.corpo.estado.pastas[0], { tipo: 'xmls', nome: 'XMLs das notas', pasta: nova, padrao, ehPadrao: false })
  assert.equal(ctx.config.pastaXmls, nova)
  assert.deepEqual(xmlsEm(nova).sort(), antes.sort())
  assert.deepEqual(xmlsEm(padrao), [])
  assert.ok(fs.existsSync(estranho))
  assert.equal((await pedir(`/api/notas/${nota.id}/xml`)).status, 200)
  assert.equal(ctx.db.prepare("SELECT valor FROM sistema WHERE chave = 'pasta_xmls'").get().valor, nova)

  assert.equal((await pedir('/api/pastas', { method: 'POST', body: { tipo: 'xmls', pasta: '' } })).status, 400, 'não há volta para a padrão')
})

test('pastas: a escolha salva vale ao abrir de novo; trocar fora do próprio PC é recusado', async (t) => {
  const { pedir, ctx } = await montar(t, {}, { ehLocal: () => false })
  const nova = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-web-exp-'))
  t.after(() => fs.rmSync(nova, { recursive: true, force: true }))
  assert.equal((await pedir('/api/pastas', { method: 'POST', body: { tipo: 'exports', pasta: nova } })).status, 403)
  assert.equal((await pedir('/api/pastas/abrir', { method: 'POST', body: { tipo: 'exports' } })).status, 403)
  ctx.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_exports', ?)").run(nova)
  const config = carregarConfig({ MASTER_KEY: 'a'.repeat(64), SEFAZ_MOCK: '1', PASTA_EXPORTS: path.join(os.tmpdir(), 'nao-usada') })
  criarContexto({ config, logger: silencioso, db: ctx.db })
  assert.equal(config.pastaExports, nova)
})

// ---------- chaves de automação e ciência à mão ----------

test('automação pelo painel: só horários, sem chave geral; não há ciência', async (t) => {
  const { pedir } = await montar(t)
  assert.equal((await pedir('/api/resumo')).corpo.automacao, undefined)

  assert.equal((await pedir('/api/automacao', { method: 'POST', body: { captura: false } })).status, 400)
  assert.equal((await pedir('/api/automacao', { method: 'POST', body: { ciencia: true } })).status, 400)
  assert.equal((await pedir('/api/automacao', { method: 'POST', body: {} })).status, 400)
  assert.equal((await pedir('/api/automacao', { method: 'POST', body: { horarios: ['09:00'] }, headers: { 'X-Painel': '0' } })).status, 403)
  const ok = await pedir('/api/automacao', { method: 'POST', body: { horarios: ['09:00'] } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.corpo.agendador.horarios, ['09:00'])
  assert.equal((await pedir('/api/ciencia', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK } })).status, 404)
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
  assert.deepEqual(r.contagemTipo, { entradas: 2, saidas: 1, outros: 0 })
  assert.deepEqual((await pedir('/api/notas')).corpo.contagemTipo, { entradas: 3, saidas: 1, outros: 0 })
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
  // Todas do mesmo mês e modelo: o nome leva o mês e o modelo.
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="11222333000181_Exemplo_2026-10_NF-e\.zip"/)
  const zip = lerZip(r.corpo)
  assert.deepEqual([...zip.keys()].sort(), [
    'avisos.txt',
    `NF-e/Entradas/Canceladas/${c3}-evento-110111-1.xml`,
    `NF-e/Entradas/Canceladas/${c3}-nfe.xml`,
    `NF-e/Entradas/${c1}-nfe.xml`,
    `NF-e/Saidas/${c2}-nfe.xml`,
  ].sort())
  assert.equal(zip.get(`NF-e/Entradas/${c1}-nfe.xml`).toString(), '<nfe>1</nfe>')
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
  assert.match(r.headers.get('content-disposition'), /99888777000100_Loja_Bloqueada_Ltda_2026-10_NF-e\.zip/)
  assert.deepEqual([...lerZip(r.corpo).keys()], [`NF-e/Entradas/${c}-nfe.xml`])
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

test('XML + eventos: CT-e baixa como <chave>-cte, solto e no ZIP', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const c = nota44(2)
  const n = inserirNota(ctx.db, { cliente_id: id, chave: c, status: 'completa' })
  const rel = gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/2026/10/CT-e/Entradas/${c}-cte.xml`, '<cteProc/>')
  ctx.db.prepare("UPDATE notas SET modelo = 'cte', caminho_xml = ? WHERE id = ?").run(rel, n)

  const solto = await pedir(`/api/notas/${n}/xml-eventos`)
  assert.equal(solto.status, 200)
  assert.match(solto.headers.get('content-disposition'), new RegExp(`attachment; filename="${c}-cte.xml"`))

  const cancel = gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/2026/10/CT-e/Entradas/Eventos/${c}-evento-110111-1.xml`, '<cancelamento/>')
  ctx.db.prepare('INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, ?, ?, ?)').run(c, '110111', '1', cancel)
  const r = await pedir(`/api/notas/${n}/xml-eventos`)
  assert.match(r.headers.get('content-disposition'), new RegExp(`attachment; filename="${c}-cte-eventos.zip"`))
  assert.deepEqual([...lerZip(r.corpo).keys()].sort(), [`${c}-cte.xml`, `${c}-evento-110111-1.xml`])
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

test('clientes: resultado da última captura de NFS-e e erro dela', async (t) => {
  const adn = criarAdnMock()
  adn.falhar(CNPJ_MOCK_656, 'HTTP 403')
  const { ctx, pedir } = await montar(t, {}, { adn })
  await ctx.ciclo.executarCiclo()
  const clientes = (await pedir('/api/clientes')).corpo.clientes
  const ok = clientes.find((c) => c.cnpj === CNPJ_MOCK_OK)
  assert.deepEqual(ok.nfse.ultimoRecebido, { notas: 3, eventos: 1, docs: 4 })
  assert.equal(ok.nfse.ultimoErro, null)
  assert.ok(ok.nfse.proximaConsulta)
  assert.ok(ok.nfse.ultimaConsulta)
  const erro = clientes.find((c) => c.cnpj === CNPJ_MOCK_656)
  assert.equal(erro.nfse.ultimoErro, 'HTTP 403')
  assert.equal(erro.nfse.ultimoRecebido, null)
  assert.ok(ok.ultimoRecebido === null || ok.ultimoRecebido.cStat !== 'DOCUMENTOS_LOCALIZADOS', 'NF-e não mistura com NFS-e')
})

test('notas: filtro por modelo e contagens cruzadas com o tipo', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const todas = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}`)).corpo
  const nfe = todas.contagemModelo.nfe
  assert.ok(nfe > 0)
  assert.equal(todas.contagemModelo.nfse, 3)
  const so = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=nfse`)).corpo
  assert.equal(so.total, 3)
  assert.ok(so.notas.every((n) => n.modelo === 'nfse'))
  assert.deepEqual(so.contagemTipo, { entradas: 2, saidas: 1, outros: 0 }, 'contagem por tipo segue o modelo escolhido')
  const saidas = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&tipo=saida`)).corpo
  assert.equal(saidas.contagemModelo.nfse, 1, 'contagem por modelo segue o tipo escolhido')
  assert.equal((await pedir('/api/notas?modelo=x')).status, 400)
})

test('detalhe da NFS-e: prestador, tomador, município e valor', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const id = ctx.db.prepare("SELECT id FROM notas WHERE modelo = 'nfse' AND tipo = 'saida'").get().id
  const r = (await pedir(`/api/notas/${id}/detalhe`)).corpo
  assert.equal(r.nfe, null)
  assert.equal(r.erroXml, null)
  assert.equal(r.nota.modelo, 'nfse')
  assert.deepEqual(r.nfse.prestador, { cnpj: CNPJ_MOCK_OK, nome: `PRESTADOR ${CNPJ_MOCK_OK}` })
  assert.equal(r.nfse.tomador.cnpj, '99888777000166')
  assert.equal(r.nfse.valor, 1000)
  assert.equal(r.nfse.competencia, '2026-10')
  assert.equal(r.nfse.municipio, 'FORTALEZA')
  assert.equal(r.nfse.descricaoServico, 'Serviço de teste')
})

test('captura com modelos: só NFS-e repassa ao ciclo; valor inválido → 400', async (t) => {
  const { ctx, pedir, mock } = await montar(t, {}, { adn: criarAdnMock() })
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK], modelos: ['xml'] } })).status, 400)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK], modelos: [] } })).status, 400)
  const r = await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK], modelos: ['nfse'] } })
  assert.equal(r.status, 202)
  for (let i = 0; i < 50 && ctx.db.prepare("SELECT COUNT(*) n FROM execucoes WHERE tipo = 'captura_nfse' AND fim IS NOT NULL").get().n === 0; i++) await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM execucoes WHERE tipo = 'captura_nfse'").get().n, 1)
  assert.equal(mock.chamadas.length, 0, 'nada de NF-e')
})

test('notas: novas=1 traz só as que chegaram na última captura do modelo', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  assert.equal((await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=nfse&novas=1`)).corpo.total, 0, 'sem captura, nada é novo')
  await ctx.ciclo.executarCiclo()
  const r = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=nfse&novas=1`)).corpo
  assert.equal(r.total, 3)
  assert.ok(r.notas.every((n) => n.modelo === 'nfse'))
  // A contagem da captura é a mesma da lista (notas distintas, não documentos).
  const exec = ctx.db
    .prepare("SELECT e.id, e.notas_recebidas FROM execucoes e JOIN clientes c ON c.id = e.cliente_id WHERE e.tipo = 'captura_nfse' AND c.cnpj = ? ORDER BY e.id DESC")
    .get(CNPJ_MOCK_OK)
  assert.equal(exec.notas_recebidas, 3)
  // Nota trazida por uma captura anterior não entra.
  ctx.db.prepare('UPDATE notas SET captura_id = ? WHERE id = ?').run(exec.id - 1000, r.notas[0].id)
  assert.equal((await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=nfse&novas=1`)).corpo.total, 2)
  assert.equal((await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&novas=1`)).status, 400)
})

test('meses do cliente por modelo: NF-e e NFS-e separadas; modelo inválido → 400', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const soma = (anos) => anos.reduce((s, a) => s + a.entradas + a.saidas, 0)
  const todas = soma((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses`)).corpo)
  const nfe = soma((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses?modelo=nfe`)).corpo)
  const nfse = soma((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses?modelo=nfse`)).corpo)
  assert.equal(nfse, 3)
  assert.ok(nfe > 0)
  assert.equal(nfe + nfse, todas)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses?modelo=mdfe`)).status, 400)
})

test('notas: somenteContagem devolve só as contagens', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const r = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=nfse&somenteContagem=1`)).corpo
  assert.deepEqual(r, { contagemTipo: { entradas: 2, saidas: 1, outros: 0 }, contagemModelo: r.contagemModelo })
  assert.equal(r.contagemModelo.nfse, 3)
})

test('planilha do mês: baixa o notas.xlsx sem marcar nada como exportado', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const competencia = ctx.db.prepare("SELECT competencia FROM notas WHERE modelo = 'nfse' LIMIT 1").get().competencia
  const r = await pedir(`/api/planilha?cnpj=${CNPJ_MOCK_OK}&competencia=${competencia}`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(r.headers.get('content-disposition'), new RegExp(`attachment; filename="?${CNPJ_MOCK_OK}_Exemplo_${competencia}\.xlsx"?`))
  assert.ok(lerZip(r.corpo).has('xl/worksheets/sheet3.xml'))
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM notas WHERE exportada_em IS NOT NULL').get().n, 0)
  assert.equal((await pedir(`/api/planilha?cnpj=${CNPJ_MOCK_OK}&competencia=10-2026`)).status, 400)
  assert.equal((await pedir('/api/planilha?cnpj=00000000000000&competencia=2026-10')).status, 404)
})

test('PDF da NFS-e: gera o DANFSe na hora; NF-e não tem', async (t) => {
  const { ctx, pedir } = await montar(t, {}, { adn: criarAdnMock() })
  await ctx.ciclo.executarCiclo()
  const nfse = ctx.db.prepare("SELECT id, chave FROM notas WHERE modelo = 'nfse' LIMIT 1").get()
  const r = await pedir(`/api/notas/${nfse.id}/pdf`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/pdf')
  assert.match(r.headers.get('content-disposition'), new RegExp(`${nfse.chave}-nfse\.pdf`))
  assert.equal(r.corpo.subarray(0, 5).toString(), '%PDF-')
  const nfe = ctx.db.prepare("SELECT id FROM notas WHERE modelo = 'nfe' LIMIT 1").get()
  assert.equal((await pedir(`/api/notas/${nfe.id}/pdf`)).status, 404)
})

test('escritório cadastrado como cliente aparece em Clientes, tem meses e sai da lista ao desativar', async (t) => {
  const { pedir } = await montar(t)
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  const corpo = { cnpj: CNPJ_NOVO, razao: 'Contabilidade Teste', uf: 'CE', pfx: pfxBase64(cert), senha: cert.senha }
  assert.equal((await pedir('/api/escritorio', { method: 'POST', body: corpo })).status, 201)
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/meses`)).status, 404)

  const cadastro = await pedir('/api/clientes', { method: 'POST', body: { ...corpo, apelido: 'Meu escritório' } })
  assert.equal(cadastro.status, 201)
  const lista = () => pedir('/api/clientes').then((r) => r.corpo.clientes)
  const esc = (await lista()).find((c) => c.cnpj === CNPJ_NOVO)
  assert.deepEqual([esc.escritorio, esc.apelido, esc.razaoSocial, esc.ativo], [true, null, 'Contabilidade Teste', true])
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/meses`)).status, 200)

  const fora = await pedir(`/api/clientes/${CNPJ_NOVO}/ativo`, { method: 'POST', body: { ativo: false } })
  assert.match(fora.corpo.mensagem, /fora da lista de clientes/)
  assert.ok(!(await lista()).some((c) => c.cnpj === CNPJ_NOVO))
  assert.ok((await pedir('/api/escritorio')).corpo, 'o escritório continua cadastrado')
})

test('Baixar selecionados com escolha: planilha e PDF soltos, DANFSe e pacote completo em ZIP; meses diferentes → "selecionadas"', async (t) => {
  const { ctx, pedir } = await montar(t)
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const fortaleza = fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'))
  const [c1, c2] = [1, 2].map(nota44)
  const rel = (c) => `${CNPJ_MOCK_OK}_Exemplo/2026-10/${c}-nfse.xml`
  const n1 = inserirNota(ctx.db, { cliente_id: id, chave: c1, status: 'completa' })
  const n2 = inserirNota(ctx.db, { cliente_id: id, chave: c2, tipo: 'saida', status: 'completa' })
  for (const [n, c] of [[n1, c1], [n2, c2]]) {
    gravarXml(ctx, rel(c), fortaleza)
    ctx.db.prepare("UPDATE notas SET modelo = 'nfse', competencia = '2026-10', caminho_xml = ? WHERE id = ?").run(rel(c), n)
  }
  const baixar = (incluir, ids = [n1, n2]) => pedir('/api/notas/zip', { method: 'POST', body: { ids, incluir } })

  const pdf = await baixar(['pdf'])
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.match(pdf.headers.get('content-disposition'), /filename="Exemplo_2026-10_NFS-e\.pdf"/)

  const xlsx = await baixar(['excel'])
  assert.match(xlsx.headers.get('content-disposition'), /filename="Exemplo_2026-10_NFS-e\.xlsx"/)
  assert.match(lerZip(xlsx.corpo).get('xl/workbook.xml').toString(), /name="Entradas".*name="Saídas"/)

  const danfse = await baixar(['danfse'])
  assert.equal(danfse.headers.get('content-type'), 'application/zip')
  assert.deepEqual([...lerZip(danfse.corpo).keys()].sort(), [`NFS-e/Entradas/${c1}-nfse.pdf`, `NFS-e/Saidas/${c2}-nfse.pdf`])

  const completo = await baixar(['xml', 'danfse', 'excel', 'pdf'])
  assert.match(completo.headers.get('content-disposition'), /filename="11222333000181_Exemplo_2026-10_NFS-e\.zip"/)
  assert.equal([...lerZip(completo.corpo).keys()].length, 6, '2 XMLs + 2 DANFSe + planilha + relatório')

  ctx.db.prepare("UPDATE notas SET competencia = '2026-09' WHERE id = ?").run(n2)
  assert.match((await baixar(['pdf'])).headers.get('content-disposition'), /filename="Exemplo_selecionadas_\d{8}-\d{6}\.pdf"/)
  assert.equal((await baixar(['exe'])).status, 400)
})

test('Baixar selecionados → Arquivos DANFE: PDF de cada NF-e ao lado do XML, no ZIP', async (t) => {
  const { ctx, pedir } = await montar(t)
  const { nfeProc, item } = require('./apoio/nfe')
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const c = nota44(7)
  const rel = `${CNPJ_MOCK_OK}_Exemplo/2026-10/${c}-nfe.xml`
  const n = inserirNota(ctx.db, { cliente_id: id, chave: c, status: 'completa' })
  gravarXml(ctx, rel, nfeProc({ det: item(1) }))
  ctx.db.prepare("UPDATE notas SET competencia = '2026-10', caminho_xml = ? WHERE id = ?").run(rel, n)
  const r = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [n], incluir: ['danfe'] } })
  assert.equal(r.status, 200)
  const zip = lerZip(r.corpo)
  assert.deepEqual([...zip.keys()], [`NF-e/Entradas/${c}-nfe.pdf`])
  assert.equal(zip.get(`NF-e/Entradas/${c}-nfe.pdf`).subarray(0, 5).toString(), '%PDF-')
})

test('busca automática por cliente: liga e desliga por tipo; /api/clientes mostra a escolha', async (t) => {
  const { pedir } = await montar(t)
  const lista = async () => (await pedir('/api/clientes')).corpo.clientes.find((c) => c.cnpj === CNPJ_MOCK_OK)
  assert.deepEqual((await lista()).automatica, { nfe: true, nfse: true, cte: true })
  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/automatica`, { method: 'POST', body: { modelo: 'nfse', ligado: false } })
  assert.equal(r.status, 200)
  assert.deepEqual((await lista()).automatica, { nfe: true, nfse: false, cte: true })
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/automatica`, { method: 'POST', body: { modelo: 'mdfe', ligado: false } })).status, 400)
  const rc = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/automatica`, { method: 'POST', body: { modelo: 'cte', ligado: false } })
  assert.equal(rc.status, 200)
  assert.deepEqual((await lista()).automatica, { nfe: true, nfse: false, cte: false })
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/automatica`, { method: 'POST', body: { modelo: 'nfe' } })).status, 400)
  assert.equal((await pedir('/api/clientes/99999999000199/automatica', { method: 'POST', body: { modelo: 'nfe', ligado: true } })).status, 404)
})

test('busca automática de vários clientes de uma vez: só o tipo escolhido e só quem veio na lista', async (t) => {
  const { pedir } = await montar(t)
  const auto = async (cnpj) => (await pedir('/api/clientes')).corpo.clientes.find((c) => c.cnpj === cnpj).automatica
  const enviar = (body) => pedir('/api/clientes/automatica', { method: 'POST', body })

  const r = await enviar({ modelo: 'nfe', ligado: false, cnpjs: [CNPJ_MOCK_OK, CNPJ_MOCK_656] })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.alterados, 2)
  assert.deepEqual(await auto(CNPJ_MOCK_OK), { nfe: false, nfse: true, cte: true })
  assert.deepEqual(await auto(CNPJ_MOCK_656), { nfe: false, nfse: true, cte: true })

  await enviar({ modelo: 'nfe', ligado: true, cnpjs: [CNPJ_MOCK_656] })
  assert.equal((await auto(CNPJ_MOCK_OK)).nfe, false)
  assert.equal((await auto(CNPJ_MOCK_656)).nfe, true)

  assert.equal((await enviar({ modelo: 'mdfe', ligado: true, cnpjs: [CNPJ_MOCK_OK] })).status, 400)
  assert.equal((await enviar({ modelo: 'nfe', ligado: 'sim', cnpjs: [CNPJ_MOCK_OK] })).status, 400)
  assert.equal((await enviar({ modelo: 'nfe', ligado: true })).status, 400)

  // CNPJ desconhecido: ninguém muda.
  const desconhecido = await enviar({ modelo: 'nfe', ligado: true, cnpjs: [CNPJ_MOCK_OK, '99999999000199'] })
  assert.equal(desconhecido.status, 404)
  assert.equal((await auto(CNPJ_MOCK_OK)).nfe, false)
})

test('editar cliente: muda razão, apelido e UF e leva a pasta e os caminhos das notas junto', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { db, config } = ctx
  const cliente = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  const relativo = path.join('Exemplo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'Entradas', 'a.xml')
  fs.mkdirSync(path.join(config.pastaXmls, path.dirname(relativo)), { recursive: true })
  fs.writeFileSync(path.join(config.pastaXmls, relativo), '<x/>')
  const chave = '2'.repeat(44)
  db.prepare("INSERT INTO notas (cliente_id, chave, status, caminho_xml) VALUES (?, ?, 'completa', ?)").run(cliente.id, chave, relativo)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(chave, relativo)

  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: ' Razão Nova Ltda ', uf: 'pi', apelido: 'Nome Novo' } })
  assert.equal(r.status, 200)
  const depois = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente.id)
  assert.deepEqual([depois.razao_social, depois.uf, depois.apelido], ['Razão Nova Ltda', 'PI', 'Nome Novo'])
  assert.equal(depois.ult_nsu, cliente.ult_nsu)

  const novo = path.join('Nome Novo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'Entradas', 'a.xml')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas WHERE chave = ?').get(chave).c, novo)
  assert.equal(db.prepare('SELECT caminho_xml c FROM eventos WHERE chave = ?').get(chave).c, novo)
  assert.ok(fs.existsSync(path.join(config.pastaXmls, novo)))
  assert.ok(!fs.existsSync(path.join(config.pastaXmls, 'Exemplo')))

  assert.equal((await pedir('/api/clientes/99999999000199/editar', { method: 'POST', body: { cnpj: '99999999000199', razao: 'X', uf: 'CE' } })).status, 404)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: '', uf: 'CE' } })).status, 400)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'X', uf: 'ZZ' } })).status, 400)
})

test('editar cliente: pasta de destino ocupada não perde nada; o nome muda e os XMLs ficam onde estão', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { db, config } = ctx
  const cliente = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  const relativo = path.join('Exemplo', 'a.xml')
  fs.mkdirSync(path.join(config.pastaXmls, 'Exemplo'), { recursive: true })
  fs.writeFileSync(path.join(config.pastaXmls, relativo), '<x/>')
  fs.mkdirSync(path.join(config.pastaXmls, 'Ocupado'), { recursive: true })
  db.prepare("INSERT INTO notas (cliente_id, chave, status, caminho_xml) VALUES (?, ?, 'completa', ?)").run(cliente.id, '3'.repeat(44), relativo)

  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'R', uf: 'CE', apelido: 'Ocupado' } })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.avisos.length, 1)
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas WHERE cliente_id = ?').get(cliente.id).c, relativo)
  assert.ok(fs.existsSync(path.join(config.pastaXmls, relativo)))
})

test('editar cliente: CNPJ muda só sem notas e zera as filas, porque o NSU é de cada CNPJ', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { db, config } = ctx
  const antes = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  db.prepare("UPDATE clientes SET ult_nsu = '000000000000050', nfse_ult_nsu = '7', cte_ult_nsu = '9', proxima_consulta = 'x', bloqueado_ate = 'y' WHERE id = ?").run(antes.id)
  const FILIAL = '11222333000262'
  const editar = (corpo) => pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { razao: 'R', uf: 'CE', ...corpo } })

  // Outra raiz: o certificado guardado não serve para esse CNPJ.
  assert.equal((await editar({ cnpj: CNPJ_NOVO })).status, 400)
  // CNPJ de outro cliente.
  assert.equal((await editar({ cnpj: CNPJ_MOCK_656 })).status, 409)
  assert.equal((await editar({ cnpj: '123' })).status, 400)

  const r = await editar({ cnpj: FILIAL })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.cnpj, FILIAL)
  const depois = db.prepare('SELECT * FROM clientes WHERE id = ?').get(antes.id)
  assert.equal(depois.cnpj, FILIAL)
  assert.equal(Number(depois.ult_nsu), 0)
  assert.equal(Number(depois.nfse_ult_nsu), 0)
  assert.equal(Number(depois.cte_ult_nsu), 0)
  assert.equal(depois.proxima_consulta, null)
  assert.equal(depois.bloqueado_ate, null)
  assert.equal(depois.cert_arquivo, `${FILIAL}.pfx`)
  assert.ok(fs.existsSync(path.join(config.pastaCerts, `${FILIAL}.pfx`)))
  assert.ok(!fs.existsSync(path.join(config.pastaCerts, `${CNPJ_MOCK_OK}.pfx`)))

  db.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (?, ?, 'resumo')").run(antes.id, '4'.repeat(44))
  const comNotas = await pedir(`/api/clientes/${FILIAL}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'R', uf: 'CE' } })
  assert.equal(comNotas.status, 400)
  assert.match(comNotas.corpo.erro, /notas/)
})

test('editar cliente sem certificado: CNPJ muda para qualquer raiz', async (t) => {
  const { pedir, ctx } = await montar(t)
  ctx.clientes.cadastrar({ cnpj: CNPJ_NOVO, razao: 'Sem Cert', uf: 'CE' })
  const r = await pedir(`/api/clientes/${CNPJ_NOVO}/editar`, { method: 'POST', body: { cnpj: '12345678000195', razao: 'Sem Cert', uf: 'CE' } })
  assert.equal(r.status, 200)
  assert.ok(ctx.clientes.obter('12345678000195'))
})

test('excluir cliente: sai cadastro, certificado e registros; os XMLs continuam no disco', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { db, config } = ctx
  const a = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  const b = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_656)
  const relativo = path.join('Exemplo', 'a.xml')
  fs.mkdirSync(path.join(config.pastaXmls, 'Exemplo'), { recursive: true })
  fs.writeFileSync(path.join(config.pastaXmls, relativo), '<x/>')
  const [so, juntos] = ['5'.repeat(44), '6'.repeat(44)]
  const nota = db.prepare("INSERT INTO notas (cliente_id, chave, status, caminho_xml) VALUES (?, ?, 'completa', ?)")
  nota.run(a.id, so, relativo)
  nota.run(a.id, juntos, relativo)
  nota.run(b.id, juntos, relativo) // a mesma nota nos dois clientes (A vende para B)
  const evento = db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq) VALUES (?, '110111', '1')")
  evento.run(so)
  evento.run(juntos)
  db.prepare("INSERT INTO execucoes (cliente_id, tipo, inicio, fim) VALUES (?, 'captura', 'x', 'y')").run(a.id)

  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/excluir`, { method: 'POST', body: {} })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.notas, 2)
  assert.equal(ctx.clientes.obter(CNPJ_MOCK_OK), null)
  assert.ok(!fs.existsSync(path.join(config.pastaCerts, a.cert_arquivo)))
  assert.ok(fs.existsSync(path.join(config.pastaXmls, relativo)), 'o XML não é apagado')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas WHERE cliente_id = ?').get(a.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM execucoes WHERE cliente_id = ?').get(a.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE chave = ?').get(so).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE chave = ?').get(juntos).n, 1, 'o evento da nota do outro cliente fica')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas WHERE cliente_id = ?').get(b.id).n, 1)

  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/excluir`, { method: 'POST', body: {} })).status, 404)
})

test('excluir e editar cliente: escritório fica de fora e nada muda durante a captura', async (t) => {
  const { pedir, ctx } = await montar(t, {}, { atrasoSefazMs: 200 })
  const cert = gerarPfx({ cnpj: CNPJ_NOVO })
  ctx.clientes.cadastrarEscritorio({ cnpj: CNPJ_NOVO, razao: 'Escritório', uf: 'CE', pfx: cert.pfx, senha: cert.senha })
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/excluir`, { method: 'POST', body: {} })).status, 400)
  assert.equal((await pedir(`/api/clientes/${CNPJ_NOVO}/editar`, { method: 'POST', body: { cnpj: CNPJ_NOVO, razao: 'X', uf: 'CE' } })).status, 400)

  assert.equal((await pedir('/api/captura', { method: 'POST', body: {} })).status, 202)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/excluir`, { method: 'POST', body: {} })).status, 409)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'X', uf: 'CE' } })).status, 409)
  assert.ok(ctx.clientes.obter(CNPJ_MOCK_OK))
  await ctx.ciclo.parar()
})

test('/api/clientes traz o total de notas, para a confirmação de excluir', async (t) => {
  const { pedir, ctx } = await montar(t)
  const a = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  ctx.db.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (?, ?, 'resumo')").run(a.id, '7'.repeat(44))
  const c = (await pedir('/api/clientes')).corpo.clientes.find((x) => x.cnpj === CNPJ_MOCK_OK)
  assert.equal(c.notasTotal, 1)
})

// Notas de CT-e direto no banco: 1 entrada, 1 saída e 2 outros (um deles num mês só de Outros).
function cteNoBanco(ctx) {
  const id = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const chaves = inserirNotas(ctx.db, id, 4, { status: 'completa', inicio: 500 })
  const tipos = ['entrada', 'saida', 'outro', 'outro']
  const competencias = ['2026-10', '2026-10', '2026-10', '2026-07']
  chaves.forEach((chave, i) => ctx.db.prepare("UPDATE notas SET modelo = 'cte', tipo = ?, competencia = ?, caminho_xml = 'x.xml' WHERE chave = ?").run(tipos[i], competencias[i], chave))
  return chaves
}

test('CT-e na API: /api/clientes traz o bloco cte e a busca automática; captura aceita modelos [cte]', async (t) => {
  const { ctx, pedir } = await montar(t)
  const c = (await pedir('/api/clientes')).corpo.clientes.find((x) => x.cnpj === CNPJ_MOCK_OK)
  assert.equal(c.automatica.cte, true)
  assert.deepEqual(c.cte, { ultimoRecebido: null, ultimaConsulta: null, proximaConsulta: null, bloqueadoAte: null, ultimoErro: null })
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK], modelos: ['mdfe'] } })).status, 400)
  const r = await pedir('/api/captura', { method: 'POST', body: { cnpjs: [CNPJ_MOCK_OK], modelos: ['cte'] } })
  assert.equal(r.status, 202)
  for (let i = 0; i < 100 && (await pedir('/api/clientes')).corpo.capturandoAgora; i++) await new Promise((x) => setTimeout(x, 20))
  const depois = (await pedir('/api/clientes')).corpo.clientes.find((x) => x.cnpj === CNPJ_MOCK_OK)
  assert.ok(depois.cte.ultimaConsulta, 'o CT-e foi consultado')
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM execucoes WHERE tipo = 'captura'").get().n, 0, 'sem consulta de NF-e')
})

test('CT-e na API: filtro tipo=outro e contagemTipo com outros', async (t) => {
  const { ctx, pedir } = await montar(t)
  cteNoBanco(ctx)
  const lista = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=cte&tipo=outro`)).corpo
  assert.equal(lista.notas.length, 2)
  assert.ok(lista.notas.every((n) => n.tipo === 'outro' && n.modelo === 'cte'))
  const cont = (await pedir(`/api/notas?cnpj=${CNPJ_MOCK_OK}&modelo=cte&somenteContagem=1&status=com_xml`)).corpo
  assert.deepEqual(cont.contagemTipo, { entradas: 1, saidas: 1, outros: 2 })
  assert.equal(cont.contagemModelo.cte, 4)
  assert.equal((await pedir('/api/notas?tipo=xx')).status, 400)
})

test('CT-e na API: anos e meses contam entradas, saídas e outros', async (t) => {
  const { ctx, pedir } = await montar(t)
  assert.deepEqual((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses?modelo=cte`)).corpo, [])
  cteNoBanco(ctx)
  const anos = (await pedir(`/api/clientes/${CNPJ_MOCK_OK}/meses?modelo=cte`)).corpo
  assert.deepEqual(anos, [
    { ano: 2026, entradas: 1, saidas: 1, outros: 2, meses: [{ mes: 10, entradas: 1, saidas: 1, outros: 1 }, { mes: 7, entradas: 0, saidas: 0, outros: 1 }] },
  ])
})

// CT-e com XML real no disco: a primeira nota (entrada) ganha chave válida e o cteProc fictício.
function cteComXml(ctx) {
  const chaves = cteNoBanco(ctx)
  const { chaveCte, cteProc, TRANSP } = require('./apoio/cte')
  const chave = chaveCte(TRANSP, 7)
  ctx.db.prepare('UPDATE notas SET chave = ?, caminho_xml = ? WHERE chave = ?').run(chave, `${CNPJ_MOCK_OK}_Exemplo/CT-e/${chave}-cte.xml`, chaves[0])
  gravarXml(ctx, `${CNPJ_MOCK_OK}_Exemplo/CT-e/${chave}-cte.xml`, cteProc({ chave }))
  return { id: ctx.db.prepare('SELECT id FROM notas WHERE chave = ?').get(chave).id, chave }
}

test('CT-e: ZIP com DACTE, relatório com nome CT-e, PDF avulso e detalhe', async (t) => {
  const { ctx, pedir } = await montar(t)
  const { id, chave } = cteComXml(ctx)
  const zip = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [id], incluir: ['xml', 'dacte'] } })
  assert.equal(zip.status, 200)
  const arqs = lerZip(zip.corpo)
  assert.ok(arqs.get(`CT-e/Entradas/${chave}-cte.xml`))
  assert.equal(arqs.get(`CT-e/Entradas/${chave}-cte.pdf`).subarray(0, 5).toString(), '%PDF-')

  const rel = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [id], incluir: ['pdf'] } })
  assert.equal(rel.status, 200)
  assert.match(rel.headers.get('content-disposition'), /filename="Exemplo_2026-10_CT-e\.pdf"/)
  const xls = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [id], incluir: ['excel'] } })
  assert.match(xls.headers.get('content-disposition'), /filename="Exemplo_2026-10_CT-e\.xlsx"/)
  assert.equal((await pedir('/api/exportacoes/Exemplo_2026-10_CT-e.pdf')).status, 404, 'nome passa no padrão (404 = arquivo ausente)')

  const pdf = await pedir(`/api/notas/${id}/pdf`)
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.equal(pdf.corpo.subarray(0, 5).toString(), '%PDF-')

  const det = (await pedir(`/api/notas/${id}/detalhe`)).corpo
  assert.equal(det.nota.modelo, 'cte')
  assert.ok(det.cte.tomador.nome)
  assert.equal(det.nfe, null)
  assert.equal(det.erroXml, null)
})

test('seleção mista: planilha e relatório trazem NF-e e CT-e (sem Outros)', async (t) => {
  const { ctx, pedir } = await montar(t)
  const { id } = cteComXml(ctx)
  const cli = ctx.db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).id
  const nfe = inserirNota(ctx.db, { cliente_id: cli, chave: nota44(9001), tipo: 'entrada', status: 'completa', competencia: '2026-10' })
  const r = await pedir('/api/notas/zip', { method: 'POST', body: { ids: [id, nfe], incluir: ['excel', 'pdf'] } })
  assert.equal(r.status, 200)
  const arqs = lerZip(r.corpo)
  const wb = lerZip(arqs.get('notas.xlsx')).get('xl/workbook.xml').toString()
  assert.match(wb, /name="CT-e"/)
  assert.match(wb, /name="NF-e"/)
})

test('tela Exportar: opções, ZIP organizado e escolha recusada', async (t) => {
  const { ctx, pedir } = await montar(t)
  const clientes = ctx.db.prepare('SELECT id, apelido FROM clientes ORDER BY id').all()
  const chave = '1'.repeat(50)
  const relativo = `x/${chave}.xml`
  gravarXml(ctx, relativo, fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8'))
  ctx.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'nfse', 'entrada', 'completa', '2026-03', ?)").run(clientes[0].id, chave, relativo)

  const o = await pedir('/api/exportacao/opcoes')
  assert.equal(o.status, 200)
  assert.deepEqual(o.corpo.notas, [{ modelo: 'nfse', competencia: '2026-03', clienteId: clientes[0].id, total: 1 }])

  const r = await pedir('/api/exportacao/zip', { method: 'POST', body: { modelos: ['nfse'], competencias: ['2026-03'], clientes: [clientes[0].id], incluir: ['pdf', 'xml'] } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/zip')
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="Smart-Fiscal-Exportacao-\d{4}-\d{2}-\d{2}\.zip"/)
  const zip = lerZip(r.corpo)
  assert.deepEqual([...zip.keys()].sort(), [`Exemplo/2026/Março/NFS-e/PDF/${chave}-nfse.pdf`, `Exemplo/2026/Março/NFS-e/XML/${chave}-nfse.xml`])
  assert.equal(zip.get(`Exemplo/2026/Março/NFS-e/PDF/${chave}-nfse.pdf`).subarray(0, 5).toString(), '%PDF-')

  const invalida = await pedir('/api/exportacao/zip', { method: 'POST', body: { modelos: [], competencias: ['2026-03'], clientes: [clientes[0].id], incluir: ['pdf', 'xml'] } })
  assert.equal(invalida.status, 400)
  const vazia = await pedir('/api/exportacao/zip', { method: 'POST', body: { modelos: ['cte'], competencias: ['2026-03'], clientes: [clientes[0].id], incluir: ['pdf', 'xml'] } })
  assert.equal(vazia.status, 409)
  assert.match(vazia.corpo.erro, /Nenhuma nota/)
  const semPainel = await pedir('/api/exportacao/zip', { method: 'POST', body: {}, headers: { 'X-Painel': '0' } })
  assert.equal(semPainel.status, 403)
})

// Motor do SPED de mentira: guarda o que recebeu em /api/pasta.
async function motorFalso(t, responder = () => ({ pasta_saida: 'x', movidos: 2 })) {
  const pedidos = []
  const servidor = http.createServer((req, res) => {
    let corpo = ''
    req.on('data', (b) => (corpo += b))
    req.on('end', () => {
      const dados = JSON.parse(corpo)
      pedidos.push({ rota: req.url, token: req.headers['x-estoque-token'], dados })
      const r = responder(dados)
      res.writeHead(r.erro ? 400 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r))
    })
  }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  t.after(() => new Promise((r) => servidor.close(r)))
  return { pedidos, motor: { porta: servidor.address().port, token: 'tk' } }
}

async function appComPastas(t, ctx, opcoes) {
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  const pastaPainel = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-painel-'))
  fs.writeFileSync(path.join(pastaPainel, 'index.html'), '<!doctype html>')
  const servidor = criarApp({ ctx, agendador, pastaPainel, ...opcoes }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  t.after(() => new Promise((r) => servidor.close(r)).then(() => fs.rmSync(pastaPainel, { recursive: true, force: true })))
  return (caminho, body) => fetch(`http://127.0.0.1:${servidor.address().port}${caminho}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Painel': '1' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, corpo: await r.json() }))
}

const novaBase = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-principal-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}
const MARCA = '.smart-fiscal'

// Nota completa com o XML gravado, como a captura deixa.
function notaComXml(ctx, chave, rel = path.join('Exemplo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', `${chave}-nfe.xml`)) {
  const cliente = ctx.db.prepare('SELECT * FROM clientes LIMIT 1').get()
  gravarXml(ctx, rel, `<${chave}/>`)
  const id = ctx.db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, ?, 'completa', '2026-10', ?)").run(cliente.id, chave, rel).lastInsertRowid
  return { id, rel }
}

test('pasta principal: pasta vazia é aceita, as empresas ficam direto nela e ganha a marca', async (t) => {
  const { ctx, pedir } = await montar(t)
  const { id, rel } = notaComXml(ctx, 'a')
  const base = novaBase(t)
  const post = await appComPastas(t, ctx, {})

  assert.equal(ctx.pastas.temPasta(), false)
  assert.equal((await pedir('/api/pastas')).corpo.principal, null)
  assert.equal((await post('/api/pastas/principal', { pasta: 'relativa' })).status, 400)

  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.equal(r.corpo.estado.principal, base)
  assert.equal(ctx.config.pastaXmls, base, 'sem SMART FISCAL nem Notas')
  assert.ok(fs.existsSync(path.join(base, MARCA)))
  assert.ok(fs.existsSync(path.join(base, rel)))
  assert.ok(!fs.existsSync(path.join(base, 'SMART FISCAL')))
  assert.match(r.corpo.mensagem, /^Pasta principal: .*\. 1 arquivo levado\.$/)
  assert.equal(ctx.pastas.temPasta(), true)
  assert.equal((await pedir(`/api/notas/${id}/xml`)).status, 200)

  // Escolher a mesma pasta outra vez não copia nada.
  const mesma = await post('/api/pastas/principal', { pasta: base })
  assert.equal(mesma.status, 200)
  assert.match(mesma.corpo.mensagem, /0 arquivos levados/)
})

test('pasta principal: pasta com outros arquivos e sem marca é recusada e nada é copiado', async (t) => {
  const { ctx } = await montar(t)
  const { rel } = notaComXml(ctx, 'a')
  const base = novaBase(t)
  fs.writeFileSync(path.join(base, 'de-alguem.xml'), 'x')
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 400)
  assert.match(r.corpo.erro, /não está vazia/)
  assert.equal(fs.existsSync(path.join(base, MARCA)), false)
  assert.deepEqual(fs.readdirSync(base), ['de-alguem.xml'])
  assert.ok(fs.existsSync(path.join(ctx.config.pastaXmls, rel)), 'continua na pasta antiga')
  // O caminho genérico passa pela mesma validação.
  const generico = await post('/api/pastas', { tipo: 'xmls', pasta: base })
  assert.equal(generico.status, 400)
  assert.match(generico.corpo.erro, /não está vazia/)
})

test('pasta principal: com EEXIST, origem diferente fica e igual sai; o destino nunca é sobrescrito', async (t) => {
  const { ctx } = await montar(t)
  const diferente = notaComXml(ctx, 'a').rel
  const igual = notaComXml(ctx, 'b').rel
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  fs.writeFileSync(path.join(base, MARCA), '')
  fs.mkdirSync(path.join(base, path.dirname(diferente)), { recursive: true })
  fs.writeFileSync(path.join(base, diferente), 'ja-estava')
  fs.writeFileSync(path.join(base, igual), '<b/>')
  fs.writeFileSync(path.join(base, 'outro.txt'), 'fica')
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.equal(fs.readFileSync(path.join(base, diferente), 'utf8'), 'ja-estava', 'destino não é sobrescrito')
  assert.equal(fs.readFileSync(path.join(antiga, diferente), 'utf8'), '<a/>', 'origem diferente fica')
  assert.ok(!fs.existsSync(path.join(antiga, igual)), 'origem idêntica ao destino sai')
  assert.equal(fs.readFileSync(path.join(base, igual), 'utf8'), '<b/>')
  assert.equal(fs.readFileSync(path.join(base, 'outro.txt'), 'utf8'), 'fica')
  assert.match(r.corpo.mensagem, /1 arquivo levado/)
})

test('pasta principal: sobra truncada no destino não faz apagar a origem, nem ao repetir a troca', async (t) => {
  const { ctx } = await montar(t)
  const { rel } = notaComXml(ctx, 'a')
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  fs.writeFileSync(path.join(base, MARCA), '')
  fs.mkdirSync(path.join(base, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(base, rel), '<a') // cópia cortada de uma tentativa antiga
  const post = await appComPastas(t, ctx, {})
  for (let i = 0; i < 2; i++) {
    assert.equal((await post('/api/pastas/principal', { pasta: base })).status, 200)
    assert.equal(fs.readFileSync(path.join(antiga, rel), 'utf8'), '<a/>')
    assert.equal(fs.readFileSync(path.join(base, rel), 'utf8'), '<a')
  }
})

test('pasta principal: falha no meio da cópia deixa banco, config e origem intactos e limpa o que criou', async (t) => {
  const { ctx } = await montar(t)
  const a = notaComXml(ctx, 'a').rel
  const b = notaComXml(ctx, 'b').rel
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  const original = fsp.copyFile
  let chamadas = 0
  t.mock.method(fsp, 'copyFile', async (...args) => {
    if (++chamadas === 2) throw Object.assign(new Error('falhou'), { code: 'ENOSPC' })
    return original(...args)
  })
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 400)
  assert.match(r.corpo.erro, /Nada mudou/)
  assert.equal(chamadas, 2)
  const valor = (chave) => ctx.db.prepare('SELECT valor FROM sistema WHERE chave = ?').get(chave)?.valor
  assert.equal(valor('pasta_xmls'), undefined)
  assert.equal(valor('pasta_principal'), undefined)
  assert.equal(ctx.config.pastaXmls, antiga)
  for (const rel of [a, b]) assert.ok(fs.existsSync(path.join(antiga, rel)))
  assert.deepEqual(fs.readdirSync(base, { recursive: true, withFileTypes: true }).filter((i) => i.isFile()).map((i) => i.name), [MARCA], 'só a marca; sem .tmp nem cópias')
  // Repetir a troca continua de onde parou.
  t.mock.restoreAll()
  assert.equal((await post('/api/pastas/principal', { pasta: base })).status, 200)
  for (const rel of [a, b]) assert.ok(fs.existsSync(path.join(base, rel)))
  assert.equal(valor('pasta_principal'), base)
})

test('pasta principal: nenhuma captura começa durante a troca (409)', async (t) => {
  const { ctx } = await montar(t)
  notaComXml(ctx, 'a')
  const base = novaBase(t)
  const original = fsp.copyFile
  let soltar
  const portao = new Promise((r) => (soltar = r))
  let dentro
  const entrou = new Promise((r) => (dentro = r))
  t.mock.method(fsp, 'copyFile', async (...args) => {
    dentro()
    await portao
    return original(...args)
  })
  const post = await appComPastas(t, ctx, {})
  const troca = post('/api/pastas/principal', { pasta: base })
  await entrou
  assert.equal(ctx.pastas.movendoAgora(), true)
  assert.equal((await post('/api/captura', {})).status, 409)
  soltar()
  assert.equal((await troca).status, 200)
  assert.equal(ctx.pastas.movendoAgora(), false)
})

test('exigirPasta sem pasta: captura responde 409 e resumo traz pastaPendente', async (t) => {
  const { ctx, pedir } = await montar(t)
  const post = await appComPastas(t, ctx, { exigirPasta: true })
  const C = CNPJ_MOCK_OK
  for (const corpo of [{ cnpjs: [C], modelos: ['nfe'] }, { cnpj: C }, {}]) {
    const r = await post('/api/captura', corpo)
    assert.equal(r.status, 409, JSON.stringify(corpo))
    assert.match(r.corpo.erro, /Escolha a pasta principal na tela Pastas antes de capturar\./)
  }
  assert.ok(!ctx.ciclo.cicloEmAndamento())
  // O painel de teste padrão (sem exigirPasta) não traz a pendência.
  assert.equal((await pedir('/api/resumo')).corpo.pastaPendente, false)
})

test('exigirPasta: resumo traz pastaPendente verdadeiro sem pasta', async (t) => {
  const { ctx } = await montar(t)
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  const pastaPainel = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-painel-'))
  fs.writeFileSync(path.join(pastaPainel, 'index.html'), '<!doctype html>')
  const servidor = criarApp({ ctx, agendador, pastaPainel, exigirPasta: true }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  t.after(() => new Promise((r) => servidor.close(r)).then(() => fs.rmSync(pastaPainel, { recursive: true, force: true })))
  const resumo = () => fetch(`http://127.0.0.1:${servidor.address().port}/api/resumo`).then((r) => r.json())
  assert.equal((await resumo()).pastaPendente, true)
  await ctx.pastas.mudarPrincipal(novaBase(t))
  assert.equal((await resumo()).pastaPendente, false)
})

test('exigirPasta com pasta: captura segue', async (t) => {
  const { ctx } = await montar(t)
  await ctx.pastas.mudarPrincipal(novaBase(t))
  const post = await appComPastas(t, ctx, { exigirPasta: true })
  const r = await post('/api/captura', { cnpjs: [CNPJ_MOCK_OK], modelos: ['nfe'] })
  assert.equal(r.status, 202, JSON.stringify(r.corpo))
  const r2 = await post('/api/captura', { cnpj: CNPJ_MOCK_OK })
  assert.ok([202, 409].includes(r2.status))
  await ctx.ciclo.parar()
})

test('sem exigirPasta (terminal e testes): captura sem pasta escolhida segue como antes', async (t) => {
  const { ctx, pedir } = await montar(t)
  assert.equal(ctx.pastas.temPasta(), false)
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/captura', { cnpjs: [CNPJ_MOCK_OK], modelos: ['nfe'] })
  assert.equal(r.status, 202, JSON.stringify(r.corpo))
  assert.equal((await pedir('/api/resumo')).corpo.pastaPendente, false)
  await ctx.ciclo.parar()
})

test('pasta principal: duas trocas simultâneas, a segunda é recusada antes de qualquer espera', async (t) => {
  const { ctx } = await montar(t)
  notaComXml(ctx, 'a')
  const a = novaBase(t)
  const b = novaBase(t)
  const primeira = ctx.pastas.mudarPrincipal(a)
  assert.equal(ctx.pastas.movendoAgora(), true, 'marcado de forma síncrona, antes do primeiro await')
  await assert.rejects(ctx.pastas.mudarPrincipal(b), /A pasta já está sendo trocada\./)
  assert.equal((await primeira).mudou, true)
  assert.equal(ctx.pastas.movendoAgora(), false)
  assert.equal(ctx.config.pastaXmls, a)
  assert.deepEqual(fs.readdirSync(b), [], 'a segunda não tocou na pasta')
})

test('pasta principal: troca recusada por validação não deixa a marca de movendo presa', async (t) => {
  const { ctx } = await montar(t)
  await assert.rejects(ctx.pastas.mudarPrincipal('relativa'), /endereço completo/)
  assert.equal(ctx.pastas.movendoAgora(), false)
})

test('pasta principal: sem pasta_principal, escolher a pasta atual a adota com a marca', async (t) => {
  const { ctx } = await montar(t)
  const atual = novaBase(t)
  ctx.config.pastaXmls = atual
  const post = await appComPastas(t, ctx, {})
  assert.equal(ctx.pastas.temPasta(), false)
  const r = await post('/api/pastas/principal', { pasta: atual })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.ok(fs.existsSync(path.join(atual, MARCA)))
  assert.equal(r.corpo.estado.principal, atual)
  assert.match(r.corpo.mensagem, /0 arquivos levados/)
  assert.equal(ctx.pastas.temPasta(), true)
  // Agora que já é a principal, escolher de novo não faz nada.
  assert.equal((await ctx.pastas.mudarPrincipal(atual)).mudou, false)

  // Pasta atual com outras coisas e sem marca continua recusada.
  const outra = novaBase(t)
  fs.writeFileSync(path.join(outra, 'de-alguem.txt'), 'x')
  ctx.db.prepare("DELETE FROM sistema WHERE chave = 'pasta_principal'").run()
  ctx.config.pastaXmls = outra
  assert.equal((await post('/api/pastas/principal', { pasta: outra })).status, 400)
})

test('pasta principal: valor vazio é recusado, não há volta para a pasta padrão', async (t) => {
  const { ctx } = await montar(t)
  const base = novaBase(t)
  const post = await appComPastas(t, ctx, {})
  await post('/api/pastas/principal', { pasta: base })
  for (const [rota, corpo] of [['/api/pastas/principal', { pasta: '' }], ['/api/pastas', { tipo: 'xmls', pasta: '' }]]) {
    const r = await post(rota, corpo)
    assert.equal(r.status, 400)
    assert.match(r.corpo.erro, /Escolha a pasta/)
  }
  assert.equal(ctx.config.pastaXmls, base)
})

test('pasta principal: na pasta antiga sem marca só sai o que foi copiado', async (t) => {
  const { ctx } = await montar(t)
  const { rel } = notaComXml(ctx, 'a')
  const antiga = ctx.config.pastaXmls
  gravarXml(ctx, path.join('Exemplo', 'sem-registro.xml'), '<s/>')
  gravarXml(ctx, path.join('Exemplo', 'de-alguem.xml'), '<d/>')
  fs.mkdirSync(path.join(antiga, 'PastaAlheia'), { recursive: true })
  const base = novaBase(t)
  const post = await appComPastas(t, ctx, {})
  assert.equal((await post('/api/pastas/principal', { pasta: base })).status, 200)
  assert.ok(fs.existsSync(path.join(base, rel)))
  assert.ok(!fs.existsSync(path.join(antiga, rel)), 'o copiado sai da antiga')
  assert.ok(fs.existsSync(path.join(antiga, 'Exemplo', 'sem-registro.xml')), 'xml sem registro fica')
  assert.ok(!fs.existsSync(path.join(base, 'Exemplo', 'sem-registro.xml')))
  assert.ok(fs.existsSync(path.join(antiga, 'Exemplo', 'de-alguem.xml')), 'de-alguem.xml fica na antiga')
  assert.ok(!fs.existsSync(path.join(base, 'Exemplo', 'de-alguem.xml')))
  assert.ok(fs.existsSync(path.join(antiga, 'PastaAlheia')), 'pasta vazia alheia fica')
  assert.ok(!fs.existsSync(path.join(antiga, 'Exemplo', '2026')), 'só as pastas de onde saiu viram vazias e somem')
})

test('pasta principal: resumo em Resumos é levado de uma origem sem marca', async (t) => {
  const { ctx } = await montar(t)
  const rel = path.join('Exemplo', '2026', '10-Outubro', 'NF-e', 'Eventos e Resumos', '12345678901234567890-resumo.xml')
  gravarXml(ctx, rel, '<r/>')
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.match(r.corpo.mensagem, /1 arquivo levado/)
  assert.equal(fs.readFileSync(path.join(base, rel), 'utf8'), '<r/>')
  assert.ok(!fs.existsSync(path.join(antiga, rel)))
})

test('pasta principal: com marca leva xml, pdf, xlsx e zip; sem marca, só os xml do banco', async (t) => {
  const { ctx } = await montar(t)
  const post = await appComPastas(t, ctx, {})
  const a = novaBase(t)
  const b = novaBase(t)
  await ctx.organizador.parar() // a geração em segundo plano não mexe nas contagens desta troca
  const { rel } = notaComXml(ctx, 'a')
  assert.equal((await post('/api/pastas/principal', { pasta: a })).status, 200)
  const dir = path.join(a, path.dirname(rel))
  for (const nome of ['x.pdf', 'y.xlsx', 'z.zip', 'w.xml.tmp', 'leia.txt']) fs.writeFileSync(path.join(dir, nome), nome)
  const r = await post('/api/pastas/principal', { pasta: b })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.match(r.corpo.mensagem, /4 arquivos levados/)
  for (const nome of ['x.pdf', 'y.xlsx', 'z.zip', path.basename(rel)]) assert.ok(fs.existsSync(path.join(b, path.dirname(rel), nome)), nome)
  assert.ok(!fs.existsSync(path.join(b, path.dirname(rel), 'w.xml.tmp')))
  assert.ok(!fs.existsSync(path.join(b, path.dirname(rel), 'leia.txt')))
  assert.ok(fs.existsSync(path.join(dir, 'leia.txt')) && fs.existsSync(path.join(dir, 'w.xml.tmp')), 'o que não é do app fica')
})

test('pasta principal: o SPED não é levado ao trocar de pasta', async (t) => {
  const { ctx } = await montar(t)
  const { pedidos, motor } = await motorFalso(t)
  const base = novaBase(t)
  const post = await appComPastas(t, ctx, { estoque: () => motor })
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 200)
  assert.equal(pedidos.length, 0)
  assert.equal(r.corpo.erroSped, undefined)
})

test('pasta principal: origem indisponível com notas registradas recusa a troca; sem nada registrado, troca', async (t) => {
  const { ctx } = await montar(t)
  const post = await appComPastas(t, ctx, {})
  const a = novaBase(t)
  const b = novaBase(t)
  assert.equal((await post('/api/pastas/principal', { pasta: a })).status, 200)
  notaComXml(ctx, 'a')
  fs.rmSync(a, { recursive: true, force: true })
  const r = await post('/api/pastas/principal', { pasta: b })
  assert.equal(r.status, 400)
  assert.match(r.corpo.erro, /nada foi mudado/)
  assert.equal(ctx.config.pastaXmls, a)
  assert.deepEqual(fs.readdirSync(b), [])
  ctx.db.prepare('DELETE FROM notas').run()
  assert.equal((await post('/api/pastas/principal', { pasta: b })).status, 200)
  assert.equal(ctx.config.pastaXmls, b)
})

test('pasta principal: falha na cópia volta para a pasta antiga e não perde nada', async (t) => {
  const { ctx } = await montar(t)
  const { rel } = notaComXml(ctx, 'a')
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  t.mock.method(fsp, 'copyFile', async () => {
    throw Object.assign(new Error('falhou'), { code: 'EIO' })
  })
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 400)
  assert.match(r.corpo.erro, /Nada mudou/)
  assert.equal(ctx.config.pastaXmls, antiga)
  assert.ok(fs.existsSync(path.join(antiga, rel)))
  assert.equal(ctx.pastas.temPasta(), false)
})

test('pasta principal: a antiga …\\SMART FISCAL conta como pasta e a troca usa a regra sem marca', async (t) => {
  const { ctx } = await montar(t)
  const base = novaBase(t)
  ctx.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_principal', ?)").run(path.join(base, 'SMART FISCAL'))
  assert.equal(ctx.pastas.temPasta(), true)
  const nova = novaBase(t)
  const post = await appComPastas(t, ctx, {})
  assert.equal((await post('/api/pastas/principal', { pasta: nova })).status, 200)
  assert.equal(ctx.pastas.estado().principal, nova)
})

test('pasta principal: janela de escolher pasta só no app; fora do próprio PC é recusado', async (t) => {
  const { ctx } = await montar(t)
  const semJanela = await appComPastas(t, ctx, {})
  assert.deepEqual((await semJanela('/api/pastas/escolher')).corpo, { indisponivel: true })
  const comJanela = await appComPastas(t, ctx, { escolherPasta: async () => 'D:\\Contabilidade' })
  assert.deepEqual((await comJanela('/api/pastas/escolher')).corpo, { pasta: 'D:\\Contabilidade' })
  const cancelou = await appComPastas(t, ctx, { escolherPasta: async () => null })
  assert.deepEqual((await cancelou('/api/pastas/escolher')).corpo, { pasta: null })
  const deFora = await appComPastas(t, ctx, { ehLocal: () => false, escolherPasta: async () => 'x' })
  assert.equal((await deFora('/api/pastas/escolher')).status, 403)
  assert.equal((await deFora('/api/pastas/principal', { pasta: 'x' })).status, 403)
})

test('trocar a pasta dos XMLs vale na hora para a gravação, sem reiniciar', async (t) => {
  const { ctx } = await montar(t)
  const { criarArmazenamento } = require('../src/services/armazenamento')
  const arm = criarArmazenamento({ config: ctx.config, db: ctx.db })
  const nova = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-nova-'))
  t.after(() => fs.rmSync(nova, { recursive: true, force: true }))
  await ctx.pastas.mudar('xmls', nova)
  const rel = arm.salvar({ cliente: { cnpj: '11222333000181', apelido: 'Teste' }, competencia: '2026-10', nomeArquivo: 'a.xml', xml: '<a/>' })
  assert.ok(fs.existsSync(path.join(nova, rel)))
  assert.equal(arm.absoluto(rel), path.join(nova, rel))
})

test('cliente sem certificado: cadastra, aparece na lista, fica fora da captura e pode ganhar o certificado depois', async (t) => {
  const { ctx, pedir } = await montar(t)
  const cnpj = '27865757000102'
  const dados = { cnpj, razao: 'Sem Certificado Ltda', uf: 'CE', apelido: 'Sem Cert' }

  assert.equal((await pedir('/api/clientes', { method: 'POST', body: dados })).status, 400, 'sem a opção, o certificado continua obrigatório')

  const r = await pedir('/api/clientes', { method: 'POST', body: { ...dados, semCertificado: true } })
  assert.equal(r.status, 201, JSON.stringify(r.corpo))
  assert.equal(r.corpo.semCertificado, true)
  assert.equal(r.corpo.validade, null)
  assert.ok(!fs.existsSync(path.join(ctx.config.pastaCerts, `${cnpj}.pfx`)))

  const lista = () => pedir('/api/clientes').then((x) => x.corpo.clientes)
  const achar = async () => (await lista()).find((c) => c.cnpj === cnpj)
  assert.equal((await achar()).temCertificado, false)
  assert.equal((await achar()).certDias, null)
  assert.equal((await achar()).ativo, true, 'nasce ativo: a captura já o pula por não ter certificado')
  assert.equal((await pedir(`/api/clientes/${cnpj}/ativo`, { method: 'POST', body: { ativo: false } })).status, 200)
  assert.equal((await pedir(`/api/clientes/${cnpj}/ativo`, { method: 'POST', body: { ativo: true } })).status, 200)
  assert.equal((await lista()).find((c) => c.cnpj !== cnpj).temCertificado, true)

  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [cnpj] } })).status, 400, 'não dá para capturar sem certificado')
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj } })).status, 400)

  const repetido = await pedir('/api/clientes', { method: 'POST', body: { ...dados, semCertificado: true } })
  assert.equal(repetido.status, 409)

  const cert = gerarPfx({ cnpj })
  const troca = await pedir(`/api/clientes/${cnpj}/certificado`, { method: 'POST', body: { pfx: cert.pfx.toString('base64'), senha: cert.senha } })
  assert.equal(troca.status, 200, JSON.stringify(troca.corpo))
  assert.equal((await achar()).temCertificado, true)
  assert.equal((await achar()).ativo, true, 'com o certificado, continua ativo')
  assert.ok((await achar()).certValidade)
  assert.ok(fs.existsSync(path.join(ctx.config.pastaCerts, `${cnpj}.pfx`)))
})

test('cliente que é o escritório: a tela Escritório transforma; com captura rodando, recusa', async (t) => {
  const { ctx, pedir } = await montar(t)
  const cnpj = '27865757000102'
  const cert = gerarPfx({ cnpj })
  ctx.clientes.cadastrar({ cnpj, razao: 'Escritório Ltda', uf: 'CE', apelido: 'Meu escritório', pfx: cert.pfx, senha: cert.senha })
  const corpo = { cnpj, razao: 'Escritório Ltda', uf: 'CE', pfx: cert.pfx.toString('base64'), senha: cert.senha }

  const emCaptura = t.mock.method(ctx.ciclo, 'cicloEmAndamento', () => true)
  const recusado = await pedir('/api/escritorio', { method: 'POST', body: corpo })
  assert.equal(recusado.status, 409)
  assert.equal(ctx.clientes.obterEscritorio(), null)
  emCaptura.mock.restore()

  const r = await pedir('/api/escritorio', { method: 'POST', body: corpo })
  assert.equal(r.status, 201, JSON.stringify(r.corpo))
  const linha = ctx.db.prepare('SELECT papel, tambem_cliente FROM clientes WHERE cnpj = ?').get(cnpj)
  assert.deepEqual({ ...linha }, { papel: 'escritorio', tambem_cliente: 1 })
})

test('tela Escritório: ao virar escritório, a nota de terceiro vai para o emitente como saída', async (t) => {
  const { ctx, pedir } = await montar(t)
  const cnpj = '27865757000102'
  const cert = gerarPfx({ cnpj })
  const { cliente: esc } = ctx.clientes.cadastrar({ cnpj, razao: 'Escritório Ltda', uf: 'CE', apelido: 'Meu escritório', pfx: cert.pfx, senha: cert.senha })
  const emitente = CNPJ_MOCK_OK
  const chave = `232610${emitente}55001000000001100000001`.padEnd(44, '0')
  const rel = path.join('Meu escritório', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', `${chave}-nfe.xml`)
  gravarXml(ctx, rel, `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${chave}"><ide><nNF>1</nNF><serie>1</serie><dhEmi>2026-10-05T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${emitente}</CNPJ><xNome>E</xNome></emit><dest><CPF>12345678909</CPF><xNome>D</xNome></dest><total><ICMSTot><vNF>1.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`)
  ctx.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'entrada', 'completa', '2026-10', ?)").run(esc.id, chave, rel)
  ctx.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', '11') ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run()

  const r = await pedir('/api/escritorio', { method: 'POST', body: { cnpj, razao: 'Escritório Ltda', uf: 'CE', pfx: cert.pfx.toString('base64'), senha: cert.senha } })
  assert.equal(r.status, 201, JSON.stringify(r.corpo))

  const nota = ctx.db.prepare('SELECT n.tipo, c.cnpj FROM notas n JOIN clientes c ON c.id = n.cliente_id WHERE n.chave = ?').all(chave)
  assert.deepEqual(nota.map((n) => ({ ...n })), [{ tipo: 'saida', cnpj: emitente }])
})

test('escritório cadastrado como cliente sem enviar certificado mantém o que já tem', async (t) => {
  const { ctx, pedir } = await montar(t)
  const cnpj = '27865757000102'
  const cert = gerarPfx({ cnpj })
  ctx.clientes.cadastrarEscritorio({ cnpj, razao: 'Escritório Ltda', uf: 'CE', pfx: cert.pfx, senha: cert.senha })
  const r = await pedir('/api/clientes', { method: 'POST', body: { cnpj, razao: 'Escritório Ltda', uf: 'CE', semCertificado: true } })
  assert.equal(r.status, 201, JSON.stringify(r.corpo))
  const linha = ctx.db.prepare('SELECT tambem_cliente, cert_arquivo FROM clientes WHERE cnpj = ?').get(cnpj)
  assert.equal(linha.tambem_cliente, 1)
  assert.equal(linha.cert_arquivo, `${cnpj}.pfx`)
})

test('cadastro sem certificado fora do próprio PC é recusado', async (t) => {
  const { ctx } = await montar(t)
  const post = await appComPastas(t, ctx, { ehLocal: () => false })
  assert.equal((await post('/api/clientes', { cnpj: '27865757000102', razao: 'X', uf: 'CE', semCertificado: true })).status, 403)
})

test('GET /api/pastas traz a organização da pasta', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/api/pastas')
  assert.deepEqual(r.corpo.organizacao, { situacao: 'parada', feitos: 0, total: 0, atual: null, falhas: 0, ultimoErro: null })
})

test('editar nome pausa a geração, move a pasta e os nomes são refeitos; excluir remove as linhas de pasta_grupos e mantém os arquivos', async (t) => {
  const { pedir, ctx } = await montar(t)
  const { db, config } = ctx
  const pausas = []
  const real = ctx.organizador.pausarDurante
  ctx.organizador.pausarDurante = (fn) => (pausas.push(1), real(fn))
  const cliente = db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK)
  const relativo = path.join('Exemplo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'a.xml')
  fs.mkdirSync(path.join(config.pastaXmls, path.dirname(relativo)), { recursive: true })
  fs.writeFileSync(path.join(config.pastaXmls, relativo), '<x/>')
  db.prepare("INSERT INTO notas (cliente_id, chave, modelo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'completa', '2026-10', ?)").run(cliente.id, '3'.repeat(44), relativo)
  // Pasta principal escolhida: a geração roda.
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_principal', ?)").run(config.pastaXmls)
  ctx.organizador.agendar()
  await ctx.organizador.aguardar()
  const grupo = (nome) => path.join(config.pastaXmls, nome, '2026', '10-Outubro', 'NF-e', 'Entradas')
  assert.ok(fs.existsSync(path.join(grupo('Exemplo'), 'Exemplo NF-e Entradas Outubro 2026.zip')))

  const r = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'Comercial Exemplo Ltda', uf: 'CE', apelido: 'Nome Novo' } })
  assert.equal(r.status, 200)
  assert.equal(pausas.length, 1)
  assert.ok(fs.existsSync(path.join(config.pastaXmls, 'Nome Novo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'a.xml')))
  await ctx.organizador.aguardar()
  const nomes = fs.readdirSync(grupo('Nome Novo'))
  assert.ok(nomes.includes('Nome Novo NF-e Entradas Outubro 2026.zip'), nomes.join())
  assert.ok(nomes.includes('Relatorio NF-e Entradas Outubro 2026.xlsx'))
  assert.ok(!nomes.includes('Exemplo NF-e Entradas Outubro 2026.zip'))

  const ex = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/excluir`, { method: 'POST', body: {} })
  assert.equal(ex.status, 200)
  assert.equal(pausas.length, 2)
  assert.equal(db.prepare('SELECT COUNT(*) FROM pasta_grupos WHERE cliente_id = ?').pluck().get(cliente.id), 0)
  assert.ok(fs.existsSync(path.join(config.pastaXmls, 'Nome Novo', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'a.xml')))
})

test('captura que começa durante a espera da pausa: editar, excluir e trocar de pasta respondem 409', async (t) => {
  const { pedir, ctx } = await montar(t)
  const post = await appComPastas(t, ctx, {})
  const real = ctx.organizador.pausarDurante
  // Simula a captura que começa enquanto a geração ainda está parando.
  ctx.organizador.pausarDurante = (fn) => real(() => ((ctx.ciclo.cicloEmAndamento = () => 'em andamento'), fn()))
  const antes = ctx.db.prepare('SELECT apelido FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).apelido
  const e = await pedir(`/api/clientes/${CNPJ_MOCK_OK}/editar`, { method: 'POST', body: { cnpj: CNPJ_MOCK_OK, razao: 'X Ltda', uf: 'CE', apelido: 'Outro' } })
  assert.equal(e.status, 409)
  assert.equal(ctx.db.prepare('SELECT apelido FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK).apelido, antes)
  assert.equal((await pedir(`/api/clientes/${CNPJ_MOCK_OK}/excluir`, { method: 'POST', body: {} })).status, 409)
  assert.ok(ctx.db.prepare('SELECT 1 FROM clientes WHERE cnpj = ?').get(CNPJ_MOCK_OK))
  const base = novaBase(t)
  assert.equal((await post('/api/pastas/principal', { pasta: base })).status, 409)
  assert.equal((await post('/api/pastas', { tipo: 'xmls', pasta: base })).status, 409)
  assert.equal(ctx.pastas.temPasta(), false)
})

test('contexto sem servidor: o fim do ciclo não dispara a geração', async (t) => {
  const { ctx } = await montar(t)
  let agendou = 0
  ctx.organizador.agendar = () => agendou++
  await ctx.ciclo.executarCiclo({ cnpj: CNPJ_MOCK_OK })
  assert.equal(agendou, 0)
})

test('trocar para outra pasta, com origem sem marca: a pasta nova ganha relatórios e ZIP', async (t) => {
  const { ctx } = await montar(t)
  const post = await appComPastas(t, ctx, {})
  const { rel } = notaComXml(ctx, 'a')
  const grupos = criarGrupos({ db: ctx.db })
  grupos.pendentes().forEach((g) => grupos.marcarPronto(g))
  const b = novaBase(t)
  assert.equal((await post('/api/pastas/principal', { pasta: b })).status, 200)
  await ctx.organizador.aguardar()
  const dir = path.join(b, 'Exemplo', '2026', '10-Outubro', 'NF-e', 'Entradas')
  const nomes = fs.readdirSync(dir)
  assert.ok(nomes.includes('Relatorio NF-e Entradas Outubro 2026.xlsx'), nomes.join())
  assert.ok(nomes.includes('Relatorio NF-e Entradas Outubro 2026.pdf'))
  assert.ok(nomes.includes('Exemplo NF-e Entradas Outubro 2026.zip'))
  assert.ok(fs.existsSync(path.join(b, rel)))
})

test('I5: a rota inclui os avisos na mensagem e confere os arquivos depois da troca', async (t) => {
  const { ctx } = await montar(t)
  const presa = notaComXml(ctx, 'a').rel
  const antiga = ctx.config.pastaXmls
  const base = novaBase(t)
  const original = fsp.rm
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (arquivo === path.join(antiga, presa)) throw Object.assign(new Error('preso'), { code: 'EBUSY' })
    return original(arquivo, ...resto)
  })
  const pedidos = []
  const agendar = ctx.organizador.agendar
  ctx.organizador.agendar = (o) => (pedidos.push(o), agendar(o))
  const post = await appComPastas(t, ctx, {})
  const r = await post('/api/pastas/principal', { pasta: base })
  assert.equal(r.status, 200, JSON.stringify(r.corpo))
  assert.match(r.corpo.mensagem, /1 arquivo levado\. 1 arquivo não saiu da pasta antiga\. Pode apagá-lo depois\.$/)
  assert.ok(pedidos.some((o) => o?.conferirArquivos))
  await ctx.organizador.aguardar()
})

test('I5: agendar({ conferirArquivos }) roda também quando a troca falha', async (t) => {
  const { ctx } = await montar(t)
  const pedidos = []
  const agendar = ctx.organizador.agendar
  ctx.organizador.agendar = (o) => (pedidos.push(o), agendar(o))
  const post = await appComPastas(t, ctx, {})
  assert.equal((await post('/api/pastas/principal', { pasta: 'relativa' })).status, 400)
  assert.ok(pedidos.some((o) => o?.conferirArquivos))
  await ctx.organizador.aguardar()
})

test('M16: clique duplo na troca responde "A pasta já está sendo trocada."', async (t) => {
  const { ctx } = await montar(t)
  notaComXml(ctx, 'a')
  const base = novaBase(t)
  const original = fsp.copyFile
  let soltar
  const portao = new Promise((r) => (soltar = r))
  let dentro
  const entrou = new Promise((r) => (dentro = r))
  t.mock.method(fsp, 'copyFile', async (...args) => {
    dentro()
    await portao
    return original(...args)
  })
  const post = await appComPastas(t, ctx, {})
  const troca = post('/api/pastas/principal', { pasta: base })
  await entrou
  for (const [rota, corpo] of [['/api/pastas/principal', { pasta: base }], ['/api/pastas', { tipo: 'xmls', pasta: base }]]) {
    const r = await post(rota, corpo)
    assert.equal(r.status, 409)
    assert.equal(r.corpo.erro, 'A pasta já está sendo trocada.')
  }
  soltar()
  assert.equal((await troca).status, 200)
})

test('I7: GET /api/pastas responde o andamento durante a troca sem olhar o disco', async (t) => {
  const { ctx, pedir } = await montar(t)
  notaComXml(ctx, 'a')
  notaComXml(ctx, 'b')
  const base = novaBase(t)
  const original = fsp.copyFile
  let soltar
  const portao = new Promise((r) => (soltar = r))
  let dentro
  const entrou = new Promise((r) => (dentro = r))
  let n = 0
  t.mock.method(fsp, 'copyFile', async (...args) => {
    if (++n === 2) {
      dentro()
      await portao
    }
    return original(...args)
  })
  const post = await appComPastas(t, ctx, {})
  const troca = post('/api/pastas/principal', { pasta: base })
  await entrou
  const leituras = []
  for (const nome of ['readdirSync', 'statSync']) t.mock.method(fs, nome, (...a) => leituras.push([nome, a[0]]) && [])
  const lidoAntes = fsp.readdir
  t.mock.method(fsp, 'readdir', (...a) => (leituras.push(['readdir', a[0]]), lidoAntes(...a)))
  const r = await pedir('/api/pastas')
  const lidas = [...leituras]
  t.mock.restoreAll()
  assert.deepEqual(r.corpo.movendo, { tipo: 'xmls', feitos: 1, total: 2, fase: 'copiando' })
  assert.deepEqual(lidas.filter(([, p]) => String(p).startsWith(base) || String(p).startsWith(ctx.config.pastaXmls)), [])
  soltar()
  assert.equal((await troca).status, 200)
})

test('M3: abrir com a pasta fora do ar responde com mensagem clara e não recria a pasta', async (t) => {
  const { ctx, pedir } = await montar(t)
  const fora = path.join(novaBase(t), 'sumiu')
  ctx.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_principal', ?)").run(fora)
  for (const tipo of ['principal', 'xmls']) {
    if (tipo === 'xmls') ctx.config.pastaXmls = fora
    const r = await pedir('/api/pastas/abrir', { method: 'POST', body: { tipo } })
    assert.equal(r.status, 409)
    assert.match(r.corpo.erro, /não está acessível/)
    assert.ok(r.corpo.erro.includes(fora))
    assert.ok(!fs.existsSync(fora))
  }
})

test('I1: com captura rodando a pasta da empresa não muda de lugar; o grupo fica pendente e volta depois', async (t) => {
  const { ctx } = await montar(t)
  const { db, config } = ctx
  const rel = notaComXml(ctx, 'a'.repeat(44)).rel
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_principal', ?)").run(config.pastaXmls)
  db.prepare('UPDATE clientes SET apelido = ? WHERE cnpj = ?').run('Nome Novo', CNPJ_MOCK_OK)
  const emAndamento = ctx.ciclo.cicloEmAndamento
  ctx.ciclo.cicloEmAndamento = () => 'em andamento'
  ctx.organizador.agendar()
  await ctx.organizador.aguardar()
  assert.ok(fs.existsSync(path.join(config.pastaXmls, rel)), 'a pasta fica onde está')
  assert.equal(ctx.organizador.estado().falhas, 1)
  assert.match(ctx.organizador.estado().ultimoErro, /captura em andamento/)
  assert.doesNotMatch(ctx.organizador.estado().ultimoErro, /Feche/)
  assert.equal(db.prepare('SELECT COUNT(*) FROM pasta_grupos').pluck().get(), 0)
  ctx.ciclo.cicloEmAndamento = emAndamento
  ctx.organizador.agendar()
  await ctx.organizador.aguardar()
  assert.ok(!fs.existsSync(path.join(config.pastaXmls, 'Exemplo')))
  assert.equal(db.prepare('SELECT COUNT(*) FROM pasta_grupos').pluck().get(), 1)
})

test('I-1: GET /api/pastas traz a última troca: o erro de verdade e o sucesso com avisos', async (t) => {
  const { ctx, pedir } = await montar(t)
  const { rel } = notaComXml(ctx, 'a')
  const post = await appComPastas(t, ctx, {})
  assert.equal((await pedir('/api/pastas')).corpo.ultimaTroca, null)

  const original = fsp.rm
  const presa = path.join(ctx.config.pastaXmls, rel)
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (String(arquivo) === presa) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    return original(arquivo, ...resto)
  })
  const base = novaBase(t)
  assert.equal((await post('/api/pastas/principal', { pasta: base })).status, 200)
  const certa = (await pedir('/api/pastas')).corpo.ultimaTroca
  assert.equal(certa.ok, true)
  assert.equal(certa.tipo, 'xmls')
  assert.ok(certa.mensagem.includes(base))
  assert.deepEqual(certa.avisos, ['1 arquivo não saiu da pasta antiga. Pode apagá-lo depois.'])

  const r = await post('/api/pastas/principal', { pasta: path.join(base, 'dentro') })
  assert.equal(r.status, 400)
  const errada = (await pedir('/api/pastas')).corpo.ultimaTroca
  assert.equal(errada.ok, false)
  assert.equal(errada.mensagem, r.corpo.erro)
  assert.deepEqual(errada.avisos, [])
})

// ---------- Importar XMLs ----------

const { xmlNfse: xmlImportado, chaveNfse: chaveImportada, PRESTADOR_MOCK: PRESTADOR_IMPORTADO } = require('../src/sefaz/adn-mock')
const arquivoImportado = (n = 1) => ({
  nome: `nota-${n}.xml`,
  base64: Buffer.from(xmlImportado({ chave: chaveImportada(PRESTADOR_IMPORTADO, n), prestador: PRESTADOR_IMPORTADO, tomador: CNPJ_MOCK_OK, numero: String(n) })).toString('base64'),
})

test('importar grava a NFS-e e devolve o resumo', async (t) => {
  const { ctx, pedir } = await montar(t)
  const r = await pedir('/api/importar', { method: 'POST', body: { arquivos: [arquivoImportado(1)] } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.corpo.importadas.nfse, { entrada: 1, saida: 0 })
  const nota = ctx.db.prepare("SELECT origem, modelo FROM notas WHERE modelo = 'nfse'").get()
  assert.deepEqual({ ...nota }, { origem: 'importada', modelo: 'nfse' })
})

test('importar só no próprio PC', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  const r = await pedir('/api/importar', { method: 'POST', body: { arquivos: [arquivoImportado(1)] } })
  assert.equal(r.status, 403)
  assert.match(r.corpo.erro, /próprio computador/)
})

test('importar recusa durante a captura', async (t) => {
  const { pedir } = await montar(t, {}, { atrasoSefazMs: 200 })
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj: CNPJ_MOCK_OK } })).status, 202)
  const r = await pedir('/api/importar', { method: 'POST', body: { arquivos: [arquivoImportado(1)] } })
  assert.equal(r.status, 409)
  assert.match(r.corpo.erro, /captura/)
  await esperarFimDaCaptura(pedir)
})

test('importar sem arquivos dá 400', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/api/importar', { method: 'POST', body: { arquivos: [] } })
  assert.equal(r.status, 400)
  assert.equal(r.corpo.erro, 'Arraste ao menos um arquivo XML ou ZIP.')
})

test('importar com corpo grande demais dá 413', async (t) => {
  const { pedir } = await montar(t)
  const r = await pedir('/api/importar', { method: 'POST', body: { arquivos: [{ nome: 'grande.zip', base64: 'A'.repeat(65 * 1024 * 1024) }] } })
  assert.equal(r.status, 413)
  assert.match(r.corpo.erro, /grandes demais/)
})

test('importar sem a pasta principal escolhida dá 409', async (t) => {
  const { ctx } = await montar(t)
  const post = await appComPastas(t, ctx, { exigirPasta: true })
  const r = await post('/api/importar', { arquivos: [arquivoImportado(1)] })
  assert.equal(r.status, 409)
  assert.equal(r.corpo.erro, 'Escolha a pasta principal na tela Pastas antes de importar.')
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM notas WHERE modelo = 'nfse'").get().n, 0)
})

// ---------- Certificado procurador ----------

test('procurador: cadastrar, consultar e remover; só no PC local', async (t) => {
  const { pedir } = await montar(t)
  assert.deepEqual((await pedir('/api/procurador')).corpo, { procurador: null })

  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, razao: 'MARCOS AURELIO', senha: 'p' })
  const ok = await pedir('/api/procurador/certificado', { method: 'POST', body: { pfx: cert.pfx.toString('base64'), senha: 'p' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo))
  const info = (await pedir('/api/procurador')).corpo.procurador
  assert.match(info.titular, /MARCOS AURELIO/)
  assert.ok(info.validade)

  const senhaErrada = await pedir('/api/procurador/certificado', { method: 'POST', body: { pfx: cert.pfx.toString('base64'), senha: 'errada' } })
  assert.equal(senhaErrada.status, 400)

  assert.equal((await pedir('/api/procurador/remover', { method: 'POST', body: {} })).status, 200)
  assert.deepEqual((await pedir('/api/procurador')).corpo, { procurador: null })
})

test('procurador: rotas de escrita recusadas fora do PC', async (t) => {
  const { pedir } = await montar(t, {}, { ehLocal: () => false })
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, senha: 'p' })
  assert.equal((await pedir('/api/procurador/certificado', { method: 'POST', body: { pfx: cert.pfx.toString('base64'), senha: 'p' } })).status, 403)
  assert.equal((await pedir('/api/procurador/remover', { method: 'POST', body: {} })).status, 403)
})

test('captura manual de cliente sem A1 vale com procurador e erra sem ele', async (t) => {
  const { pedir } = await montar(t)
  const semA1 = '27865757000102'
  await pedir('/api/clientes', { method: 'POST', body: { cnpj: semA1, razao: 'Sem Cert Ltda', uf: 'CE', apelido: 'Sem Cert', semCertificado: true } })

  // sem procurador → 400
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj: semA1 } })).status, 400)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [semA1] } })).status, 400)

  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, razao: 'MARCOS AURELIO', senha: 'p' })
  assert.equal((await pedir('/api/procurador/certificado', { method: 'POST', body: { pfx: cert.pfx.toString('base64'), senha: 'p' } })).status, 200)

  // com procurador → aceita (202)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpj: semA1 } })).status, 202)
  await esperarFimDaCaptura(pedir)
  assert.equal((await pedir('/api/captura', { method: 'POST', body: { cnpjs: [semA1] } })).status, 202)
  await esperarFimDaCaptura(pedir)
})

test('cadastrar cliente leva as notas dele que estavam sem cliente', async (t) => {
  const { ctx, pedir } = await montar(t)
  ctx.db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES ('44555666000181', 'Escritorio Ltda', 'Escritorio', 'CE', '', '', 'escritorio')`).run()
  const novo = '22333444000181'
  const xml = xmlImportado({ chave: chaveImportada(PRESTADOR_IMPORTADO, 40), prestador: PRESTADOR_IMPORTADO, tomador: novo, numero: '40' })
  assert.equal(ctx.importacao.importar([{ nome: 'a.xml', bytes: Buffer.from(xml) }]).semCliente, 1)
  const r = await pedir('/api/clientes', { method: 'POST', body: { cnpj: novo, razao: 'Novo Cliente Ltda', uf: 'CE', semCertificado: true } })
  assert.equal(r.status, 201)
  const contar = () => ctx.db.prepare("SELECT COUNT(*) FROM notas n JOIN clientes c ON c.id = n.cliente_id WHERE c.cnpj = ?").pluck().get(novo)
  for (let i = 0; i < 50 && !contar(); i++) await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(contar(), 1)
})
