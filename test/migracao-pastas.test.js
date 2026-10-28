'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarPastas } = require('../src/services/migracaoPastas')

const silencioso = { info() {}, warn() {}, error() {} }
const INOX = '12138481000185'
const ESCRITORIO = '01904741000160'
// cUF + AAMM + CNPJ emitente + mod + série + nNF + tpEmis + cNF + DV = 44
const chaveNfe = (cnpj, n) => `232610${cnpj}55001${String(n).padStart(9, '0')}1${'5'.repeat(8)}9`
const SAIDA = chaveNfe(INOX, 15737)
const RESUMO = chaveNfe('34950246000146', 190073)
const EVENTO_SEM_NOTA = chaveNfe(INOX, 15738)
const FORA = chaveNfe('55555555000155', 1)

function montar() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-mig-'))
  const db = abrirBanco(':memory:')
  const ins = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES (?, ?, ?, 'CE', 'x.pfx', 'a:b:c', ?)`)
  const idInox = ins.run(INOX, 'INOX LTDA', 'INOX', 'cliente').lastInsertRowid
  ins.run(ESCRITORIO, 'SM SMART', 'escritorio', 'escritorio')

  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const antigos = {
    saida: gravar(path.join(`${INOX}_INOX`, '2026-10', `${SAIDA}-nfe.xml`), '<saida/>'),
    resumo: gravar(path.join(`${INOX}_INOX`, '2026-10', `${RESUMO}-resumo.xml`)),
    evento: gravar(path.join(`${INOX}_INOX`, '2026-10', `${EVENTO_SEM_NOTA}-evento-210210-1.xml`)),
    fora: gravar(path.join(`${ESCRITORIO}_escritorio`, 'fora-da-carteira', '2026-10', `${FORA}-nfe.xml`)),
    estranho: gravar(path.join(`${INOX}_INOX`, '2026-10', 'leia-me.txt')),
  }
  db.prepare(`INSERT INTO notas (cliente_id, chave, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'saida', 'completa', '2026-10', ?)`).run(idInox, SAIDA, antigos.saida)
  db.prepare(`INSERT INTO notas (cliente_id, chave, tipo, status, competencia) VALUES (?, ?, 'entrada', 'resumo', '2026-10')`).run(idInox, RESUMO)
  db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '210210', '1', ?)`).run(EVENTO_SEM_NOTA, antigos.evento)
  const limpar = () => fs.rmSync(pastaXmls, { recursive: true, force: true })
  return { db, pastaXmls, antigos, limpar }
}

const novo = {
  saida: path.join(`${INOX}_INOX`, '2026', '10', 'NF-e', 'Saidas', `${SAIDA}-nfe.xml`),
  resumo: path.join(`${INOX}_INOX`, '2026', '10', 'NF-e', 'Entradas', 'Resumos', `${RESUMO}-resumo.xml`),
  evento: path.join(`${INOX}_INOX`, '2026', '10', 'NF-e', 'Saidas', 'Eventos', `${EVENTO_SEM_NOTA}-evento-210210-1.xml`),
  fora: path.join(`${ESCRITORIO}_escritorio`, 'fora-da-carteira', '2026', '10', 'NF-e', 'Entradas', `${FORA}-nfe.xml`),
}
const versao = (db) => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_versao'").get()?.valor

test('move tudo e atualiza os caminhos', (t) => {
  const { db, pastaXmls, antigos, limpar } = montar()
  t.after(limpar)
  const r = migrarPastas({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 4)
  for (const rel of Object.values(novo)) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
  assert.equal(fs.readFileSync(path.join(pastaXmls, novo.saida), 'utf8'), '<saida/>')
  assert.equal(db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(SAIDA).caminho_xml, novo.saida)
  assert.equal(db.prepare('SELECT caminho_xml FROM eventos WHERE chave = ?').get(EVENTO_SEM_NOTA).caminho_xml, novo.evento)
  assert.ok(!fs.existsSync(path.join(pastaXmls, `${ESCRITORIO}_escritorio`, 'fora-da-carteira', '2026-10')), 'pasta antiga vazia removida')
  assert.deepEqual(r.ignorados, [antigos.estranho])
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.estranho)), 'arquivo fora do padrão fica onde está')
  assert.equal(versao(db), '2')
})

test('segunda chamada não faz nada', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  migrarPastas({ db, pastaXmls, logger: silencioso })
  assert.equal(migrarPastas({ db, pastaXmls, logger: silencioso }).movidos, 0)
})

test('retoma depois de interrupção: destino já existe com o mesmo conteúdo', (t) => {
  const { db, pastaXmls, antigos, limpar } = montar()
  t.after(limpar)
  fs.mkdirSync(path.dirname(path.join(pastaXmls, novo.saida)), { recursive: true })
  fs.copyFileSync(path.join(pastaXmls, antigos.saida), path.join(pastaXmls, novo.saida))
  migrarPastas({ db, pastaXmls, logger: silencioso })
  assert.ok(!fs.existsSync(path.join(pastaXmls, antigos.saida)), 'cópia antiga apagada')
  assert.equal(db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(SAIDA).caminho_xml, novo.saida)
})

