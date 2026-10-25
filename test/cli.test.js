'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { criarPrograma, tabela } = require('../src/cli')
const { criarContexto } = require('../src/contexto')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { criarSefazMock, CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')
const { gerarPfx } = require('./apoio/certificado')
const { silencioso } = require('./apoio/ambiente')

const RAIZ = path.resolve(__dirname, '..')
const cert = gerarPfx({ cnpj: CNPJ_MOCK_OK })

function pastasTemporarias() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-cli-'))
  const env = {
    MASTER_KEY: crypto.randomBytes(32).toString('hex'),
    SEFAZ_MOCK: '1',
    INTERVALO_ENTRE_CHAMADAS_MS: '0',
    PASTA_DADOS: path.join(base, 'data'),
    PASTA_LOGS: path.join(base, 'logs'),
    PASTA_XMLS: path.join(base, 'xmls'),
    PASTA_CERTS: path.join(base, 'certs'),
    PASTA_EXPORTS: path.join(base, 'exports'),
    PASTA_BACKUP: '', // não usa a pasta de backup do .env real
  }
  const pfx = path.join(base, 'cliente.pfx')
  fs.writeFileSync(pfx, cert.pfx)
  return { base, env, pfx, limpar: () => fs.rmSync(base, { recursive: true, force: true }) }
}

// Programa em processo, com banco em memória e respostas de terminal simuladas.
function montarPrograma({ respostas = [], interativo = true } = {}) {
  const p = pastasTemporarias()
  const ctx = criarContexto({ config: carregarConfig(p.env), logger: silencioso, db: abrirBanco(':memory:'), fabricaSefaz: ((m) => (c) => m.cliente(c.cnpj))(criarSefazMock()) })
  const saida = []
  const perguntas = []
  const responder = async (msg) => {
    perguntas.push(msg)
    return respostas.shift() ?? ''
  }
  const executar = async (...args) => {
    const programa = criarPrograma({ contexto: () => ({ ...ctx, fechar() {} }), log: (m) => saida.push(m), senha: responder, texto: responder, entradaInterativa: interativo })
    programa.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
    for (const cmd of programa.commands) cmd.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
    await programa.parseAsync(['node', 'cli', ...args])
  }
  return { ...p, ctx, saida, perguntas, executar }
}

test('cliente:add pede a senha, cadastra e cliente:list mostra sem a senha', async (t) => {
  const m = montarPrograma({ respostas: [cert.senha] })
  t.after(m.limpar)
  await m.executar('cliente:add', '--cnpj', '11.222.333/0001-81', '--razao', 'Comercial Exemplo Ltda', '--uf', 'CE', '--pfx', m.pfx, '--apelido', 'Exemplo')
  assert.deepEqual(m.perguntas, ['Senha do certificado: '])
  assert.match(m.saida[0], /Cliente cadastrado: 11222333000181 - Comercial Exemplo Ltda/)
  assert.ok(fs.existsSync(path.join(m.env.PASTA_CERTS, '11222333000181.pfx')))

  m.saida.length = 0
  await m.executar('cliente:list')
  assert.match(m.saida[0], /11222333000181 +Exemplo +cliente +sim +000000000000000/)
  assert.ok(!m.saida.join('\n').includes(cert.senha))
})

test('cliente:add com senha errada ou arquivo inexistente lança erro', async (t) => {
  const m = montarPrograma({ respostas: ['errada'] })
  t.after(m.limpar)
  await assert.rejects(m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'X', '--uf', 'CE', '--pfx', m.pfx), /Senha do certificado incorreta/)
  await assert.rejects(m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'X', '--uf', 'CE', '--pfx', path.join(m.base, 'nao.pfx')), /Arquivo não encontrado/)
  await assert.rejects(m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK), /required option/)
})

test('capturar, status, desativar e manifestar', async (t) => {
  const m = montarPrograma({ respostas: [cert.senha, 'n', 's'] })
  t.after(m.limpar)
  await m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'Comercial Exemplo Ltda', '--uf', 'CE', '--pfx', m.pfx)

  m.saida.length = 0
  await m.executar('capturar')
  assert.deepEqual(m.saida, [`${CNPJ_MOCK_OK}: consulta 4 doc(s), cStat 138 | ciência 1/1 | download 1/1`])

  m.saida.length = 0
  await m.executar('status')
  const status = m.saida.join('\n')
  assert.match(status, /SEFAZ simulada/)
  assert.match(status, /completa +2 +0/)
  assert.match(status, /resumo +1 +1/)

  const chave = m.ctx.db.prepare("SELECT chave FROM notas WHERE status = 'completa' LIMIT 1").get().chave
  m.saida.length = 0
  await m.executar('manifestar', '--chave', chave, '--evento', 'confirmacao')
  assert.equal(m.saida.at(-1), 'Cancelado.')
  await m.executar('manifestar', '--chave', chave, '--evento', 'confirmacao')
  assert.match(m.saida.at(-1), /Evento registrado: cStat 135/)
  await assert.rejects(m.executar('manifestar', '--chave', chave, '--evento', 'nao-realizada', '--sim'), /justificativa/)

  await m.executar('cliente:desativar', '--cnpj', CNPJ_MOCK_OK)
  m.saida.length = 0
  await m.executar('capturar')
  assert.deepEqual(m.saida, ['Nenhum cliente ativo.'])
  await assert.rejects(m.executar('capturar', '--cnpj', '00000000000000'), /não cadastrado/)
})

