'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutDirecao, migrarLayouts, VERSAO_XML } = require('../src/services/migracaoPastas')
const { caminhoDa, pastaDoGrupo, caminhoDoPdf, comDirecaoAntesDoTipo, foraDoFormatoAtual } = require('../src/services/armazenamento')

const silencioso = { info() {}, warn() {}, error() {} }
const p = (...partes) => path.join(...partes)
const MES = p('Luna', '2026', '11-Novembro')
const ocupado = (code = 'EBUSY') => () => {
  throw Object.assign(new Error(code), { code })
}

function montar(t, { versao = '7' } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-dir-'))
  const db = abrirBanco(':memory:')
  t.after(() => {
    db.close()
    fs.rmSync(pastaXmls, { recursive: true, force: true })
  })
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_versao', '2'), ('pastas_layout', ?)").run(versao)
  const id = Number(db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES ('11222333000181', 'LUNA LTDA', 'Luna', 'CE', 'x.pfx', 'a:b:c', 'cliente')").run().lastInsertRowid)
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const nota = (rel, chave = 'a') => db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, ?, 'completa', '2026-11', ?)").run(id, chave, rel)
  return {
    db,
    pastaXmls,
    gravar,
    nota,
    migrar: (fsOps) => migrarLayoutDirecao({ db, pastaXmls, logger: silencioso, fsOps }),
    existe: (...r) => fs.existsSync(path.join(pastaXmls, ...r)),
    ler: (...r) => fs.readFileSync(path.join(pastaXmls, ...r), 'utf8'),
    caminho: (chave = 'a') => db.prepare('SELECT caminho_xml c FROM notas WHERE chave = ?').get(chave).c,
    versao: () => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(),
  }
}

