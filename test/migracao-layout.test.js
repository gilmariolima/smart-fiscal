'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro, migrarLayoutAnoMes, migrarLayoutPastaXml } = require('../src/services/migracaoPastas')

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

// ---------- da ordem por tipo (1.8.4) para a ordem por empresa ----------

function montarV3() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-empresa-'))
  const db = abrirBanco(':memory:')
  const id = Number(db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'LUNA LTDA', 'Luna Materiais', 'CE', 'x.pfx', 'a:b:c')`).run(LUNA).lastInsertRowid)
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', '3')").run()
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const antigos = {
    nfe: gravar(p('NF-e', 'Luna Materiais', '2026', 'Outubro', 'Entradas', 'a-nfe.xml'), '<nfe/>'),
    cte: gravar(p('CT-e', 'Luna Materiais', '2026', 'Março', 'Outros', 'b-cte.xml')),
    evento: gravar(p('NFS-e', 'Luna Materiais', '2026', 'Outubro', 'Saidas', 'Eventos', 'c-evento-110111-1.xml')),
    resumo: gravar(p('NF-e', 'Luna Materiais', '2026', 'Outubro', 'Entradas', 'Resumos', 'd-resumo.xml')),
    semData: gravar(p('NF-e', 'Luna Materiais', 'sem-data', 'Entradas', 'e-nfe.xml')),
    fora: gravar(p('NF-e', 'SM Smart', 'fora-da-carteira', '2026', 'Outubro', 'Entradas', 'f-nfe.xml')),
    estranho: gravar(p('NF-e', 'Luna Materiais', 'leia-me.txt')),
  }
  db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, 'a', 'completa', '2026-10', ?)").run(id, antigos.nfe)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '110111', '1', ?)").run(antigos.evento)
  return { db, pastaXmls, antigos, gravar, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const porEmpresa = {
  nfe: p('Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'a-nfe.xml'),
  cte: p('Luna Materiais', 'CT-e', '2026', 'Março', 'Outros', 'b-cte.xml'),
  evento: p('Luna Materiais', 'NFS-e', '2026', 'Outubro', 'Saidas', 'Eventos', 'c-evento-110111-1.xml'),
  resumo: p('Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'Resumos', 'd-resumo.xml'),
  semData: p('Luna Materiais', 'NF-e', 'sem-data', 'Entradas', 'e-nfe.xml'),
  fora: p('SM Smart', 'fora-da-carteira', 'NF-e', '2026', 'Outubro', 'Entradas', 'f-nfe.xml'),
}

test('por empresa: leva tudo para Empresa/Tipo/Ano/Mês e atualiza o banco', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV3()
  t.after(limpar)
  const r = migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 6)
  for (const rel of Object.values(porEmpresa)) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
  assert.equal(fs.readFileSync(path.join(pastaXmls, porEmpresa.nfe), 'utf8'), '<nfe/>')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, porEmpresa.nfe)
  assert.equal(db.prepare('SELECT caminho_xml c FROM eventos').get().c, porEmpresa.evento)
  assert.equal(versao(db), '4')
  assert.deepEqual(r.ignorados, [antigos.estranho])
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.estranho)), 'fora do padrão fica onde está')
  assert.ok(!fs.existsSync(path.join(pastaXmls, 'CT-e')), 'pasta do tipo vazia some')
})

test('por empresa: segunda abertura não faz nada', (t) => {
  const { db, pastaXmls, limpar } = montarV3()
  t.after(limpar)
  migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso })
  const r = migrarLayoutEmpresaPrimeiro({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso })
  assert.equal(r.movidos, 0)
})

test('por empresa: arquivo travado volta o banco, a versão não grava e a próxima abertura termina', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV3()
  t.after(limpar)
  const travar = (de, para) => {
    if (de.endsWith('a-nfe.xml')) throw Object.assign(new Error('travado'), { code: 'EBUSY' })
    fs.renameSync(de, para)
  }
  const r = migrarLayoutEmpresaPrimeiro({ db, pastaXmls, fsOps: { renameSync: travar }, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.nfe])
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, antigos.nfe)
  assert.equal(versao(db), '3')
  assert.equal(migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso }).movidos, 1)
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, porEmpresa.nfe)
  assert.equal(versao(db), '4')
})

test('por empresa: espera a mudança anterior terminar', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  assert.equal(migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso }).movidos, 0)
  assert.equal(versao(db), undefined)
})

test('quem vem do formato antigo passa pelas duas mudanças em sequência; a anterior não roda de novo', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  const r = migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso })
  assert.equal(r.erro, undefined)
  assert.ok(fs.existsSync(path.join(pastaXmls, 'Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'a-nfe.xml')))
  assert.ok(fs.existsSync(path.join(pastaXmls, 'SM Smart Auditoria Ltda', 'fora-da-carteira', 'NF-e', '2026', 'Outubro', 'Entradas', 'f-nfe.xml')))
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, path.join('Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'a-nfe.xml'))
  assert.equal(versao(db), '4')
  assert.equal(migrarLayoutDasTelas({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso }).movidos, 0)
})

test('por empresa: pasta de rede fora do ar tenta depois; erro inesperado não impede o app de abrir', (t) => {
  const { db, pastaXmls, limpar } = montarV3()
  t.after(limpar)
  assert.equal(migrarLayoutEmpresaPrimeiro({ db, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso }).movidos, 0)
  assert.equal(versao(db), '3')
  const erros = []
  const r = migrarLayoutEmpresaPrimeiro({ db, pastaXmls, fsOps: { readdirSync() { throw new Error('disco') } }, logger: { ...silencioso, error: (m) => erros.push(m) } })
  assert.equal(r.erro, 'disco')
  assert.equal(erros.length, 1)
  assert.equal(versao(db), '3')
})

// ---------- da ordem empresa, tipo, ano e mês (1.8.5) para empresa, ano, mês e tipo ----------

function montarV4() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-anomes-'))
  const db = abrirBanco(':memory:')
  const id = Number(db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'LUNA LTDA', 'Luna Materiais', 'CE', 'x.pfx', 'a:b:c')`).run(LUNA).lastInsertRowid)
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', '4')").run()
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const antigos = {
    nfe: gravar(p('Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'a-nfe.xml'), '<nfe/>'),
    cte: gravar(p('Luna Materiais', 'CT-e', '2026', 'Março', 'Outros', 'b-cte.xml')),
    evento: gravar(p('Luna Materiais', 'NFS-e', '2026', 'Outubro', 'Saidas', 'Eventos', 'c-evento-110111-1.xml')),
    resumo: gravar(p('Luna Materiais', 'NF-e', '2026', 'Outubro', 'Entradas', 'Resumos', 'd-resumo.xml')),
    semData: gravar(p('Luna Materiais', 'NF-e', 'sem-data', 'Entradas', 'e-nfe.xml')),
    fora: gravar(p('SM Smart', 'fora-da-carteira', 'NF-e', '2026', 'Outubro', 'Entradas', 'f-nfe.xml')),
    estranho: gravar(p('Luna Materiais', 'leia-me.txt')),
  }
  db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, 'a', 'completa', '2026-10', ?)").run(id, antigos.nfe)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '110111', '1', ?)").run(antigos.evento)
  return { db, pastaXmls, antigos, gravar, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const porAnoMes = {
  nfe: p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas', 'a-nfe.xml'),
  cte: p('Luna Materiais', '2026', 'Março', 'CT-e', 'Outros', 'b-cte.xml'),
  evento: p('Luna Materiais', '2026', 'Outubro', 'NFS-e', 'Saidas', 'Eventos', 'c-evento-110111-1.xml'),
  resumo: p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas', 'Resumos', 'd-resumo.xml'),
  semData: p('Luna Materiais', 'sem-data', 'NF-e', 'Entradas', 'e-nfe.xml'),
  fora: p('SM Smart', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'Entradas', 'f-nfe.xml'),
}

test('por ano e mês: leva tudo para Empresa/Ano/Mês/Tipo e atualiza o banco', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV4()
  t.after(limpar)
  const r = migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 6)
  for (const rel of Object.values(porAnoMes)) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
  assert.equal(fs.readFileSync(path.join(pastaXmls, porAnoMes.nfe), 'utf8'), '<nfe/>')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, porAnoMes.nfe)
  assert.equal(db.prepare('SELECT caminho_xml c FROM eventos').get().c, porAnoMes.evento)
  assert.equal(versao(db), '5')
  assert.deepEqual(r.ignorados, [antigos.estranho])
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.estranho)), 'fora do padrão fica onde está')
  assert.ok(!fs.existsSync(path.join(pastaXmls, 'Luna Materiais', 'NF-e')), 'pasta antiga vazia some')
})