test('manifestar sem terminal exige --sim', async (t) => {
  const m = montarPrograma({ respostas: [cert.senha], interativo: false })
  t.after(m.limpar)
  await m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'Comercial Exemplo Ltda', '--uf', 'CE', '--pfx', m.pfx)
  await m.executar('capturar')
  const chave = m.ctx.db.prepare("SELECT chave FROM notas WHERE status = 'completa' LIMIT 1").get().chave
  await assert.rejects(m.executar('manifestar', '--chave', chave, '--evento', 'desconhecimento'), /use --sim/)
  await m.executar('manifestar', '--chave', chave, '--evento', 'desconhecimento', '--sim')
  assert.match(m.saida.at(-1), /Evento registrado/)
})

test('manifestar --cnpj aceita CNPJ formatado e recusa nota de saída', async (t) => {
  const m = montarPrograma({ respostas: [cert.senha], interativo: false })
  t.after(m.limpar)
  await m.executar('cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'Comercial Exemplo Ltda', '--uf', 'CE', '--pfx', m.pfx)
  await m.executar('capturar')
  const chave = m.ctx.db.prepare("SELECT chave FROM notas WHERE status = 'completa' LIMIT 1").get().chave
  const formatado = `${CNPJ_MOCK_OK.slice(0, 2)}.${CNPJ_MOCK_OK.slice(2, 5)}.${CNPJ_MOCK_OK.slice(5, 8)}/${CNPJ_MOCK_OK.slice(8, 12)}-${CNPJ_MOCK_OK.slice(12)}`
  await m.executar('manifestar', '--chave', chave, '--evento', 'desconhecimento', '--cnpj', formatado, '--sim')
  assert.match(m.saida.at(-1), /Evento registrado/)

  m.ctx.db.prepare("UPDATE notas SET tipo = 'saida' WHERE chave = ?").run(chave)
  await assert.rejects(m.executar('manifestar', '--chave', chave, '--evento', 'desconhecimento', '--cnpj', formatado, '--sim'), /só vale para nota de entrada/)
})

test('backup: sem PASTA_BACKUP explica como ligar; com a pasta, faz a cópia', async (t) => {
  const sem = montarPrograma()
  t.after(sem.limpar)
  await sem.executar('backup')
  assert.match(sem.saida.join(' '), /PASTA_BACKUP/)

  const p = pastasTemporarias()
  t.after(p.limpar)
  const pastaBackup = path.join(p.base, 'backup')
  const ctx = criarContexto({ config: carregarConfig({ ...p.env, PASTA_BACKUP: pastaBackup }), logger: silencioso, db: abrirBanco(':memory:') })
  const saida = []
  const programa = criarPrograma({ contexto: () => ({ ...ctx, fechar() {} }), log: (m) => saida.push(m) })
  programa.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
  await programa.parseAsync(['node', 'cli', 'backup'])
  assert.match(saida.join(' '), /Backup feito/)
  assert.equal(fs.readdirSync(path.join(pastaBackup, 'diarios')).length, 1)
})

test('tabela alinha colunas', () => {
  assert.equal(tabela([{ a: 'x', b: 10 }, { a: 'longo', b: 2 }], [['A', 'a'], ['Bê', 'b']]), 'A      Bê\n-----  --\nx      10\nlongo  2')
  assert.equal(tabela([], [['A', 'a']]), '(nenhum registro)')
})

// Processo real: senha pelo pipe, SEFAZ simulada e pastas temporárias.
function cli(env, args, input) {
  return spawnSync(process.execPath, [path.join(RAIZ, 'src', 'cli.js'), ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 60000 })
}

test('processo real: cadastro com senha pelo pipe, captura duas vezes sem duplicar', (t) => {
  const p = pastasTemporarias()
  t.after(p.limpar)
  const add = cli(p.env, ['cliente:add', '--cnpj', CNPJ_MOCK_OK, '--razao', 'Comercial Exemplo Ltda', '--uf', 'CE', '--pfx', p.pfx], `${cert.senha}\n`)
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /Cliente cadastrado/)
  assert.ok(!add.stdout.includes(cert.senha) && !add.stderr.includes(cert.senha), 'senha não aparece na saída')

  const c1 = cli(p.env, ['capturar'])
  assert.equal(c1.status, 0, c1.stderr)
  assert.match(c1.stdout, /ciência 1\/1 \| download 1\/1/)
  const c2 = cli(p.env, ['capturar', '--forcar'])
  assert.equal(c2.status, 0, c2.stderr)
  assert.match(c2.stdout, /cStat 137/)

  const db = abrirBanco(path.join(p.env.PASTA_DADOS, 'nfe.db'))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas').get().n, 3)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notas WHERE status = 'completa'").get().n, 2)
  db.close()
  const xmls = fs.readdirSync(p.env.PASTA_XMLS, { recursive: true }).filter((f) => f.endsWith('.xml'))
  assert.equal(xmls.length, 5)
  const log = fs.readFileSync(path.join(p.env.PASTA_LOGS, 'app.log'), 'utf8')
  assert.ok(!log.includes(cert.senha), 'senha não aparece no log')

  const competencia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7)
  const exp = cli(p.env, ['exportar', '--cnpj', CNPJ_MOCK_OK, '--competencia', competencia])
  assert.equal(exp.status, 0, exp.stderr)
  assert.match(exp.stdout, /0 nota\(s\) ainda sem XML/)
  assert.match(exp.stdout, /Entradas: 2 XML\(s\) em entradas\/xml\/, 0 em entradas\/canceladas\/ \| Saídas: 0 XML\(s\) em saidas\/xml\/, 0 em saidas\/canceladas\//)
  assert.ok(fs.existsSync(path.join(p.env.PASTA_EXPORTS, `${CNPJ_MOCK_OK}_Comercial_Exemplo_Ltda_${competencia}.zip`)))

  const erro = cli(p.env, ['cliente:ativar', '--cnpj', '1'])
  assert.equal(erro.status, 1)
  assert.match(erro.stderr, /Erro: CNPJ 1 não cadastrado/)
})

