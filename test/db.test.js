'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')
const { abrirBanco, migrar } = require('../src/db')

// Esquema da versão 0 (antes de tipo/papel), usado para testar a migração.
const DDL_V0 = `
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY,
  cnpj TEXT NOT NULL UNIQUE,          -- só dígitos
  razao_social TEXT NOT NULL,
  apelido TEXT,                       -- usado no nome da pasta
  uf TEXT NOT NULL,                   -- 'CE'
  cert_arquivo TEXT NOT NULL,         -- nome do .pfx dentro de certs/
  cert_senha_enc TEXT NOT NULL,       -- AES-256-GCM (iv:tag:dados em base64)
  cert_validade TEXT,                 -- lida do certificado no cadastro
  ativo INTEGER NOT NULL DEFAULT 1,
  ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
  max_nsu TEXT,
  proxima_consulta TEXT,              -- ISO; respeita cStat 137
  bloqueado_ate TEXT,                 -- ISO; respeita cStat 656
  ultima_consulta TEXT,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notas (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  chave TEXT NOT NULL UNIQUE,
  nsu TEXT,
  emitente_cnpj TEXT,
  emitente_nome TEXT,
  emitente_ie TEXT,
  numero TEXT,
  serie TEXT,
  data_emissao TEXT,
  valor_total REAL,
  tipo_nf TEXT,                       -- 0 entrada, 1 saída (tpNF)
  situacao_sefaz TEXT,                -- cSitNFe do resumo
  status TEXT NOT NULL,               -- resumo | ciencia_enviada | ciencia_erro | completa
  cancelada INTEGER NOT NULL DEFAULT 0,
  ciencia_protocolo TEXT,
  ciencia_em TEXT,
  ciencia_erro TEXT,
  tentativas_download INTEGER NOT NULL DEFAULT 0,
  caminho_xml TEXT,
  competencia TEXT,                   -- AAAA-MM da data de emissão
  exportada_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_notas_cliente_comp ON notas(cliente_id, competencia);
CREATE INDEX IF NOT EXISTS idx_notas_status ON notas(status);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY,
  chave TEXT NOT NULL,
  tp_evento TEXT NOT NULL,
  n_seq TEXT,
  descricao TEXT,
  data_evento TEXT,
  protocolo TEXT,
  caminho_xml TEXT,
  UNIQUE(chave, tp_evento, n_seq)
);
`

function novoCliente(db) {
  return db.prepare(`INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc)
    VALUES ('12345678000199', 'Cliente Teste', 'CE', '12345678000199.pfx', 'x:y:z')`).run().lastInsertRowid
}

test('migrations criam as 5 tabelas', () => {
  const db = abrirBanco(':memory:')
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
  assert.deepEqual(tabelas, ['clientes', 'eventos', 'execucoes', 'notas', 'sistema'])
  assert.equal(db.prepare('SELECT ult_nsu FROM clientes').get(), undefined)
})

test('migrations rodam duas vezes no mesmo arquivo sem erro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = path.join(dir, 'sub', 'nfe.db')
  abrirBanco(arq).close()
  const db = abrirBanco(arq)
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('banco antigo ganha modelo e colunas da NFS-e', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = path.join(dir, 'nfe.db')
  const antigo = new Database(arq)
  antigo.exec(DDL_V0)
  const id = novoCliente(antigo)
  antigo.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (?, ?, 'completa')").run(id, '4'.repeat(44))
  antigo.close()

  abrirBanco(arq).close()
  const db = abrirBanco(arq)
  assert.equal(db.prepare('SELECT modelo FROM notas').get().modelo, 'nfe')
  const c = db.prepare('SELECT nfse_ult_nsu, nfse_proxima_consulta, nfse_ultima_consulta, nfse_ultimo_erro FROM clientes').get()
  assert.deepEqual(c, { nfse_ult_nsu: '0', nfse_proxima_consulta: null, nfse_ultima_consulta: null, nfse_ultimo_erro: null })
  const indices = db.prepare("SELECT name FROM pragma_index_list('notas')").all().map((i) => i.name)
  assert.ok(indices.includes('idx_notas_cliente_modelo_comp'))
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('chave da nota é única por cliente', () => {
  const db = abrirBanco(':memory:')
  const id = novoCliente(db)
  const id2 = db.prepare(`INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc)
    VALUES ('98765432000100', 'Outro Cliente', 'CE', 'o.pfx', 'x:y:z')`).run().lastInsertRowid
  const ins = db.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (?, ?, 'resumo')")
  const chave = '2'.repeat(44)
  ins.run(id, chave)
  assert.throws(() => ins.run(id, chave), /UNIQUE/)
  ins.run(id2, chave)
})

test('banco novo nasce na versão 1 com tipo e papel', () => {
  const db = abrirBanco(':memory:')
  assert.equal(db.pragma('user_version', { simple: true }), 1)
  const id = novoCliente(db)
  db.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (?, ?, 'resumo')").run(id, '3'.repeat(44))
  assert.equal(db.prepare('SELECT tipo FROM notas').get().tipo, 'entrada')
  assert.equal(db.prepare('SELECT papel FROM clientes').get().papel, 'cliente')
})

test('só um escritório', () => {
  const db = abrirBanco(':memory:')
  const ins = db.prepare(`INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc, papel)
    VALUES (?, 'Escritório', 'CE', 'e.pfx', 'x:y:z', 'escritorio')`)
  ins.run('11111111000111')
  assert.throws(() => ins.run('22222222000122'), /UNIQUE/)
})

function bancoV0(dir, comNotas = true) {
  const arq = path.join(dir, 'nfe.db')
  const antigo = new Database(arq)
  antigo.exec(DDL_V0)
  if (comNotas) {
    antigo.prepare(`INSERT INTO clientes (id, cnpj, razao_social, uf, cert_arquivo, cert_senha_enc)
      VALUES (1, '12345678000199', 'Cliente Teste', 'CE', 'a.pfx', 'x:y:z')`).run()
    const ins = antigo.prepare(`INSERT INTO notas (cliente_id, chave, nsu, emitente_cnpj, emitente_nome, numero, serie,
      data_emissao, valor_total, tipo_nf, status, competencia) VALUES (1, ?, ?, '55555555000155', 'Fornecedor', ?, '1',
      '2026-09-10', 123.45, '0', 'completa', '2026-09')`)
    ins.run('4'.repeat(44), '000000000000001', '10')
    ins.run('5'.repeat(44), '000000000000002', '11')
    antigo.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, descricao) VALUES (?, '110111', '1', 'Cancelamento')").run('4'.repeat(44))
  }
  antigo.close()
  return arq
}

const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('nfe.db.bak-'))

