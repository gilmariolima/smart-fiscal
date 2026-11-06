'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutTipoPrimeiro, migrarLayouts, VERSAO_XML } = require('../src/services/migracaoPastas')
const { caminhoDa, pastaDoGrupo, caminhoDoPdf, caminhoDoResumo, comTipoPrimeiro, foraDoFormatoAtual } = require('../src/services/armazenamento')

const silencioso = { info() {}, warn() {}, error() {} }
const p = (...partes) => path.join(...partes)
const MES = p('Luna', '2026', '11-Novembro')

function montar(t, { versao = '10' } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-tipo-'))
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
  return {
    db,
    pastaXmls,
    gravar,
    nota: (rel, chave = 'a') => db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, ?, 'completa', '2026-11', ?)").run(id, chave, rel),
    evento: (rel) => db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '210210', '1', ?)").run(rel),
    migrar: (fsOps) => migrarLayoutTipoPrimeiro({ db, pastaXmls, logger: silencioso, fsOps }),
    existe: (...r) => fs.existsSync(path.join(pastaXmls, ...r)),
    ler: (...r) => fs.readFileSync(path.join(pastaXmls, ...r), 'utf8'),
    caminho: () => db.prepare('SELECT caminho_xml c FROM notas').get().c,
    caminhoEvento: () => db.prepare('SELECT caminho_xml c FROM eventos').get().c,
    versao: () => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(),
  }
}

