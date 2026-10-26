'use strict'

// Testes do app desktop (Electron) sem o Electron: pasta de dados, cópia dos dados do SmartDoc e do
// Estoque SPED, motor do SPED e atualização automática.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { pastaDados, subpastas, appsAnteriores, copiarDadosAnteriores, prepararEnv, garantirProducao } = require('../electron/dados')
const { pastaMotor, caminhoPython, iniciarMotor } = require('../electron/motor')
const { criarAtualizacao } = require('../electron/atualizar')

const RAIZ = path.resolve(__dirname, '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smart-fiscal-app-'))
const escrever = (arq, conteudo = '') => {
  fs.mkdirSync(path.dirname(arq), { recursive: true })
  fs.writeFileSync(arq, conteudo)
}

/** SmartDoc e Estoque SPED instalados, com dados. */
function appsAntigos(local) {
  escrever(path.join(local, 'SmartDoc', 'dados', '.env'), 'MASTER_KEY=abc\n')
  escrever(path.join(local, 'SmartDoc', 'dados', 'data', 'nfe.db'), 'banco')
  escrever(path.join(local, 'Estoque SPED', 'dados', 'empresas.json'), '{"11222333000181":{"uf":"CE"}}')
  escrever(path.join(local, 'Estoque SPED', 'dados', 'saida', 'SPED_1.txt'), '|0000|')
  return appsAnteriores({ localAppData: local })
}

test('pasta de dados fica fora da pasta do programa, com uma parte para cada motor', () => {
  const local = path.join('C:', 'Users', 'x', 'AppData', 'Local')
  const p = pastaDados({ env: {}, localAppData: local })
  assert.equal(p, path.join(local, 'Smart Fiscal', 'dados'))
  assert.ok(!p.includes('Programs'))
  assert.deepEqual(subpastas(p), { notas: path.join(p, 'notas'), estoque: path.join(p, 'estoque') })
  assert.equal(pastaDados({ env: { SMART_FISCAL_DADOS: '/srv/sf' } }), path.resolve('/srv/sf'))
})

test('garantirProducao: .env em homologação passa para TP_AMB=1 e mantém o resto; demonstração e produção ficam', () => {
  const pasta = tmp()
  const arquivo = path.join(pasta, '.env')
  assert.equal(garantirProducao(pasta), false, 'sem .env não faz nada')

  fs.writeFileSync(arquivo, 'TP_AMB=2   # homologação\nMASTER_KEY=abc\nCRON_CAPTURA=0 8 * * *\n')
  assert.equal(garantirProducao(pasta), true)
  const depois = fs.readFileSync(arquivo, 'utf8')
  assert.match(depois, /^TP_AMB=1 /m)
  assert.doesNotMatch(depois, /TP_AMB=2/)
  assert.match(depois, /^MASTER_KEY=abc$/m)
  assert.match(depois, /^CRON_CAPTURA=0 8 \* \* \*$/m)
  assert.equal(garantirProducao(pasta), false, 'já em produção')

  fs.writeFileSync(arquivo, 'MASTER_KEY=abc\n')
  assert.equal(garantirProducao(pasta), true, 'sem TP_AMB (o padrão é homologação)')
  assert.match(fs.readFileSync(arquivo, 'utf8'), /^TP_AMB=1 [^\n]*\nMASTER_KEY=abc\n$/)

  fs.writeFileSync(arquivo, 'TP_AMB=2\nSEFAZ_MOCK=1\nMASTER_KEY=abc\n')
  assert.equal(garantirProducao(pasta), false, 'demonstração fica como está')
  assert.match(fs.readFileSync(arquivo, 'utf8'), /^TP_AMB=2$/m)
})

test('prepararEnv cria .env com MASTER_KEY nova e nunca sobrescreve', () => {
  const pasta = path.join(tmp(), 'notas')
  const modelo = path.join(RAIZ, '.env.example')
  const r = prepararEnv(pasta, modelo)
  assert.equal(r.criado, true)
  const conteudo = fs.readFileSync(r.arquivo, 'utf8')
  assert.match(conteudo, /^MASTER_KEY=[0-9a-f]{64}$/m)
  assert.match(conteudo, /^TP_AMB=1 /m, 'instalação nova já sai em produção')
  assert.doesNotMatch(conteudo, /^TP_AMB=2/m)
  assert.equal(prepararEnv(pasta, modelo).criado, false)
  assert.equal(fs.readFileSync(r.arquivo, 'utf8'), conteudo)
})

