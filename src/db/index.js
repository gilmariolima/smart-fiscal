'use strict'

const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const MIGRATIONS = path.join(__dirname, 'migrations.sql')

const COLUNAS_ANTIGAS = [
  'id', 'cliente_id', 'chave', 'nsu', 'emitente_cnpj', 'emitente_nome', 'emitente_ie', 'numero', 'serie',
  'data_emissao', 'valor_total', 'tipo_nf', 'situacao_sefaz', 'status', 'cancelada', 'ciencia_protocolo',
  'ciencia_em', 'ciencia_erro', 'tentativas_download', 'caminho_xml', 'competencia', 'exportada_em', 'criado_em',
  'atualizado_em'
]

const DDL_NOTAS_V1 = `CREATE TABLE notas_v1 (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  chave TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'entrada',
  nsu TEXT,
  emitente_cnpj TEXT,
  emitente_nome TEXT,
  emitente_ie TEXT,
  destinatario_cnpj TEXT,
  destinatario_nome TEXT,
  numero TEXT,
  serie TEXT,
  data_emissao TEXT,
  valor_total REAL,
  tipo_nf TEXT,
  situacao_sefaz TEXT,
  status TEXT NOT NULL,
  cancelada INTEGER NOT NULL DEFAULT 0,
  ciencia_protocolo TEXT,
  ciencia_em TEXT,
  ciencia_erro TEXT,
  tentativas_download INTEGER NOT NULL DEFAULT 0,
  caminho_xml TEXT,
  competencia TEXT,
  exportada_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT,
  UNIQUE(cliente_id, chave)
)`

function carimbo() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** Migra um banco versão 0 para a versão 1 (tipo da nota, papel do cliente, chave única por cliente). */
function migrar(db, caminho) {
  if (caminho && caminho !== ':memory:' && db.prepare('SELECT COUNT(*) AS n FROM notas').get().n > 0) {
    try {
      db.exec(`VACUUM INTO '${`${path.resolve(caminho)}.bak-${carimbo()}`.replace(/'/g, "''")}'`)
    } catch (e) {
      // Outro processo migrando no mesmo instante já fez a cópia (mesmo nome); não é motivo para falhar.
      if (!/already exists/i.test(e.message)) throw e
    }
  }
  const cols = COLUNAS_ANTIGAS.join(', ')
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      // Dentro do lock de escrita: outro processo pode ter migrado entre a checagem e aqui.
      if (db.prepare("SELECT 1 FROM pragma_table_info('notas') WHERE name = 'tipo'").get()) return
      db.exec("ALTER TABLE clientes ADD COLUMN papel TEXT NOT NULL DEFAULT 'cliente'")
      db.exec(DDL_NOTAS_V1)
      db.exec(`INSERT INTO notas_v1 (${cols}) SELECT ${cols} FROM notas`)
      db.exec('DROP TABLE notas')
      db.exec('ALTER TABLE notas_v1 RENAME TO notas')
      db.exec('CREATE INDEX idx_notas_cliente_comp ON notas(cliente_id, competencia)')
      db.exec('CREATE INDEX idx_notas_status ON notas(status)')
      db.pragma('user_version = 1')
    }).immediate()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/** Abre (ou cria) o banco, aplica as migrations e devolve a conexão. Use ':memory:' em testes. */
function abrirBanco(caminho) {
  if (caminho !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(caminho)), { recursive: true })
  const db = new Database(caminho)
  try {
    if (caminho !== ':memory:') db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    if (db.pragma('user_version', { simple: true }) === 0) {
      const colunas = db.prepare("SELECT name FROM pragma_table_info('notas')").all().map((c) => c.name)
      if (colunas.length > 0 && !colunas.includes('tipo')) migrar(db, caminho)
    }
    db.exec(fs.readFileSync(MIGRATIONS, 'utf8'))
    db.pragma('user_version = 1')
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

module.exports = { abrirBanco, migrar }
