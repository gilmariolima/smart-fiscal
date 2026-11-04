'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutDasTelas } = require('../src/services/migracaoPastas')

const silencioso = { info() {}, warn() {}, error() {} }
const LUNA = '11222333000181'
const ESCRITORIO = '55666777000100'
const SUMIU = '99888777000166'
const p = (...partes) => path.join(...partes)

function montar() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-layout-'))
  const db = abrirBanco(':memory:')
  const ins = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES (?, ?, ?, 'CE', 'x.pfx', 'a:b:c', ?)`)
  const idLuna = Number(ins.run(LUNA, 'LUNA MATERIAIS LTDA', 'Luna Materiais', 'cliente').lastInsertRowid)
  ins.run(ESCRITORIO, 'SM Smart Auditoria Ltda', 'escritorio', 'escritorio')
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const antigos = {
    nfe: gravar(p(`${LUNA}_Luna_Materiais`, '2026', '10', 'NF-e', 'Entradas', 'a-nfe.xml'), '<nfe/>'),
    cte: gravar(p(`${LUNA}_Luna_Materiais`, '2026', '03', 'CT-e', 'Outros', 'b-cte.xml')),
    evento: gravar(p(`${LUNA}_Luna_Materiais`, '2026', '10', 'NFS-e', 'Saidas', 'Eventos', 'c-evento-110111-1.xml')),
    resumo: gravar(p(`${LUNA}_Luna_Materiais`, '2026', '10', 'NF-e', 'Entradas', 'Resumos', 'd-resumo.xml')),
    semData: gravar(p(`${LUNA}_Luna_Materiais`, 'sem-data', 'NF-e', 'Entradas', 'e-nfe.xml')),
    fora: gravar(p(`${ESCRITORIO}_escritorio`, 'fora-da-carteira', '2026', '10', 'NF-e', 'Entradas', 'f-nfe.xml')),
    excluido: gravar(p(`${SUMIU}_Antigo_Cliente`, '2026', '10', 'NF-e', 'Entradas', 'g-nfe.xml')),
    estranho: gravar(p(`${LUNA}_Luna_Materiais`, '2026', 'leia-me.txt')),
  }
  db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, 'a', 'completa', '2026-10', ?)").run(idLuna, antigos.nfe)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '110111', '1', ?)").run(antigos.evento)
  return { db, pastaXmls, antigos, ins, gravar, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const novo = {
  nfe: p('NF-e', 'Luna Materiais', '2026', 'Outubro', 'Entradas', 'a-nfe.xml'),
  cte: p('CT-e', 'Luna Materiais', '2026', 'Março', 'Outros', 'b-cte.xml'),
  evento: p('NFS-e', 'Luna Materiais', '2026', 'Outubro', 'Saidas', 'Eventos', 'c-evento-110111-1.xml'),
  resumo: p('NF-e', 'Luna Materiais', '2026', 'Outubro', 'Entradas', 'Resumos', 'd-resumo.xml'),
  semData: p('NF-e', 'Luna Materiais', 'sem-data', 'Entradas', 'e-nfe.xml'),
  fora: p('NF-e', 'SM Smart Auditoria Ltda', 'fora-da-carteira', '2026', 'Outubro', 'Entradas', 'f-nfe.xml'),
  excluido: p('NF-e', 'Antigo Cliente', '2026', 'Outubro', 'Entradas', 'g-nfe.xml'),
}
const versao = (db) => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").get()?.valor

test('leva tudo para Tipo/Cliente/Ano/Mês e atualiza o banco', (t) => {
  const { db, pastaXmls, antigos, limpar } = montar()
  t.after(limpar)
  const r = migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 7)
  for (const rel of Object.values(novo)) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
  assert.equal(fs.readFileSync(path.join(pastaXmls, novo.nfe), 'utf8'), '<nfe/>')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, novo.nfe)
  assert.equal(db.prepare('SELECT caminho_xml c FROM eventos').get().c, novo.evento)
  assert.equal(versao(db), '3')
  assert.deepEqual(r.ignorados, [antigos.estranho])
  // Só o que ficou fora do padrão sobra na pasta antiga; o que esvaziou some.
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.estranho)))
  assert.ok(!fs.existsSync(path.join(pastaXmls, `${SUMIU}_Antigo_Cliente`)))
  assert.ok(!fs.existsSync(path.join(pastaXmls, `${LUNA}_Luna_Materiais`, 'sem-data')))
})

test('segunda abertura não faz nada', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  const r = migrarLayoutDasTelas({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso })
  assert.equal(r.movidos, 0)
})

test('arquivo travado: o banco volta, a versão não grava e a próxima abertura termina', (t) => {
  const { db, pastaXmls, antigos, limpar } = montar()
  t.after(limpar)
  const travar = (de, para) => {
    if (de.endsWith('a-nfe.xml')) throw Object.assign(new Error('travado'), { code: 'EBUSY' })
    fs.renameSync(de, para)
  }
  const r = migrarLayoutDasTelas({ db, pastaXmls, fsOps: { renameSync: travar }, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.nfe])
  assert.equal(r.movidos, 6)
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, antigos.nfe)
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.nfe)))
  assert.equal(versao(db), undefined)

  const depois = migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  assert.equal(depois.movidos, 1)
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, novo.nfe)
  assert.equal(versao(db), '3')
})

test('o banco já aponta para o caminho novo quando o arquivo é movido (app caindo no meio não perde nota)', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  let visto
  const espiar = (de, para) => {
    if (de.endsWith('a-nfe.xml')) visto = db.prepare('SELECT caminho_xml c FROM notas').get().c
    fs.renameSync(de, para)
  }
  migrarLayoutDasTelas({ db, pastaXmls, fsOps: { renameSync: espiar }, logger: silencioso })
  assert.equal(visto, novo.nfe)
})

test('destino igual apaga a origem; destino diferente fica pendente e não sobrescreve', (t) => {
  const { db, pastaXmls, antigos, gravar, limpar } = montar()
  t.after(limpar)
  gravar(novo.nfe, '<nfe/>')
  gravar(novo.cte, '<outro-conteudo/>')
  const r = migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  assert.ok(!fs.existsSync(path.join(pastaXmls, antigos.nfe)))
  assert.deepEqual(r.pendentes, [antigos.cte])
  assert.equal(fs.readFileSync(path.join(pastaXmls, novo.cte), 'utf8'), '<outro-conteudo/>')
  assert.equal(versao(db), undefined)
})

test('clientes com o mesmo nome não se misturam: a pasta leva o CNPJ', (t) => {
  const { db, pastaXmls, ins, gravar, limpar } = montar()
  t.after(limpar)
  const outra = '44555666000199'
  ins.run(outra, 'LUNA FILIAL', 'luna materiais', 'cliente')
  gravar(p(`${outra}_luna_materiais`, '2026', '10', 'NF-e', 'Entradas', 'z-nfe.xml'))
  migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  assert.ok(fs.existsSync(path.join(pastaXmls, 'NF-e', `luna materiais ${outra}`, '2026', 'Outubro', 'Entradas', 'z-nfe.xml')))
  assert.ok(fs.existsSync(path.join(pastaXmls, 'NF-e', `Luna Materiais ${LUNA}`, '2026', 'Outubro', 'Entradas', 'a-nfe.xml')))
})

test('pasta de rede fora do ar: tenta na próxima abertura; banco sem XML dá por feito', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const r = migrarLayoutDasTelas({ db, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso })
  assert.equal(r.movidos, 0)
  assert.equal(versao(db), undefined)
  db.exec('UPDATE notas SET caminho_xml = NULL; UPDATE eventos SET caminho_xml = NULL')
  migrarLayoutDasTelas({ db, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso })
  assert.equal(versao(db), '3')
})

test('erro inesperado vai para o log e não impede o app de abrir', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  const erros = []
  const r = migrarLayoutDasTelas({ db, pastaXmls, fsOps: { readdirSync() { throw new Error('disco') } }, logger: { ...silencioso, error: (m) => erros.push(m) } })
  assert.equal(r.erro, 'disco')
  assert.equal(erros.length, 1)
  assert.equal(versao(db), undefined)
})