test('por ano e mês: segunda abertura não faz nada', (t) => {
  const { db, pastaXmls, limpar } = montarV4()
  t.after(limpar)
  migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  const r = migrarLayoutAnoMes({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso })
  assert.equal(r.movidos, 0)
})

test('por ano e mês: arquivo travado volta o banco e a próxima abertura termina, sem estranhar os já movidos', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV4()
  t.after(limpar)
  const travar = (de, para) => {
    if (de.endsWith('a-nfe.xml')) throw Object.assign(new Error('travado'), { code: 'EBUSY' })
    fs.renameSync(de, para)
  }
  const r = migrarLayoutAnoMes({ db, pastaXmls, fsOps: { renameSync: travar }, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.nfe])
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, antigos.nfe)
  assert.equal(versao(db), '4')
  const depois = migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  assert.equal(depois.movidos, 1)
  assert.deepEqual(depois.ignorados, [antigos.estranho], 'os já movidos não contam como fora do padrão')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, porAnoMes.nfe)
  assert.equal(versao(db), '5')
})

test('por ano e mês: destino diferente fica pendente e não sobrescreve', (t) => {
  const { db, pastaXmls, antigos, gravar, limpar } = montarV4()
  t.after(limpar)
  gravar(porAnoMes.cte, '<outro-conteudo/>')
  const r = migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.cte])
  assert.equal(fs.readFileSync(path.join(pastaXmls, porAnoMes.cte), 'utf8'), '<outro-conteudo/>')
  assert.equal(versao(db), '4')
})

