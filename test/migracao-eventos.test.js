'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutEventos, migrarLayoutSemCliente, migrarLayouts, VERSAO_XML } = require('../src/services/migracaoPastas')
const { caminhoDa, caminhoDoPdf, caminhoDoResumo, comAvulsosNoLugar, foraDoFormatoAtual } = require('../src/services/armazenamento')

const silencioso = { info() {}, warn() {}, error() {} }
const p = (...partes) => path.join(...partes)
const MES = p('Luna', '2026', '11-Novembro')
const AVULSOS = p(MES, 'Eventos e Resumos')

function montar(t, { versao = '8' } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-ev-'))
  const db = abrirBanco(':memory:')
  t.after(() => {
    db.close()
    fs.rmSync(pastaXmls, { recursive: true, force: true })
  })
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_versao', '2'), ('pastas_layout', ?)").run(versao)
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const evento = (rel, chave = 'c') => db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '210210', '1', ?)").run(chave, rel)
  return {
    db,
    pastaXmls,
    gravar,
    evento,
    migrar: (fsOps) => migrarLayoutEventos({ db, pastaXmls, logger: silencioso, fsOps }),
    existe: (...r) => fs.existsSync(path.join(pastaXmls, ...r)),
    ler: (...r) => fs.readFileSync(path.join(pastaXmls, ...r), 'utf8'),
    caminhoEvento: (chave = 'c') => db.prepare('SELECT caminho_xml c FROM eventos WHERE chave = ?').get(chave).c,
    versao: () => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(),
  }
}

test('caminho novo: evento e resumo juntos, fora de entradas e saídas', () => {
  const cliente = { cnpj: '11222333000181', apelido: 'Luna' }
  const base = { cliente, competencia: '2026-11', nomeArquivo: 'x.xml' }
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'saida', categoria: 'evento' }), p(AVULSOS, 'NF-e', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfse', direcao: 'entrada', categoria: 'evento' }), p(AVULSOS, 'NFS-e', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', categoria: 'resumo' }), p(AVULSOS, 'NF-e', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'saida' }), p(MES, 'Saidas', 'NF-e', 'XML', 'x.xml'))
  assert.equal(caminhoDa({ cliente, competencia: null, modelo: 'cte', categoria: 'evento', nomeArquivo: 'x.xml' }), p('Luna', 'sem-data', 'Eventos e Resumos', 'CT-e', 'x.xml'))
  assert.equal(caminhoDoResumo(p(MES, 'Entradas', 'NF-e', 'XML', '1-nfe.xml')), p(AVULSOS, 'NF-e', '1-resumo.xml'))
  assert.equal(caminhoDoPdf(p(AVULSOS, 'NF-e', '1-evento-110111-1.xml')), null)
})

test('comAvulsosNoLugar e formato atual', () => {
  assert.equal(comAvulsosNoLugar('L\\2026\\11-Novembro\\Saidas\\NF-e\\XML\\Eventos\\a.xml'), 'L\\2026\\11-Novembro\\Eventos e Resumos\\NF-e\\a.xml')
  assert.equal(comAvulsosNoLugar('L/sem-data/Entradas/CT-e/XML/Resumos/a.xml'), 'L/sem-data/Eventos e Resumos/CT-e/a.xml')
  assert.equal(comAvulsosNoLugar('L/2026/11-Novembro/Entradas/NF-e/XML/a.xml'), 'L/2026/11-Novembro/Entradas/NF-e/XML/a.xml')
  assert.ok(foraDoFormatoAtual('L/2026/11-Novembro/Entradas/NF-e/XML/Resumos/a.xml'))
  assert.ok(!foraDoFormatoAtual('L/2026/11-Novembro/Eventos e Resumos/NF-e/a.xml'))
  assert.ok(!foraDoFormatoAtual('L/2026/11-Novembro/Entradas/NF-e/XML/a.xml'))
})

test('junta eventos e resumos de entradas e saídas, o banco acompanha, e as notas ficam', (t) => {
  const a = montar(t)
  a.evento(a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'Eventos', 'c-evento.xml'), '<c/>'))
  a.evento(a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'd-evento.xml'), '<d/>'), 'd')
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'Resumos', 'e-resumo.xml'))
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  a.gravar(p('Luna', 'sem-data', 'Saidas', 'CT-e', 'XML', 'Eventos', 'f-evento.xml'))

  const r = a.migrar()

  assert.deepEqual(r.pendentes, [])
  assert.equal(VERSAO_XML, '10')
  assert.equal(a.versao(), '9')
  assert.equal(a.ler(AVULSOS, 'NF-e', 'c-evento.xml'), '<c/>')
  assert.equal(a.ler(AVULSOS, 'NF-e', 'd-evento.xml'), '<d/>')
  assert.ok(a.existe(AVULSOS, 'NF-e', 'e-resumo.xml'))
  assert.ok(a.existe('Luna', 'sem-data', 'Eventos e Resumos', 'CT-e', 'f-evento.xml'))
  assert.ok(a.existe(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  assert.ok(!a.existe(MES, 'Saidas'), 'pasta só com eventos some')
  assert.ok(!a.existe(MES, 'Entradas', 'NF-e', 'XML', 'Eventos'))
  assert.equal(a.caminhoEvento(), p(AVULSOS, 'NF-e', 'c-evento.xml'))
  assert.equal(a.caminhoEvento('d'), p(AVULSOS, 'NF-e', 'd-evento.xml'))
})