test('caminho novo: empresa, ano, mês, direção, tipo', () => {
  const cliente = { cnpj: '11222333000181', apelido: 'Luna' }
  const base = { cliente, competencia: '2026-11', nomeArquivo: 'x.xml' }
  assert.equal(pastaDoGrupo({ cliente, competencia: '2026-11', modelo: 'nfe', direcao: 'saida' }), p(MES, 'NF-e', 'Saidas'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada' }), p(MES, 'NF-e', 'Entradas', 'XML', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'cte', direcao: 'outro' }), p(MES, 'CT-e', 'Outros', 'XML', 'x.xml'))
  assert.equal(caminhoDa({ cliente, competencia: null, modelo: 'nfe', direcao: 'entrada', nomeArquivo: 'x.xml' }), p('Luna', 'sem-data', 'NF-e', 'Entradas', 'XML', 'x.xml'))
  assert.equal(caminhoDoPdf(p(MES, 'NF-e', 'Saidas', 'XML', '1-nfe.xml')), p(MES, 'NF-e', 'Saidas', 'PDF', '1-nfe.pdf'))
  assert.equal(caminhoDoPdf(p(MES, 'NF-e', 'Saidas', 'XML', 'Eventos', '1.xml')), null)
})

test('comDirecaoAntesDoTipo troca a ordem e mantém a barra', () => {
  assert.equal(comDirecaoAntesDoTipo('L\\2026\\11-Novembro\\NF-e\\XML\\Saidas\\Eventos\\a.xml'), 'L\\2026\\11-Novembro\\Saidas\\NF-e\\XML\\Eventos\\a.xml')
  assert.equal(comDirecaoAntesDoTipo('L/sem-data/CT-e/XML/Outros/a.xml'), 'L/sem-data/Outros/CT-e/XML/a.xml')
  assert.equal(comDirecaoAntesDoTipo('L/2026/11-Novembro/Saidas/NF-e/XML/a.xml'), 'L/2026/11-Novembro/Saidas/NF-e/XML/a.xml')
  assert.ok(foraDoFormatoAtual('L/2026/11-Novembro/NF-e/XML/Saidas/a.xml'))
  assert.ok(foraDoFormatoAtual('L/2026/Novembro/NF-e/Saidas/XML/a.xml'))
  assert.ok(!foraDoFormatoAtual('L\\2026\\11-Novembro\\NF-e\\Saidas\\XML\\a.xml'))
})

test('muda a ordem de XML e PDF, o banco acompanha, os PDFs são aproveitados e relatório e ZIP antigos saem', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'), '<nfe/>'))
  a.nota(a.gravar(p(MES, 'NF-e', 'XML', 'Saidas', 'b-nfe.xml')), 'b')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '210210', '1', ?)").run(a.gravar(p(MES, 'NF-e', 'XML', 'Saidas', 'Eventos', 'c-evento.xml')))
  a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'Resumos', 'd-resumo.xml'))
  a.gravar(p(MES, 'NF-e', 'PDF', 'Entradas', 'a-nfe.pdf'), 'pdf')
  a.gravar(p(MES, 'NF-e', 'Relatorio NF-e Novembro 2026.xlsx'))
  a.gravar(p(MES, 'NF-e', 'Relatorio NF-e Novembro 2026.pdf'))
  a.gravar(p(MES, 'NF-e', 'Luna NF-e Novembro 2026.zip'))
  a.gravar(p('Luna', 'sem-data', 'CT-e', 'XML', 'Outros', 'e-cte.xml'))
  a.gravar(p('Luna', 'fora-da-carteira', '2026', '10-Outubro', 'NF-e', 'XML', 'Entradas', 'f-nfe.xml'))

  const r = a.migrar()

  assert.deepEqual(r.pendentes, [])
  assert.equal(a.versao(), '8')
  assert.equal(VERSAO_XML, '11')
  assert.equal(a.ler(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<nfe/>')
  assert.ok(a.existe(MES, 'Saidas', 'NF-e', 'XML', 'b-nfe.xml'))
  assert.ok(a.existe(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c-evento.xml'))
  assert.ok(a.existe(MES, 'Entradas', 'NF-e', 'XML', 'Resumos', 'd-resumo.xml'))
  assert.equal(a.ler(MES, 'Entradas', 'NF-e', 'PDF', 'a-nfe.pdf'), 'pdf')
  assert.ok(a.existe('Luna', 'sem-data', 'Outros', 'CT-e', 'XML', 'e-cte.xml'))
  assert.ok(a.existe('Luna', 'fora-da-carteira', '2026', '10-Outubro', 'Entradas', 'NF-e', 'XML', 'f-nfe.xml'))
  assert.ok(!a.existe(MES, 'NF-e'), 'a pasta antiga do tipo some, com relatório e ZIP misturados')
  assert.equal(a.caminho(), p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  assert.equal(a.caminho('b'), p(MES, 'Saidas', 'NF-e', 'XML', 'b-nfe.xml'))
  assert.equal(a.db.prepare('SELECT caminho_xml c FROM eventos').get().c, p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c-evento.xml'))
})

test('uma operação por pasta, sem mexer arquivo a arquivo', (t) => {
  const a = montar(t)
  for (let i = 0; i < 20; i++) {
    a.nota(a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', `${i}-nfe.xml`)), String(i))
    a.gravar(p(MES, 'NF-e', 'PDF', 'Entradas', `${i}-nfe.pdf`))
  }
  let renomeados = 0
  a.migrar({ renameSync: (...x) => (renomeados++, fs.renameSync(...x)) })
  assert.equal(renomeados, 2, 'XML e PDF')
})

test('app caiu entre mover e gravar o banco: a próxima abertura só aponta o banco', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  a.nota(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'))
  assert.deepEqual(a.migrar().pendentes, [])
  assert.equal(a.caminho(), p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  assert.equal(a.versao(), '8')
})

test('pasta em uso: vai arquivo a arquivo; o preso fica pendente e sai depois', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml')))
  a.gravar(p(MES, 'NF-e', 'PDF', 'Entradas', 'a-nfe.pdf'))
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (c) => {
    if (String(c).endsWith('a-nfe.pdf')) ocupado()()
    return unlink(c)
  })
  const r = a.migrar({ renameSync: ocupado() })
  assert.deepEqual(r.pendentes, [p(MES, 'NF-e', 'PDF', 'Entradas', 'a-nfe.pdf')])
  assert.equal(a.versao(), '7')
  assert.equal(a.caminho(), p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  t.mock.restoreAll()
  assert.deepEqual(a.migrar().pendentes, [])
  assert.equal(a.versao(), '8')
  assert.ok(!a.existe(MES, 'NF-e'))
})

test('nova já existe: junta, e XML diferente mantém os dois e fica pendente', (t) => {
  const a = montar(t)
  const antigo = a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'), '<antes/>')
  a.nota(antigo)
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<depois/>')
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'b-nfe.xml'))
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [antigo])
  assert.equal(a.ler(antigo), '<antes/>')
  assert.equal(a.ler(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<depois/>')
  assert.equal(a.caminho(), antigo)
  assert.equal(a.versao(), '7')
})

test('arquivo que não é do app fica onde está', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'NF-e', 'leia-me.txt'))
  a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'))
  a.migrar()
  assert.ok(a.existe(MES, 'NF-e', 'leia-me.txt'))
  assert.equal(a.versao(), '8')
})

test('com etapa anterior pendente, muda a ordem e não grava a versão; depois chega à atual', (t) => {
  const a = montar(t, { versao: '6' })
  a.nota(a.gravar(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml')))
  a.migrar()
  assert.equal(a.versao(), '6')
  assert.equal(a.caminho(), p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  migrarLayouts({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })
  assert.equal(a.versao(), VERSAO_XML)
})

test('pasta fora do ar com notas no banco: nada muda', (t) => {
  const a = montar(t)
  a.nota(p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'))
  migrarLayoutDirecao({ db: a.db, pastaXmls: path.join(a.pastaXmls, 'sumiu'), logger: silencioso })
  assert.equal(a.caminho(), p(MES, 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'))
  assert.equal(a.versao(), '7')
})