test('arquivo travado fica pendente e a próxima chamada termina', (t) => {
  const { db, pastaXmls, antigos, limpar } = montar()
  t.after(limpar)
  const travado = path.join(pastaXmls, antigos.saida)
  const fsOps = {
    renameSync(de, para) {
      if (de === travado) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return fs.renameSync(de, para)
    },
  }
  const r = migrarPastas({ db, pastaXmls, logger: silencioso, fsOps })
  assert.deepEqual(r.pendentes, [antigos.saida])
  assert.equal(versao(db), undefined)
  assert.equal(db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(SAIDA).caminho_xml, antigos.saida)

  const r2 = migrarPastas({ db, pastaXmls, logger: silencioso })
  assert.equal(r2.movidos, 1)
  assert.equal(versao(db), '2')
  assert.equal(db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(SAIDA).caminho_xml, novo.saida)
})

test('criarContexto move os XMLs antigos ao abrir', (t) => {
  const crypto = require('node:crypto')
  const { criarContexto } = require('../src/contexto')
  const { carregarConfig } = require('../src/config')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-mig-ctx-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const pastaXmls = path.join(base, 'xmls')
  const antigo = path.join(pastaXmls, `${INOX}_INOX`, '2026-10', `${SAIDA}-nfe.xml`)
  fs.mkdirSync(path.dirname(antigo), { recursive: true })
  fs.writeFileSync(antigo, '<saida/>')
  const env = {
    MASTER_KEY: crypto.randomBytes(32).toString('hex'), SEFAZ_MOCK: '1', PASTA_BACKUP: '',
    PASTA_DADOS: path.join(base, 'data'), PASTA_LOGS: path.join(base, 'logs'), PASTA_XMLS: pastaXmls,
    PASTA_CERTS: path.join(base, 'certs'), PASTA_EXPORTS: path.join(base, 'exports'),
  }
  const ctx = criarContexto({ config: carregarConfig(env), logger: silencioso, db: abrirBanco(':memory:') })
  assert.ok(!fs.existsSync(antigo))
  assert.ok(fs.existsSync(path.join(pastaXmls, `${INOX}_INOX`, '2026', '10', 'NF-e', 'Saidas', `${SAIDA}-nfe.xml`)))
  assert.equal(versao(ctx.db), '2')
})

test('I1: o banco já aponta para o caminho novo quando o arquivo é movido', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const vistos = []
  const fsOps = {
    renameSync(de, para) {
      if (de.endsWith(`${SAIDA}-nfe.xml`)) vistos.push(db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(SAIDA).caminho_xml)
      return fs.renameSync(de, para)
    },
  }
  migrarPastas({ db, pastaXmls, logger: silencioso, fsOps })
  assert.deepEqual(vistos, [novo.saida], 'se o app cair logo depois do rename, o banco já está certo')
})

test('I2: pasta de XMLs indisponível com notas no banco não marca a mudança como feita', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const r = migrarPastas({ db, pastaXmls: path.join(pastaXmls, 'unidade-desconectada'), logger: silencioso })
  assert.equal(r.movidos, 0)
  assert.equal(versao(db), undefined)
  const vazio = abrirBanco(':memory:')
  migrarPastas({ db: vazio, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso })
  assert.equal(versao(vazio), '2', 'banco sem XML nenhum: nada a migrar')
})

test('I3: erro inesperado não impede a abertura e não marca a mudança como feita', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const erros = []
  const fsOps = { readdirSync: () => { throw new Error('EACCES: permission denied') } }
  assert.doesNotThrow(() => migrarPastas({ db, pastaXmls, logger: { ...silencioso, error: (m) => erros.push(m) }, fsOps }))
  assert.equal(versao(db), undefined)
  assert.equal(erros.length, 1)
})

test('I4: pasta antiga sem-data também é migrada', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const antigo = path.join(`${INOX}_INOX`, 'sem-data', `${RESUMO}-resumo.xml`)
  fs.mkdirSync(path.join(pastaXmls, path.dirname(antigo)), { recursive: true })
  fs.writeFileSync(path.join(pastaXmls, antigo), '<r/>')
  migrarPastas({ db, pastaXmls, logger: silencioso })
  assert.ok(fs.existsSync(path.join(pastaXmls, `${INOX}_INOX`, 'sem-data', 'NF-e', 'Entradas', 'Resumos', `${RESUMO}-resumo.xml`)))
  assert.ok(!fs.existsSync(path.join(pastaXmls, antigo)))
})

test('C1: muitos arquivos e banco grande migram em poucos segundos', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const idInox = db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(INOX).id
  const insNota = db.prepare("INSERT INTO notas (cliente_id, chave, tipo, status, competencia, caminho_xml) VALUES (?, ?, 'entrada', 'completa', '2026-09', ?)")
  const insEvento = db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '210210', '1', ?)")
  const pasta = path.join(pastaXmls, `${INOX}_INOX`, '2026-09')
  fs.mkdirSync(pasta, { recursive: true })
  db.transaction(() => {
    for (let i = 0; i < 20000; i++) {
      const chave = chaveNfe('34950246000146', 300000 + i)
      const rel = path.join(`${INOX}_INOX`, '2026-09', `${chave}-nfe.xml`)
      insNota.run(idInox, chave, rel)
      insEvento.run(chave, `outro/${i}.xml`)
      if (i < 2000) fs.writeFileSync(path.join(pastaXmls, rel), '<x/>')
    }
  })()
  const inicio = Date.now()
  const r = migrarPastas({ db, pastaXmls, logger: silencioso })
  const ms = Date.now() - inicio
  assert.ok(r.movidos >= 2000)
  assert.ok(ms < 8000, `levou ${ms} ms (antes da correção: ~13 s só)`)
})