test('mesmo nome nos dois lados com o mesmo conteúdo: um só; com outro conteúdo: mantém os dois e fica pendente', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'Eventos', 'c.xml'), '<igual/>')
  a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml'), '<igual/>')
  const antigo = a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'd.xml'), '<outro/>')
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'Eventos', 'd.xml'), '<um/>')
  const r = a.migrar()
  assert.ok(!a.existe(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml'))
  assert.equal(a.ler(AVULSOS, 'NF-e', 'c.xml'), '<igual/>')
  assert.deepEqual(r.pendentes, [antigo])
  assert.equal(a.ler(antigo), '<outro/>')
  assert.equal(a.ler(AVULSOS, 'NF-e', 'd.xml'), '<um/>')
  assert.equal(a.versao(), '8')
})

test('app caiu entre mover e gravar o banco: a próxima abertura só aponta o banco', (t) => {
  const a = montar(t)
  a.gravar(p(AVULSOS, 'NF-e', 'c-evento.xml'))
  a.evento(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c-evento.xml'))
  assert.deepEqual(a.migrar().pendentes, [])
  assert.equal(a.caminhoEvento(), p(AVULSOS, 'NF-e', 'c-evento.xml'))
})

test('rodar de novo não faz nada; versão mais antiga que 5 não é tocada; a sequência chega à atual', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml'))
  a.migrar()
  assert.equal(a.migrar().movidos, 0)

  const b = montar(t, { versao: '4' })
  b.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml'))
  b.migrar()
  assert.equal(b.versao(), '4')
  assert.ok(b.existe(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml'))

  const c = montar(t, { versao: '7' })
  c.gravar(p(MES, 'NF-e', 'XML', 'Saidas', 'Eventos', 'c.xml'))
  migrarLayouts({ db: c.db, pastaXmls: c.pastaXmls, logger: silencioso })
  assert.equal(c.versao(), VERSAO_XML)
  assert.ok(c.existe(AVULSOS, 'NF-e', 'c.xml'))
  assert.ok(!c.existe(MES, 'Saidas'))
})

test('com etapa anterior pendente, move e não grava a versão', (t) => {
  const a = montar(t, { versao: '7' })
  a.evento(a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'Eventos', 'c.xml')))
  a.migrar()
  assert.equal(a.versao(), '7')
  assert.equal(a.caminhoEvento(), p(AVULSOS, 'NF-e', 'c.xml'))
})

// ---------- nome novo da pasta ----------

test('fora-da-carteira vira Sem cliente cadastrado, com o banco', (t) => {
  const a = montar(t, { versao: '9' })
  const antigo = a.gravar(p('Luna', 'fora-da-carteira', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<a/>')
  a.evento(antigo)
  const r = migrarLayoutSemCliente({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })
  assert.deepEqual(r.pendentes, [])
  const novo = p('Luna', 'Sem cliente cadastrado', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'a-nfe.xml')
  assert.equal(a.ler(novo), '<a/>')
  assert.ok(!a.existe('Luna', 'fora-da-carteira'))
  assert.equal(a.caminhoEvento(), novo)
  assert.equal(a.versao(), VERSAO_XML)
  assert.equal(VERSAO_XML, '10')
})

test('sem a pasta antiga, só grava a versão; com etapa anterior pendente, renomeia e não grava', (t) => {
  const a = montar(t, { versao: '9' })
  a.gravar(p('Luna', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  migrarLayoutSemCliente({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })
  assert.equal(a.versao(), VERSAO_XML)

  const b = montar(t, { versao: '8' })
  b.gravar(p('Luna', 'fora-da-carteira', 'x.xml'))
  migrarLayoutSemCliente({ db: b.db, pastaXmls: b.pastaXmls, logger: silencioso })
  assert.equal(b.versao(), '8')
  assert.ok(b.existe('Luna', 'Sem cliente cadastrado', 'x.xml'))
})

test('a sequência inteira leva fora-da-carteira do formato anterior até o nome novo', (t) => {
  const a = montar(t, { versao: '7' })
  a.gravar(p('Luna', 'fora-da-carteira', '2026', '11-Novembro', 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'))
  migrarLayouts({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })
  assert.equal(a.versao(), VERSAO_XML)
  assert.ok(a.existe('Luna', 'Sem cliente cadastrado', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
})