test('copia os dados do SmartDoc e do Estoque SPED e deixa os originais', () => {
  const local = tmp()
  const anteriores = appsAntigos(local)
  const dados = path.join(local, 'Smart Fiscal', 'dados')
  const copiados = copiarDadosAnteriores({ dados, anteriores })
  assert.deepEqual(copiados.map((c) => c.nome), ['SmartDoc', 'Estoque SPED'])
  assert.equal(fs.readFileSync(path.join(dados, 'notas', '.env'), 'utf8'), 'MASTER_KEY=abc\n')
  assert.ok(fs.existsSync(path.join(dados, 'notas', 'data', 'nfe.db')))
  assert.ok(fs.existsSync(path.join(dados, 'estoque', 'saida', 'SPED_1.txt')))
  assert.ok(fs.existsSync(path.join(local, 'SmartDoc', 'dados', '.env')), 'o SmartDoc continua com os dados dele')
  assert.ok(fs.existsSync(path.join(local, 'Estoque SPED', 'dados', 'empresas.json')))
  // Segunda abertura: nada a copiar, e nada do que mudou no Smart Fiscal é sobrescrito
  fs.writeFileSync(path.join(dados, 'estoque', 'empresas.json'), '{}')
  assert.deepEqual(copiarDadosAnteriores({ dados, anteriores }), [])
  assert.equal(fs.readFileSync(path.join(dados, 'estoque', 'empresas.json'), 'utf8'), '{}')
})

test('SmartDoc sem .env não é copiado (sem a MASTER_KEY os certificados não abrem)', () => {
  const local = tmp()
  const anteriores = appsAntigos(local)
  fs.rmSync(path.join(local, 'SmartDoc', 'dados', '.env'))
  const copiados = copiarDadosAnteriores({ dados: path.join(local, 'SF'), anteriores })
  assert.deepEqual(copiados.map((c) => c.nome), ['Estoque SPED'])
})

test('parte só com logs não impede a cópia; cópia interrompida não deixa pasta pela metade', () => {
  const local = tmp()
  const anteriores = appsAntigos(local)
  const dados = path.join(local, 'SF')
  escrever(path.join(dados, 'estoque', 'painel.log'), 'ligou')
  escrever(path.join(dados, 'notas.copiando', 'meio.txt'), 'restos de uma cópia que parou')
  copiarDadosAnteriores({ dados, anteriores })
  assert.ok(fs.existsSync(path.join(dados, 'estoque', 'empresas.json')))
  assert.ok(fs.existsSync(path.join(dados, 'notas', '.env')))
  assert.ok(!fs.existsSync(path.join(dados, 'notas', 'meio.txt')))
  assert.ok(!fs.existsSync(path.join(dados, 'notas.copiando')))
})

test('sem apps anteriores, não copia nada', () => {
  const local = tmp()
  assert.deepEqual(copiarDadosAnteriores({ dados: path.join(local, 'SF'), anteriores: appsAnteriores({ localAppData: local }) }), [])
  assert.deepEqual(appsAnteriores({ localAppData: '' }), [])
})

test('o motor do SPED fica na pasta estoque', () => {
  assert.equal(pastaMotor({ empacotado: false, raiz: RAIZ }), path.join(RAIZ, 'estoque'))
  assert.equal(pastaMotor({ empacotado: true, recursos: 'C:\\SF\\resources' }), path.join('C:\\SF\\resources', 'estoque'))
})

test('motor: liga numa porta livre, responde e desliga', async () => {
  const motor = pastaMotor({ empacotado: false, raiz: RAIZ })
  assert.equal(pastaMotor({ empacotado: true, recursos: '/r' }), path.join('/r', 'estoque'))
  const dados = tmp()
  const m = await iniciarMotor({ python: caminhoPython({ motor }), motor, dados, log: path.join(dados, 'painel.log') })
  try {
    assert.match(m.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(m.entrada, `${m.url}/?t=${m.token}`)
    const r = await fetch(`${m.url}/api/gerados`, { headers: { 'X-Estoque-Token': m.token } })
    assert.deepEqual(await r.json(), [])
    // sem o token desta execução (outro programa, outro usuário do computador) é recusado
    assert.equal((await fetch(`${m.url}/api/gerados`)).status, 401)
    assert.equal((await fetch(`${m.url}/api/gerados`, { headers: { 'X-Estoque-Token': 'outro' } })).status, 401)
    // a janela abre /?t=<token>: o painel guarda o token num cookie só dele e tira do endereço
    const entrada = await fetch(m.entrada, { redirect: 'manual' })
    assert.equal(entrada.status, 303)
    assert.equal(entrada.headers.get('location'), '/')
    const cookie = entrada.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    const pagina = await fetch(`${m.url}/`, { headers: { Cookie: cookie.split(';')[0] } })
    assert.equal(pagina.status, 200)
    assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/)
    // pedido de outro site é recusado
    const fora = await fetch(`${m.url}/api/encerrar`, { method: 'POST', headers: { Origin: 'https://site-qualquer.com', 'X-Estoque-Token': m.token } })
    assert.equal(fora.status, 403)
  } finally {
    await m.parar()
  }
  assert.notEqual(m.processo.exitCode ?? m.processo.signalCode, null)
})