test('por ano e mês: espera a anterior; do formato antigo passa por todas em sequência', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  assert.equal(migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso }).movidos, 0)
  migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso })
  migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  assert.equal(versao(db), '5')
  const rel = path.join('Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas', 'a-nfe.xml')
  assert.ok(fs.existsSync(path.join(pastaXmls, rel)))
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, rel)
  assert.ok(fs.existsSync(path.join(pastaXmls, 'SM Smart Auditoria Ltda', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'Entradas', 'f-nfe.xml')))
  assert.equal(migrarLayoutDasTelas({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso }).movidos, 0)
  assert.equal(migrarLayoutEmpresaPrimeiro({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso }).movidos, 0)
})

test('por ano e mês: pasta de rede fora do ar tenta depois; erro inesperado não impede o app de abrir', (t) => {
  const { db, pastaXmls, limpar } = montarV4()
  t.after(limpar)
  assert.equal(migrarLayoutAnoMes({ db, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso }).movidos, 0)
  assert.equal(versao(db), '4')
  const erros = []
  const r = migrarLayoutAnoMes({ db, pastaXmls, fsOps: { readdirSync() { throw new Error('disco') } }, logger: { ...silencioso, error: (m) => erros.push(m) } })
  assert.equal(r.erro, 'disco')
  assert.equal(erros.length, 1)
  assert.equal(versao(db), '4')
})

// ---------- da ordem empresa, ano, mês e tipo para a pasta XML dentro do tipo (versão 6) ----------

