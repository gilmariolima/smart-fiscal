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

const COLUNAS_NOVAS = [
  ['execucoes', 'notas_recebidas', 'INTEGER'],
  ['execucoes', 'eventos_recebidos', 'INTEGER'],
  ['notas', 'modelo', "TEXT NOT NULL DEFAULT 'nfe'"],
  ['clientes', 'nfse_ult_nsu', "TEXT NOT NULL DEFAULT '0'"],
  ['clientes', 'nfse_proxima_consulta', 'TEXT'],
  ['clientes', 'nfse_ultima_consulta', 'TEXT'],
  ['clientes', 'nfse_ultimo_erro', 'TEXT'],
  ['notas', 'captura_id', 'INTEGER'], // última execução de captura que trouxe a nota (link "Ver notas")
  ['clientes', 'tambem_cliente', 'INTEGER NOT NULL DEFAULT 0'], // escritório que também é cliente
  ['clientes', 'auto_nfe', 'INTEGER NOT NULL DEFAULT 1'], // busca automática por cliente e tipo de nota
  ['clientes', 'auto_nfse', 'INTEGER NOT NULL DEFAULT 1'],
]

// Banco de antes do captura_id: liga à última captura de cada cliente as notas criadas desde o início dela,
// para o link "Ver notas" já funcionar com a captura que está na tela.
function preencherCapturaId(db) {
  db.exec(`UPDATE notas SET captura_id = (
      SELECT e.id FROM execucoes e
      WHERE e.cliente_id = notas.cliente_id AND e.tipo = CASE notas.modelo WHEN 'nfse' THEN 'captura_nfse' ELSE 'captura' END
        AND e.fim IS NOT NULL AND e.erro IS NULL AND datetime(notas.criado_em) >= datetime(e.inicio)
      ORDER BY e.id DESC LIMIT 1)
    WHERE captura_id IS NULL`)
  // E refaz a contagem dessas capturas: notas distintas, não documentos (resumo + XML da mesma nota eram 2).
  db.exec(`UPDATE execucoes SET notas_recebidas = (SELECT COUNT(*) FROM notas WHERE notas.captura_id = execucoes.id)
    WHERE tipo IN ('captura', 'captura_nfse') AND notas_recebidas IS NOT NULL
      AND cliente_id IN (SELECT id FROM clientes WHERE papel = 'cliente')`)
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
    // Colunas novas em bancos criados antes delas (o CREATE TABLE IF NOT EXISTS não as acrescenta).
    for (const [tabela, coluna, definicao] of COLUNAS_NOVAS) {
      const existe = db.prepare(`SELECT 1 FROM pragma_table_info('${tabela}') WHERE name = ?`).get(coluna)
      if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`)
      if (!existe && coluna === 'captura_id') preencherCapturaId(db)
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_notas_cliente_modelo_comp ON notas(cliente_id, modelo, competencia)')
    db.pragma('user_version = 1')
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

module.exports = { abrirBanco, migrar }
