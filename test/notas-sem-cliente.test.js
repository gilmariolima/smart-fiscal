'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { criarServicoImportacao } = require('../src/services/importacao')
const { criarNotasSemCliente } = require('../src/services/notasSemCliente')
const { nfeProc } = require('./apoio/nfe-importada')
const { cteProc, DEST } = require('./apoio/cte')
const { xmlNfse, chaveNfse } = require('../src/sefaz/adn-mock')

const NOVO = '22333444000181'
const FORA = '66777888000199'
const logger = { info() {}, warn() {}, error() {} }

function montar({ comEscritorio = true } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-cliente-'))
  const db = abrirBanco(':memory:')
  if (comEscritorio) db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES ('44555666000181', 'Escritorio Ltda', 'Escritorio', 'CE', 'e.pfx', 'a:b:c', 'escritorio')`).run()
  const config = { pastaXmls }
  const importacao = criarServicoImportacao({ db, config, logger })
  const semCliente = criarNotasSemCliente({ db, config, logger, importacao })
  const cadastrar = (cnpj, apelido) => db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, ?, ?, 'CE', '', '')`).run(cnpj, apelido, apelido).lastInsertRowid
  const raiz = path.join(pastaXmls, 'Escritorio Ltda', 'Sem cliente cadastrado')
  return { db, importacao, semCliente, cadastrar, raiz, pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const arq = (nome, texto) => ({ nome, bytes: Buffer.from(texto) })
const xmlsEm = (pasta) => (fs.existsSync(pasta) ? fs.readdirSync(pasta, { recursive: true }).filter((f) => f.endsWith('.xml')) : [])

test('notas dos três tipos vão ao cliente cadastrado e saem da pasta sem cliente', async (t) => {
  const { db, importacao, semCliente, cadastrar, raiz, limpar } = montar()
  t.after(limpar)
  const r0 = importacao.importar([
    arq('n.xml', nfeProc({ emit: FORA, dest: NOVO })),
    arq('c.xml', cteProc({ dest: NOVO })),
    arq('s.xml', xmlNfse({ chave: chaveNfse(FORA, 3), prestador: FORA, tomador: NOVO })),
  ])
  assert.equal(r0.semCliente, 3)
  const id = cadastrar(NOVO, 'Novo')
  const r = await semCliente.levar()
  assert.deepEqual({ levadas: r.levadas, ficaram: r.ficaram, falhas: r.falhas }, { levadas: 3, ficaram: 0, falhas: 0 })
  assert.deepEqual(r.clientesAfetados, [id])
  assert.deepEqual(db.prepare('SELECT modelo FROM notas WHERE cliente_id = ? ORDER BY modelo').pluck().all(id), ['cte', 'nfe', 'nfse'])
  assert.equal(fs.existsSync(raiz), true)
  assert.deepEqual(xmlsEm(raiz), [])
  assert.deepEqual(fs.readdirSync(raiz), [])
})

test('nota de CNPJ ainda sem cadastro e arquivo ilegível ficam onde estão', async (t) => {
  const { importacao, semCliente, raiz, limpar } = montar()
  t.after(limpar)
  importacao.importar([arq('n.xml', nfeProc({ emit: FORA, dest: NOVO }))])
  const lixo = path.join(raiz, '2026', 'lixo-nfe.xml')
  fs.writeFileSync(lixo, 'abc')
  const r = await semCliente.levar()
  assert.deepEqual({ levadas: r.levadas, ficaram: r.ficaram, falhas: r.falhas }, { levadas: 0, ficaram: 2, falhas: 0 })
  assert.equal(xmlsEm(raiz).length, 2)
})

test('sem escritório ou sem a pasta, não faz nada', async (t) => {
  const sem = montar({ comEscritorio: false })
  t.after(sem.limpar)
  assert.deepEqual(await sem.semCliente.levar(), { levadas: 0, ficaram: 0, falhas: 0, clientesAfetados: [] })
  const vazio = montar()
  t.after(vazio.limpar)
  assert.deepEqual(await vazio.semCliente.levar(), { levadas: 0, ficaram: 0, falhas: 0, clientesAfetados: [] })
})

test('CT-e em que o cliente é o tomador também vai', async (t) => {
  const { db, importacao, semCliente, cadastrar, limpar } = montar()
  t.after(limpar)
  importacao.importar([arq('c.xml', cteProc({}))])
  const id = cadastrar(DEST, 'Destino')
  assert.equal((await semCliente.levar()).levadas, 1)
  assert.equal(db.prepare('SELECT tipo FROM notas WHERE cliente_id = ?').pluck().get(id), 'entrada')
})