function montarV5() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-pastaxml-'))
  const db = abrirBanco(':memory:')
  const id = Number(db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'LUNA LTDA', 'Luna Materiais', 'CE', 'x.pfx', 'a:b:c')`).run(LUNA).lastInsertRowid)
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', '5')").run()
  const gravar = (rel, conteudo = '<x/>') => {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), conteudo)
    return rel
  }
  const antigos = {
    nfe: gravar(p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas', 'a-nfe.xml'), '<nfe/>'),
    cte: gravar(p('Luna Materiais', '2026', 'Março', 'CT-e', 'Outros', 'b-cte.xml')),
    evento: gravar(p('Luna Materiais', '2026', 'Outubro', 'NFS-e', 'Saidas', 'Eventos', 'c-evento-110111-1.xml')),
    resumo: gravar(p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas', 'Resumos', 'd-resumo.xml')),
    semData: gravar(p('Luna Materiais', 'sem-data', 'NF-e', 'Entradas', 'e-nfe.xml')),
    fora: gravar(p('SM Smart', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'Entradas', 'f-nfe.xml')),
    estranho: gravar(p('Luna Materiais', 'leia-me.txt')),
  }
  db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (?, 'a', 'completa', '2026-10', ?)").run(id, antigos.nfe)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('c', '110111', '1', ?)").run(antigos.evento)
  return { db, pastaXmls, antigos, gravar, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const comXml = {
  nfe: p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'a-nfe.xml'),
  cte: p('Luna Materiais', '2026', 'Março', 'CT-e', 'XML', 'Outros', 'b-cte.xml'),
  evento: p('Luna Materiais', '2026', 'Outubro', 'NFS-e', 'XML', 'Saidas', 'Eventos', 'c-evento-110111-1.xml'),
  resumo: p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'Resumos', 'd-resumo.xml'),
  semData: p('Luna Materiais', 'sem-data', 'NF-e', 'XML', 'Entradas', 'e-nfe.xml'),
  fora: p('SM Smart', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'f-nfe.xml'),
}

test('pasta XML: move para XML, atualiza o banco e grava a versão 6', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV5()
  t.after(limpar)
  const r = migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 6)
  for (const rel of Object.values(comXml)) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
  assert.equal(fs.readFileSync(path.join(pastaXmls, comXml.nfe), 'utf8'), '<nfe/>')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, comXml.nfe)
  assert.equal(db.prepare('SELECT caminho_xml c FROM eventos').get().c, comXml.evento)
  assert.equal(versao(db), '6')
  assert.deepEqual(r.ignorados, [antigos.estranho])
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.estranho)), 'fora do padrão fica onde está')
  assert.ok(!fs.existsSync(path.join(pastaXmls, 'Luna Materiais', '2026', 'Outubro', 'NF-e', 'Entradas')), 'pasta antiga vazia some')
})

test('pasta XML: arquivo travado fica pendente, sem gravar versão, e a próxima abertura termina', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV5()
  t.after(limpar)
  const travar = (de, para) => {
    if (de.endsWith('a-nfe.xml')) throw Object.assign(new Error('travado'), { code: 'EBUSY' })
    fs.renameSync(de, para)
  }
  const r = migrarLayoutPastaXml({ db, pastaXmls, fsOps: { renameSync: travar }, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.nfe])
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, antigos.nfe)
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.nfe)), 'o arquivo travado continua onde estava')
  assert.equal(versao(db), '5')
  const depois = migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  assert.equal(depois.movidos, 1)
  assert.deepEqual(depois.ignorados, [antigos.estranho], 'os já movidos não contam como fora do padrão')
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, comXml.nfe)
  assert.equal(versao(db), '6')
})

test('pasta XML: destino diferente não é sobrescrito; mesmo conteúdo some da origem', (t) => {
  const { db, pastaXmls, antigos, gravar, limpar } = montarV5()
  t.after(limpar)
  gravar(comXml.cte, '<outro-conteudo/>')
  gravar(comXml.nfe, '<nfe/>')
  const r = migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  assert.deepEqual(r.pendentes, [antigos.cte])
  assert.equal(fs.readFileSync(path.join(pastaXmls, comXml.cte), 'utf8'), '<outro-conteudo/>')
  assert.ok(fs.existsSync(path.join(pastaXmls, antigos.cte)), 'a origem não se perde')
  assert.ok(!fs.existsSync(path.join(pastaXmls, antigos.nfe)))
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, comXml.nfe)
  assert.equal(versao(db), '5')
})

test('pasta XML: arquivo que já está no formato 6 fica como está', (t) => {
  const { db, pastaXmls, gravar, limpar } = montarV5()
  t.after(limpar)
  const jaNovo = gravar(p('Luna Materiais', '2026', 'Outubro', 'NF-e', 'XML', 'Saidas', 'g-nfe.xml'), '<g/>')
  const r = migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  assert.equal(r.movidos, 6)
  assert.ok(!r.ignorados.includes(jaNovo))
  assert.equal(fs.readFileSync(path.join(pastaXmls, jaNovo), 'utf8'), '<g/>')
  assert.equal(versao(db), '6')
})

test('pasta XML: segunda abertura não faz nada', (t) => {
  const { db, pastaXmls, limpar } = montarV5()
  t.after(limpar)
  migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  const r = migrarLayoutPastaXml({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso })
  assert.equal(r.movidos, 0)
})

test('pasta XML: quem está na versão 5 passa; quem está em outra não', (t) => {
  const { db, pastaXmls, antigos, limpar } = montarV5()
  t.after(limpar)
  for (const outra of ['3', '4']) {
    db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(outra)
    assert.equal(migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso }).movidos, 0)
    assert.ok(fs.existsSync(path.join(pastaXmls, antigos.nfe)))
    assert.equal(versao(db), outra)
  }
  db.prepare('DELETE FROM sistema WHERE chave = ?').run('pastas_layout')
  assert.equal(migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso }).movidos, 0)
  assert.equal(versao(db), undefined)
})

test('pasta XML: pasta indisponível não faz nada e tenta depois; erro inesperado não impede o app de abrir', (t) => {
  const { db, pastaXmls, limpar } = montarV5()
  t.after(limpar)
  assert.equal(migrarLayoutPastaXml({ db, pastaXmls: path.join(pastaXmls, 'nao-existe'), logger: silencioso }).movidos, 0)
  assert.equal(versao(db), '5', 'o banco conhece XMLs: espera a pasta voltar')
  const erros = []
  const r = migrarLayoutPastaXml({ db, pastaXmls, fsOps: { readdirSync() { throw new Error('disco') } }, logger: { ...silencioso, error: (m) => erros.push(m) } })
  assert.equal(r.erro, 'disco')
  assert.equal(erros.length, 1)
  assert.equal(versao(db), '5')
})

test('pasta XML: do formato antigo passa por todas as mudanças e termina na versão 6; banco novo termina coerente', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  assert.equal(migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso }).movidos, 0, 'espera as anteriores')
  migrarLayoutDasTelas({ db, pastaXmls, logger: silencioso })
  migrarLayoutEmpresaPrimeiro({ db, pastaXmls, logger: silencioso })
  migrarLayoutAnoMes({ db, pastaXmls, logger: silencioso })
  migrarLayoutPastaXml({ db, pastaXmls, logger: silencioso })
  assert.equal(versao(db), '6')
  const rel = path.join('Luna Materiais', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'a-nfe.xml')
  assert.ok(fs.existsSync(path.join(pastaXmls, rel)))
  assert.equal(db.prepare('SELECT caminho_xml c FROM notas').get().c, rel)
  assert.ok(fs.existsSync(path.join(pastaXmls, 'SM Smart Auditoria Ltda', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'f-nfe.xml')))
  for (const migrar of [migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro, migrarLayoutAnoMes, migrarLayoutPastaXml]) {
    assert.equal(migrar({ db, pastaXmls, fsOps: { renameSync() { throw new Error('não devia mover') } }, logger: silencioso }).movidos, 0)
  }
})

test('pasta XML: banco novo, sem layout gravado e sem pasta, termina na versão 6', (t) => {
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-vazio-'))
  t.after(() => fs.rmSync(vazio, { recursive: true, force: true }))
  const db = abrirBanco(':memory:')
  const pastaXmls = path.join(vazio, 'nao-existe-ainda')
  for (const migrar of [migrarLayoutDasTelas, migrarLayoutEmpresaPrimeiro, migrarLayoutAnoMes, migrarLayoutPastaXml]) migrar({ db, pastaXmls, logger: silencioso })
  assert.equal(versao(db), '6')
})

test('M11: em nova tentativa, PDF e arquivos gerados não entram em ignorados; um arquivo estranho entra', (t) => {
  const { db, pastaXmls, limpar } = montar()
  t.after(limpar)
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pastas_layout', '5') ON CONFLICT(chave) DO UPDATE SET valor = '5'").run()
  const base = p('Foo', '2026', 'Novembro', 'NF-e')
  const gerados = [p(base, 'PDF', 'Entradas', '1-nfe.pdf'), p(base, 'Relatorio NF-e Novembro 2026.xlsx'), p(base, 'Relatorio NF-e Novembro 2026.pdf'), p(base, 'Foo NF-e Novembro 2026.zip')]
  const estranho = p(base, 'de-alguem.txt')
  for (const rel of [...gerados, estranho]) {
    fs.mkdirSync(path.dirname(path.join(pastaXmls, rel)), { recursive: true })
    fs.writeFileSync(path.join(pastaXmls, rel), 'x')
  }
  const r = migrarLayoutPastaXml({ db, pastaXmls, logger: { info() {}, warn() {}, error() {} } })
  assert.deepEqual(r.ignorados.filter((f) => f.startsWith('Foo')), [estranho])
  assert.equal(versao(db), '6')
  for (const rel of gerados) assert.ok(fs.existsSync(path.join(pastaXmls, rel)), rel)
})
