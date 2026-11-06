'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { organizar } = require('../electron/organizar')
const { VERSAO_XML } = require('../src/services/migracaoPastas')

function montar(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-org-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const pastaXmls = path.join(base, 'xmls')
  fs.mkdirSync(pastaXmls)
  const config = carregarConfig({
    TP_AMB: '2', MASTER_KEY: crypto.randomBytes(32).toString('hex'), SEFAZ_MOCK: '1',
    PASTA_DADOS: path.join(base, 'data'), PASTA_LOGS: path.join(base, 'logs'), PASTA_XMLS: pastaXmls,
    PASTA_CERTS: path.join(base, 'certs'), PASTA_EXPORTS: path.join(base, 'exports'),
  })
  const comBanco = (fn) => {
    const db = abrirBanco(config.caminhoBanco)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }
  return { config, pastaXmls, comBanco }
}

test('organiza em processo próprio, avisa início e andamento e, na segunda vez, não avisa', (t) => {
  const a = montar(t)
  const rel = path.join('Luna', '2026', 'Novembro', 'NF-e', 'XML', 'Entradas', '1-nfe.xml')
  fs.mkdirSync(path.dirname(path.join(a.pastaXmls, rel)), { recursive: true })
  fs.writeFileSync(path.join(a.pastaXmls, rel), '<nfe/>')
  a.comBanco((db) => {
    db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_versao', '2'), ('pastas_layout', '6')").run()
    const id = db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES ('11222333000181', 'LUNA LTDA', 'Luna', 'CE', 'x.pfx', 'a:b:c', 'cliente')").run().lastInsertRowid
    db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, '1', 'completa', '2026-11', ?)").run(id, rel)
  })

  const avisos = []
  let relogio = 0
  organizar({ config: a.config, avisar: (x) => avisos.push(x), agora: () => (relogio += 1000) })

  assert.deepEqual(avisos[0], { tipo: 'inicio' })
  assert.ok(avisos.some((x) => x.tipo === 'andamento' && x.movidos >= 1))
  const novo = path.join('Luna', '2026', '11-Novembro', 'NF-e', 'Entradas', 'XML', '1-nfe.xml')
  assert.ok(fs.existsSync(path.join(a.pastaXmls, novo)))
  a.comBanco((db) => {
    assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, novo)
    assert.equal(db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(), VERSAO_XML)
  })

  const depois = []
  organizar({ config: a.config, avisar: (x) => depois.push(x) })
  assert.deepEqual(depois, [], 'nada a organizar: nem janela')
})

test('instalação nova, sem notas: não abre janela de andamento', (t) => {
  const a = montar(t)
  const avisos = []
  organizar({ config: a.config, avisar: (x) => avisos.push(x) })
  assert.deepEqual(avisos, [])
})
