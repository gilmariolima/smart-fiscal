'use strict'

// O painel repassa /estoque para o motor do SPED (Python): com o token, sem ler o arquivo enviado.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { criarApp } = require('../src/web/server')
const { criarContexto } = require('../src/contexto')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { criarAgendador } = require('../src/scheduler')
const { pastaMotor, caminhoPython, iniciarMotor } = require('../electron/motor')
const { silencioso } = require('./apoio/ambiente')

const RAIZ = path.resolve(__dirname, '..')
const XLS = path.join(RAIZ, 'estoque', 'tests', 'arquivos', 'cod_produto_antigo.xls')

async function montar(t, { semMotor = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ponte-'))
  const pastaPainel = path.join(base, 'painel')
  fs.mkdirSync(pastaPainel)
  fs.writeFileSync(path.join(pastaPainel, 'index.html'), '<!doctype html><title>Smart Fiscal</title>')
  const env = { MASTER_KEY: crypto.randomBytes(32).toString('hex'), SEFAZ_MOCK: '1', PASTA_XMLS: path.join(base, 'xmls'),
    PASTA_CERTS: path.join(base, 'certs'), PASTA_EXPORTS: path.join(base, 'exports') }
  const ctx = criarContexto({ config: carregarConfig(env), logger: silencioso, db: abrirBanco(':memory:') })
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  let motor = { erro: 'O motor do SPED não ligou: Python não encontrado' }
  if (!semMotor) {
    const dir = pastaMotor({ empacotado: false, raiz: RAIZ })
    motor = await iniciarMotor({ python: caminhoPython({ motor: dir }), motor: dir, dados: path.join(base, 'estoque'), espera: 15e3 })
  }
  const servidor = criarApp({ ctx, agendador, pastaPainel, estoque: () => motor }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  const url = `http://127.0.0.1:${servidor.address().port}`
  t.after(async () => {
    await new Promise((r) => servidor.close(r))
    await motor.parar?.()
    ctx.fechar()
    fs.rmSync(base, { recursive: true, force: true })
  })
  const pedir = async (caminho, { method = 'GET', body, headers = {}, painel = true } = {}) => {
    const json = body && !Buffer.isBuffer(body)
    const r = await fetch(url + caminho, {
      method,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(painel && method !== 'GET' ? { 'X-Painel': '1' } : {}), ...headers },
      body: json ? JSON.stringify(body) : body,
    })
    const tipo = r.headers.get('content-type') || ''
    return { status: r.status, headers: r.headers, corpo: tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }
  }
  return { pedir, base }
}

test('ponte do SPED: envia o arquivo, converte, baixa e lista pelo painel', async (t) => {
  const { pedir } = await montar(t)
  const { corpo: { lote } } = await pedir('/estoque/api/lote', { method: 'POST' })
  assert.match(lote, /^[0-9a-f]{12}$/)
  const envio = await pedir(`/estoque/api/enviar?lote=${lote}&nome=estoque.xls`, { method: 'POST', body: fs.readFileSync(XLS) })
  assert.deepEqual(envio.corpo, { nome: 'estoque.xls' })
  const r = await pedir('/estoque/api/converter', { method: 'POST', body: { lote, arquivos: ['estoque.xls'], campos: {
    cnpj: '11.222.333/0001-81', uf: 'CE', cod_mun: '2304400', data_inv: '31/12/2025' } } })
  assert.equal(r.status, 200)
  assert.equal(r.corpo.resumo.itens, 2)
  const baixado = await pedir(`/estoque/baixar/${encodeURIComponent(r.corpo.arquivo)}`)
  assert.equal(baixado.status, 200)
  assert.match(baixado.headers.get('content-disposition'), /attachment/)
  assert.match(baixado.corpo.toString('latin1'), /^\|0000\|/)
  const gerados = await pedir('/estoque/api/gerados')
  assert.deepEqual(gerados.corpo.map((g) => g.arquivo), [r.corpo.arquivo])
})

test('ponte do SPED: ação sem o cabeçalho do painel é recusada antes de chegar ao motor', async (t) => {
  const { pedir, base } = await montar(t)
  const r = await pedir('/estoque/api/escritorio', { method: 'POST', body: { nome: 'X' }, painel: false })
  assert.equal(r.status, 403)
  assert.ok(!fs.existsSync(path.join(base, 'estoque', 'escritorio.json')))
})

test('ponte do SPED: sem o motor, a tela recebe o motivo', async (t) => {
  const { pedir } = await montar(t, { semMotor: true })
  const r = await pedir('/estoque/api/gerados')
  assert.equal(r.status, 503)
  assert.match(r.corpo.erro, /motor do SPED não ligou/)
})