test('processo real: sem MASTER_KEY a CLI recusa iniciar', (t) => {
  const p = pastasTemporarias()
  t.after(p.limpar)
  const r = cli({ ...p.env, MASTER_KEY: '' }, ['status'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /MASTER_KEY ausente ou inválida/)
})

test('escritorio:add pela CLI e cliente:list mostra o papel', async (t) => {
  const m = montarPrograma({ respostas: [cert.senha, cert.senha] })
  t.after(m.limpar)
  await assert.rejects(m.executar('escritorio:cert', '--pfx', m.pfx), /Nenhum escritório cadastrado\. Use escritorio:add\./)
  m.perguntas.length = 0
  await m.executar('escritorio:add', '--cnpj', '11.222.333/0001-81', '--razao', 'Contabilidade Exemplo', '--uf', 'CE', '--pfx', m.pfx)
  assert.deepEqual(m.perguntas, ['Senha do certificado: '])
  assert.match(m.saida[0], /Escritório cadastrado: 11222333000181 - Contabilidade Exemplo/)
  assert.ok(fs.existsSync(path.join(m.env.PASTA_CERTS, '11222333000181.pfx')))

  m.saida.length = 0
  await m.executar('cliente:list')
  assert.match(m.saida[0], /Papel/)
  assert.match(m.saida[0], /11222333000181 +escritorio +escritorio +sim/)

  m.saida.length = 0
  await m.executar('escritorio:cert', '--pfx', m.pfx)
  assert.match(m.saida[0], /Certificado do escritório trocado: 11222333000181/)

  m.saida.length = 0
  await m.executar('status')
  assert.ok(m.saida.some((l) => /^Escritório: 11222333000181/.test(l)))
  assert.match(m.saida.find((l) => l.startsWith('Clientes ativos')), /Clientes ativos: 0 de 0/)

  m.saida.length = 0
  await m.executar('capturar')
  assert.ok(m.saida.some((l) => /^Escritório 11222333000181:/.test(l)), m.saida.join(' / '))
  assert.ok(!m.saida.includes('Nenhum cliente ativo.'))
  m.saida.length = 0
  await m.executar('capturar', '--cnpj', '11222333000181')
  assert.ok(m.saida.some((l) => /^Escritório 11222333000181:/.test(l)), m.saida.join(' / '))
})