test('migra banco versão 0 preservando dados e com backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = bancoV0(dir)
  const antes = new Database(arq)
  const notasAntes = antes.prepare('SELECT * FROM notas ORDER BY id').all()
  antes.close()
  const db = abrirBanco(arq)
  assert.equal(db.pragma('user_version', { simple: true }), 1)
  const notas = db.prepare('SELECT * FROM notas ORDER BY id').all()
  assert.equal(notas.length, 2)
  for (const [i, n] of notas.entries()) {
    assert.equal(n.tipo, 'entrada')
    for (const col of Object.keys(notasAntes[i])) assert.equal(n[col], notasAntes[i][col], col)
  }
  assert.equal(db.prepare('SELECT papel FROM clientes').get().papel, 'cliente')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eventos').get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_um_escritorio'").get().n, 1)
  db.close()
  const baks = backups(dir)
  assert.equal(baks.length, 1)
  const bak = new Database(path.join(dir, baks[0]), { readonly: true })
  assert.equal(bak.pragma('user_version', { simple: true }), 0)
  bak.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('migrar numa conexão atrasada, depois de outra já ter migrado, não falha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = bancoV0(dir)
  const atrasada = new Database(arq)
  assert.equal(atrasada.pragma('user_version', { simple: true }), 0)
  abrirBanco(arq).close()
  assert.doesNotThrow(() => migrar(atrasada, arq))
  assert.equal(atrasada.pragma('user_version', { simple: true }), 1)
  assert.equal(atrasada.prepare('SELECT COUNT(*) AS n FROM notas').get().n, 2)
  atrasada.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('migração não roda de novo e banco vazio não gera backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = bancoV0(dir)
  abrirBanco(arq).close()
  abrirBanco(arq).close()
  assert.equal(backups(dir).length, 1)
  fs.rmSync(dir, { recursive: true, force: true })

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq2 = bancoV0(dir2, false)
  const db = abrirBanco(arq2)
  assert.equal(db.pragma('user_version', { simple: true }), 1)
  db.close()
  assert.equal(backups(dir2).length, 0)
  fs.rmSync(dir2, { recursive: true, force: true })
})

test('falha no meio da migração desfaz tudo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-db-'))
  const arq = bancoV0(dir)
  const antigo = new Database(arq)
  antigo.exec('CREATE TABLE notas_v1 (x)')
  antigo.close()
  assert.throws(() => abrirBanco(arq), /notas_v1/)
  const db = new Database(arq)
  assert.equal(db.pragma('user_version', { simple: true }), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notas').get().n, 2)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('clientes') WHERE name = 'papel'").get().n, 0)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ult_nsu começa em 15 zeros e foreign key é respeitada', () => {
  const db = abrirBanco(':memory:')
  novoCliente(db)
  assert.equal(db.prepare('SELECT ult_nsu FROM clientes').get().ult_nsu, '000000000000000')
  assert.throws(() => db.prepare("INSERT INTO notas (cliente_id, chave, status) VALUES (999, 'x', 'resumo')").run(), /FOREIGN KEY/)
})