test('caminho novo: tipo primeiro, com entradas, saídas e eventos e resumos dentro dele', () => {
  const cliente = { cnpj: '11222333000181', apelido: 'Luna' }
  const base = { cliente, competencia: '2026-11', nomeArquivo: 'x.xml' }
  assert.equal(pastaDoGrupo({ cliente, competencia: '2026-11', modelo: 'nfe', direcao: 'saida' }), p(MES, 'NF-e', 'Saidas'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada' }), p(MES, 'NF-e', 'Entradas', 'XML', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'cte', direcao: 'outro' }), p(MES, 'CT-e', 'Outros', 'XML', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfse', direcao: 'saida', categoria: 'evento' }), p(MES, 'NFS-e', 'Eventos e Resumos', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', categoria: 'resumo' }), p(MES, 'NF-e', 'Eventos e Resumos', 'x.xml'))
  assert.equal(caminhoDa({ cliente, competencia: null, modelo: 'cte', direcao: 'saida', nomeArquivo: 'x.xml' }), p('Luna', 'sem-data', 'CT-e', 'Saidas', 'XML', 'x.xml'))
  assert.equal(caminhoDoPdf(p(MES, 'NF-e', 'Saidas', 'XML', '1-nfe.xml')), p(MES, 'NF-e', 'Saidas', 'PDF', '1-nfe.pdf'))
  assert.equal(caminhoDoPdf(p(MES, 'NF-e', 'Eventos e Resumos', '1-resumo.xml')), null)
  assert.equal(caminhoDoResumo(p(MES, 'NF-e', 'Entradas', 'XML', '1-nfe.xml')), p(MES, 'NF-e', 'Eventos e Resumos', '1-resumo.xml'))
})

test('comTipoPrimeiro troca a ordem, mantém a barra e não mexe no formato atual', () => {
  assert.equal(comTipoPrimeiro('L\\2026\\11-Novembro\\Saidas\\NF-e\\XML\\a.xml'), 'L\\2026\\11-Novembro\\NF-e\\Saidas\\XML\\a.xml')
  assert.equal(comTipoPrimeiro('L/2026/11-Novembro/Eventos e Resumos/CT-e/a.xml'), 'L/2026/11-Novembro/CT-e/Eventos e Resumos/a.xml')
  assert.equal(comTipoPrimeiro('L/2026/11-Novembro/NF-e/Saidas/XML/a.xml'), 'L/2026/11-Novembro/NF-e/Saidas/XML/a.xml')
  assert.equal(comTipoPrimeiro('L/2026/11-Novembro/NF-e/Eventos e Resumos/a.xml'), 'L/2026/11-Novembro/NF-e/Eventos e Resumos/a.xml')
  assert.ok(foraDoFormatoAtual('L/2026/11-Novembro/Saidas/NF-e/XML/a.xml'))
  assert.ok(foraDoFormatoAtual('L/2026/11-Novembro/Eventos e Resumos/NF-e/a.xml'))
  assert.ok(!foraDoFormatoAtual('L/2026/11-Novembro/NF-e/Saidas/XML/a.xml'))
  assert.ok(!foraDoFormatoAtual('L/2026/11-Novembro/NF-e/Eventos e Resumos/a.xml'))
})

test('move as pastas inteiras, com PDF, relatórios e ZIP, e o banco acompanha', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<nfe/>'))
  a.gravar(p(MES, 'Entradas', 'NF-e', 'PDF', 'a-nfe.pdf'))
  a.gravar(p(MES, 'Entradas', 'NF-e', 'Relatorio NF-e Entradas Novembro 2026.pdf'))
  a.gravar(p(MES, 'Entradas', 'NF-e', 'Luna NF-e Entradas Novembro 2026.zip'))
  a.gravar(p(MES, 'Saidas', 'CT-e', 'XML', 'b-cte.xml'))
  a.evento(a.gravar(p(MES, 'Eventos e Resumos', 'NF-e', 'c-evento.xml')))
  a.gravar(p('Luna', 'sem-data', 'Entradas', 'NF-e', 'XML', 'd-nfe.xml'))
  a.gravar(p('Luna', 'Sem cliente cadastrado', '2026', '10-Outubro', 'Entradas', 'NF-e', 'XML', 'e-nfe.xml'))

  const r = a.migrar()

  assert.deepEqual(r.pendentes, [])
  assert.equal(a.versao(), VERSAO_XML)
  assert.equal(VERSAO_XML, '11')
  assert.equal(a.ler(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'), '<nfe/>')
  assert.ok(a.existe(MES, 'NF-e', 'Entradas', 'PDF', 'a-nfe.pdf'))
  assert.ok(a.existe(MES, 'NF-e', 'Entradas', 'Relatorio NF-e Entradas Novembro 2026.pdf'))
  assert.ok(a.existe(MES, 'NF-e', 'Entradas', 'Luna NF-e Entradas Novembro 2026.zip'))
  assert.ok(a.existe(MES, 'CT-e', 'Saidas', 'XML', 'b-cte.xml'))
  assert.ok(a.existe(MES, 'NF-e', 'Eventos e Resumos', 'c-evento.xml'))
  assert.ok(a.existe('Luna', 'sem-data', 'NF-e', 'Entradas', 'XML', 'd-nfe.xml'))
  assert.ok(a.existe('Luna', 'Sem cliente cadastrado', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'e-nfe.xml'))
  for (const velha of ['Entradas', 'Saidas', 'Eventos e Resumos']) assert.ok(!a.existe(MES, velha), velha)
  assert.equal(a.caminho(), p(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'))
  assert.equal(a.caminhoEvento(), p(MES, 'NF-e', 'Eventos e Resumos', 'c-evento.xml'))
})

test('uma operação por pasta, sem mexer arquivo a arquivo', (t) => {
  const a = montar(t)
  for (let i = 0; i < 20; i++) a.nota(a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', `${i}-nfe.xml`)), String(i))
  for (let i = 0; i < 20; i++) a.gravar(p(MES, 'Eventos e Resumos', 'NF-e', `${i}-evento.xml`))
  let renomeados = 0
  a.migrar({ renameSync: (...x) => (renomeados++, fs.renameSync(...x)) })
  assert.equal(renomeados, 2)
})

test('avisa o andamento', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  a.gravar(p(MES, 'Saidas', 'NF-e', 'XML', 'b-nfe.xml'))
  const avisos = []
  a.migrar({ aoAvancar: (n) => avisos.push(n) })
  assert.deepEqual(avisos, [1, 2])
})

test('app caiu entre mover e gravar o banco: a próxima abertura só aponta o banco', (t) => {
  const a = montar(t)
  a.gravar(p(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'))
  a.nota(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  assert.deepEqual(a.migrar().pendentes, [])
  assert.equal(a.caminho(), p(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'))
  assert.equal(a.versao(), VERSAO_XML)
})

test('pasta em uso: vai arquivo a arquivo; XML diferente mantém os dois e fica pendente', (t) => {
  const a = montar(t)
  const antigo = a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'), '<antes/>')
  a.nota(antigo)
  a.gravar(p(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'), '<depois/>')
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [antigo])
  assert.equal(a.ler(antigo), '<antes/>')
  assert.equal(a.ler(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'), '<depois/>')
  assert.equal(a.caminho(), antigo)
  assert.equal(a.versao(), '10')
})

test('a sequência inteira leva do formato 6 até o atual, e rodar de novo não faz nada', (t) => {
  const a = montar(t, { versao: '6' })
  a.nota(a.gravar(p('Luna', '2026', 'Novembro', 'NF-e', 'XML', 'Saidas', 'a-nfe.xml'), '<nfe/>'))
  a.gravar(p('Luna', '2026', 'Novembro', 'NF-e', 'XML', 'Saidas', 'Eventos', 'c-evento.xml'))
  a.gravar(p('Luna', '2026', 'Novembro', 'NF-e', 'XML', 'Entradas', 'Resumos', 'd-resumo.xml'))
  a.gravar(p('Luna', '2026', 'Novembro', 'NF-e', 'PDF', 'Saidas', 'a-nfe.pdf'))
  a.gravar(p('Luna', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'e-nfe.xml'))

  migrarLayouts({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })

  assert.equal(a.versao(), VERSAO_XML)
  assert.equal(a.ler(MES, 'NF-e', 'Saidas', 'XML', 'a-nfe.xml'), '<nfe/>')
  assert.equal(a.caminho(), p(MES, 'NF-e', 'Saidas', 'XML', 'a-nfe.xml'))
  assert.ok(a.existe(MES, 'NF-e', 'Saidas', 'PDF', 'a-nfe.pdf'))
  assert.ok(a.existe(MES, 'NF-e', 'Eventos e Resumos', 'c-evento.xml'))
  assert.ok(a.existe(MES, 'NF-e', 'Eventos e Resumos', 'd-resumo.xml'))
  assert.ok(a.existe('Luna', 'Sem cliente cadastrado', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'e-nfe.xml'))
  assert.ok(!a.existe('Luna', 'fora-da-carteira'))
  assert.equal(migrarLayouts({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso }).movidos, 0)
})

test('com etapa anterior pendente, muda a ordem e não grava a versão', (t) => {
  const a = montar(t, { versao: '9' })
  a.nota(a.gravar(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml')))
  a.migrar()
  assert.equal(a.versao(), '9')
  assert.equal(a.caminho(), p(MES, 'NF-e', 'Entradas', 'XML', 'a-nfe.xml'))
})

test('pasta fora do ar com notas no banco: nada muda', (t) => {
  const a = montar(t)
  a.nota(p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  migrarLayoutTipoPrimeiro({ db: a.db, pastaXmls: path.join(a.pastaXmls, 'sumiu'), logger: silencioso })
  assert.equal(a.caminho(), p(MES, 'Entradas', 'NF-e', 'XML', 'a-nfe.xml'))
  assert.equal(a.versao(), '10')
})