test('motor: falha ao ligar explica o motivo', async () => {
  const motor = tmp() // sem painel.py
  await assert.rejects(
    iniciarMotor({ python: caminhoPython({ motor: pastaMotor({ empacotado: false, raiz: RAIZ }) }), motor, dados: tmp(), espera: 10e3 }),
    /fechou ao ligar[\s\S]*painel\.py/,
  )
})

/** autoUpdater de mentira: guarda os ouvintes e as chamadas. */
function atualizadorFalso({ falhar = false } = {}) {
  const ouvintes = {}
  return {
    ouvintes,
    instalou: null,
    procurou: 0,
    on(evento, fn) { ouvintes[evento] = fn },
    async checkForUpdates() {
      this.procurou++
      if (falhar) throw new Error('sem internet')
    },
    quitAndInstall(silencioso, reabrir) { this.instalou = { silencioso, reabrir } },
  }
}

test('atualização: sem versão baixada, fechar o app não instala nada', async () => {
  const atualizador = atualizadorFalso()
  const a = criarAtualizacao({ atualizador, perguntar: async () => ({ response: 1 }), sair: () => {} })
  await a.procurar()
  assert.equal(atualizador.procurou, 1)
  assert.equal(atualizador.autoInstallOnAppQuit, false)
  assert.equal(a.instalarAoSair(), false)
  assert.equal(atualizador.instalou, null)
})

test('atualização: "Reiniciar agora" fecha o app e instala reabrindo', async () => {
  const atualizador = atualizadorFalso()
  let saiu = 0
  let pergunta
  const a = criarAtualizacao({ atualizador, perguntar: async (o) => { pergunta = o; return { response: 0 } }, sair: () => saiu++ })
  await atualizador.ouvintes['update-downloaded']({ version: '1.2.0' })
  assert.match(pergunta.message, /1\.2\.0/)
  assert.equal(saiu, 1)
  assert.equal(a.instalarAoSair(), true)
  assert.deepEqual(atualizador.instalou, { silencioso: true, reabrir: true })
})

test('atualização: "Depois" instala só ao fechar, sem reabrir', async () => {
  const atualizador = atualizadorFalso()
  let saiu = 0
  const a = criarAtualizacao({ atualizador, perguntar: async () => ({ response: 1 }), sair: () => saiu++ })
  await atualizador.ouvintes['update-downloaded']({ version: '1.2.0' })
  assert.equal(saiu, 0)
  assert.equal(a.instalarAoSair(), true)
  assert.deepEqual(atualizador.instalou, { silencioso: true, reabrir: false })
})

test('atualização: sem internet, só anota no log', async () => {
  const log = path.join(tmp(), 'atualizacao.log')
  const atualizador = atualizadorFalso({ falhar: true })
  const a = criarAtualizacao({ atualizador, perguntar: async () => ({ response: 1 }), sair: () => {}, log })
  await a.procurar()
  assert.match(fs.readFileSync(log, 'utf8'), /erro .*sem internet/)
  assert.equal(a.instalarAoSair(), false)
})

test('publicação: o pacote publica no GitHub deste repositório e leva o electron-updater', () => {
  const pacote = require('../package.json')
  assert.deepEqual(pacote.build.publish, [{ provider: 'github', owner: 'gilmariolima', repo: 'smart-fiscal', releaseType: 'release' }])
  assert.ok(pacote.dependencies['electron-updater'], 'electron-updater tem de ir em dependencies, não em devDependencies')
  assert.match(pacote.scripts.pacote, /--publish never/)
})
