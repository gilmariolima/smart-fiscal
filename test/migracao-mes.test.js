'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { migrarLayoutMesNumerado, migrarLayouts, limparResumosDeNotasCompletas, VERSAO_XML } = require('../src/services/migracaoPastas')
const { pastaDoGrupo, comMesNumerado, temMesSemNumero } = require('../src/services/armazenamento')

const silencioso = { info() {}, warn() {}, error() {} }
const p = (...partes) => path.join(...partes)
const ANTIGO = p('Luna', '2026', 'Novembro', 'NF-e')
const NOVO = p('Luna', '2026', '11-Novembro', 'NF-e')
const VERSAO_MES = '7'
const XML = p('XML', 'Entradas', 'a-nfe.xml')
const EVENTO = p('XML', 'Entradas', 'Eventos', 'a-evento-110111-1.xml')
const ocupado = (code = 'EBUSY') => () => {
  throw Object.assign(new Error(code), { code })
}

function montar(t, { versao = '6' } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-mes-'))
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
  const evento = (rel) => db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES ('a', '110111', '1', ?)").run(rel)
  const migrar = (fsOps) => migrarLayoutMesNumerado({ db, pastaXmls, logger: silencioso, fsOps })
  return {
    db,
    pastaXmls,
    gravar,
    nota,
    evento,
    migrar,
    existe: (...r) => fs.existsSync(path.join(pastaXmls, ...r)),
    ler: (...r) => fs.readFileSync(path.join(pastaXmls, ...r), 'utf8'),
    caminho: () => db.prepare('SELECT caminho_xml c FROM notas').get().c,
    versao: () => db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(),
  }
}

test('nome novo: pasta do grupo e caminho com o número do mês', () => {
  const cliente = { cnpj: '11222333000181', apelido: 'Luna' }
  assert.equal(pastaDoGrupo({ cliente, competencia: '2026-01', modelo: 'nfe' }), p('Luna', '2026', '01-Janeiro', 'NF-e', 'Entradas'))
  assert.equal(pastaDoGrupo({ cliente, competencia: '2026-12', modelo: 'cte' }), p('Luna', '2026', '12-Dezembro', 'CT-e', 'Entradas'))
  assert.equal(pastaDoGrupo({ cliente, competencia: null, modelo: 'nfe' }), p('Luna', 'sem-data', 'NF-e', 'Entradas'))
})

test('comMesNumerado troca só a pasta do mês e mantém a barra', () => {
  assert.equal(comMesNumerado('Luna\\2026\\Março\\NF-e\\XML\\a.xml'), 'Luna\\2026\\03-Março\\NF-e\\XML\\a.xml')
  assert.equal(comMesNumerado('Luna/fora-da-carteira/2026/Março/NF-e/a.xml'), 'Luna/fora-da-carteira/2026/03-Março/NF-e/a.xml')
  assert.equal(comMesNumerado('Maio/2026/03-Março/NF-e/a.xml'), 'Maio/2026/03-Março/NF-e/a.xml')
  assert.equal(comMesNumerado('Maio/sem-data/NF-e/a.xml'), 'Maio/sem-data/NF-e/a.xml')
  assert.ok(temMesSemNumero('Luna\\2026\\Março\\NF-e\\a.xml'))
  assert.ok(!temMesSemNumero('Março/2026/03-Março/NF-e/a.xml'))
})

test('renomeia o mês inteiro, com PDF, relatório e ZIP, e o banco acompanha', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(ANTIGO, XML), '<nfe/>'))
  a.evento(a.gravar(p(ANTIGO, EVENTO)))
  a.gravar(p(ANTIGO, 'PDF', 'Entradas', 'a-nfe.pdf'))
  a.gravar(p(ANTIGO, 'Relatorio NF-e Novembro 2026.pdf'))
  a.gravar(p(ANTIGO, 'Luna NF-e Novembro 2026.zip'))
  a.gravar(p('Luna', 'fora-da-carteira', '2026', 'Março', 'NF-e', 'XML', 'Entradas', 'f-nfe.xml'))
  a.gravar(p('Luna', 'sem-data', 'NF-e', 'XML', 'Entradas', 'e-nfe.xml'))

  const r = a.migrar()

  assert.deepEqual(r.pendentes, [])
  assert.equal(a.versao(), VERSAO_MES)
  assert.equal(VERSAO_XML, '11')
  assert.equal(a.ler(NOVO, XML), '<nfe/>')
  assert.ok(a.existe(NOVO, 'PDF', 'Entradas', 'a-nfe.pdf'))
  assert.ok(a.existe(NOVO, 'Relatorio NF-e Novembro 2026.pdf'), 'o nome do arquivo não muda')
  assert.ok(a.existe(NOVO, 'Luna NF-e Novembro 2026.zip'))
  assert.ok(!a.existe('Luna', '2026', 'Novembro'))
  assert.ok(a.existe('Luna', 'fora-da-carteira', '2026', '03-Março', 'NF-e', 'XML', 'Entradas', 'f-nfe.xml'))
  assert.ok(a.existe('Luna', 'sem-data', 'NF-e', 'XML', 'Entradas', 'e-nfe.xml'))
  assert.equal(a.caminho(), p(NOVO, XML))
  assert.equal(a.db.prepare('SELECT caminho_xml c FROM eventos').get().c, p(NOVO, EVENTO))
})

test('renomeia em uma operação por mês, sem mexer arquivo a arquivo', (t) => {
  const a = montar(t)
  for (let i = 0; i < 20; i++) a.nota(a.gravar(p(ANTIGO, 'XML', 'Entradas', `${i}-nfe.xml`)), String(i))
  let renomeados = 0
  a.migrar({ renameSync: (...x) => (renomeados++, fs.renameSync(...x)) })
  assert.equal(renomeados, 1)
})

test('banco com barra normal mantém a barra', (t) => {
  const a = montar(t)
  a.gravar(p(ANTIGO, XML))
  a.nota('Luna/2026/Novembro/NF-e/XML/Entradas/a-nfe.xml')
  a.migrar()
  assert.equal(a.caminho(), 'Luna/2026/11-Novembro/NF-e/XML/Entradas/a-nfe.xml')
  assert.equal(a.versao(), VERSAO_MES)
})

test('só renomeia o mês abaixo do ano: empresa ou pasta com nome de mês fica como está', (t) => {
  const a = montar(t)
  a.gravar(p('Maio', '2026', 'Maio', 'NF-e', XML))
  a.gravar(p('Maio', 'Maio', 'nota.txt'))
  a.gravar(p('Maio', '2026', 'Outra', 'nota.txt'))
  a.migrar()
  assert.ok(a.existe('Maio', '2026', '05-Maio', 'NF-e', XML))
  assert.ok(a.existe('Maio', 'Maio', 'nota.txt'))
  assert.ok(a.existe('Maio', '2026', 'Outra', 'nota.txt'))
})

test('rodar de novo não faz nada', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(ANTIGO, XML)))
  a.migrar()
  const antes = a.caminho()
  const r = a.migrar({ renameSync: ocupado() })
  assert.equal(r.movidos, 0)
  assert.equal(a.caminho(), antes)
})

test('versão mais antiga que a da pasta XML não é tocada por esta etapa', (t) => {
  const a = montar(t, { versao: '4' })
  a.gravar(p(ANTIGO, XML))
  a.migrar()
  assert.equal(a.versao(), '4')
  assert.ok(a.existe(ANTIGO, XML))
})

test('com a pasta XML pendente, numera os meses e não grava a versão', (t) => {
  const a = montar(t, { versao: '5' })
  a.nota(a.gravar(p(ANTIGO, 'Entradas', 'a-nfe.xml')))
  a.migrar()
  assert.equal(a.versao(), '5')
  assert.ok(a.existe(NOVO, 'Entradas', 'a-nfe.xml'))
  assert.equal(a.caminho(), p(NOVO, 'Entradas', 'a-nfe.xml'))
})

test('XML travado na pasta XML: depois de numerado, a mudança anterior ainda o leva e chega à versão atual', (t) => {
  const a = montar(t, { versao: '5' })
  a.nota(a.gravar(p(ANTIGO, 'Entradas', 'a-nfe.xml'), '<nfe/>'))
  a.migrar()
  const r = migrarLayouts({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso })
  const final = p('Luna', '2026', '11-Novembro', 'NF-e', 'Entradas', 'XML', 'a-nfe.xml')
  assert.equal(r.pendentes, 0)
  assert.equal(a.ler(final), '<nfe/>')
  assert.equal(a.caminho(), final)
  assert.equal(a.versao(), VERSAO_XML)
})

test('app caiu entre renomear e gravar o banco: a próxima abertura só aponta o banco', (t) => {
  const a = montar(t)
  a.gravar(p(NOVO, XML))
  a.nota(p(ANTIGO, XML))
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [])
  assert.equal(a.caminho(), p(NOVO, XML))
  assert.equal(a.versao(), VERSAO_MES)
})

test('pasta em uso: leva arquivo a arquivo, sem depender de renomear o mês', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(ANTIGO, XML), '<nfe/>'))
  a.gravar(p(ANTIGO, 'Luna NF-e Novembro 2026.zip'))
  const r = a.migrar({ renameSync: ocupado() })
  assert.deepEqual(r.pendentes, [])
  assert.equal(a.ler(NOVO, XML), '<nfe/>')
  assert.ok(a.existe(NOVO, 'Luna NF-e Novembro 2026.zip'))
  assert.ok(!a.existe('Luna', '2026', 'Novembro'))
  assert.equal(a.caminho(), p(NOVO, XML))
  assert.equal(a.versao(), VERSAO_MES)
})

test('arquivo aberto: o resto vai, ele fica pendente e sai depois de soltar', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(ANTIGO, XML), '<nfe/>'))
  const pdf = a.gravar(p(ANTIGO, 'PDF', 'Entradas', 'a-nfe.pdf'))
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', (c) => {
    if (String(c).endsWith('a-nfe.pdf')) ocupado()()
    return unlink(c)
  })
  const r = a.migrar({ renameSync: ocupado() })
  assert.deepEqual(r.pendentes, [pdf])
  assert.equal(a.versao(), '6', 'sem terminar, a versão não muda')
  assert.equal(a.caminho(), p(NOVO, XML), 'o que foi levado já vale no banco')
  t.mock.restoreAll()

  assert.deepEqual(a.migrar().pendentes, [])
  assert.ok(a.existe(NOVO, 'PDF', 'Entradas', 'a-nfe.pdf'))
  assert.ok(!a.existe('Luna', '2026', 'Novembro'))
  assert.equal(a.versao(), VERSAO_MES)
})

test('os dois meses existem: junta, e arquivo igual sai da pasta antiga', (t) => {
  const a = montar(t)
  a.nota(a.gravar(p(ANTIGO, XML), '<igual/>'))
  a.gravar(p(NOVO, XML), '<igual/>')
  a.gravar(p(NOVO, 'XML', 'Entradas', 'b-nfe.xml'))
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [])
  assert.equal(a.caminho(), p(NOVO, XML))
  assert.ok(a.existe(NOVO, 'XML', 'Entradas', 'b-nfe.xml'))
  assert.ok(!a.existe('Luna', '2026', 'Novembro'))
})

test('XML diferente com o mesmo nome: mantém os dois, o banco não muda e fica pendente', (t) => {
  const a = montar(t)
  const antigo = a.gravar(p(ANTIGO, XML), '<antes/>')
  a.nota(antigo)
  a.gravar(p(NOVO, XML), '<depois/>')
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [antigo])
  assert.equal(a.ler(antigo), '<antes/>')
  assert.equal(a.ler(NOVO, XML), '<depois/>')
  assert.equal(a.caminho(), antigo)
  assert.equal(a.versao(), '6')
})

test('relatório diferente com o mesmo nome não prende: fica na pasta antiga, sem sobrescrever', (t) => {
  const a = montar(t)
  const antigo = a.gravar(p(ANTIGO, 'Relatorio NF-e Novembro 2026.pdf'), 'velho')
  a.gravar(p(NOVO, 'Relatorio NF-e Novembro 2026.pdf'), 'novo')
  const r = a.migrar()
  assert.deepEqual(r.pendentes, [])
  assert.deepEqual(r.ignorados, [antigo])
  assert.equal(a.ler(antigo), 'velho')
  assert.equal(a.ler(NOVO, 'Relatorio NF-e Novembro 2026.pdf'), 'novo')
  assert.equal(a.versao(), VERSAO_MES)
})

test('pasta fora do ar com notas no banco: nada muda e tenta de novo', (t) => {
  const a = montar(t)
  a.nota(p(ANTIGO, XML))
  const r = migrarLayoutMesNumerado({ db: a.db, pastaXmls: path.join(a.pastaXmls, 'sumiu'), logger: silencioso })
  assert.equal(r.movidos, 0)
  assert.equal(a.caminho(), p(ANTIGO, XML))
  assert.equal(a.versao(), '6')
})

test('instalação nova, sem notas: chega à versão atual', (t) => {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-mes-'))
  const db = abrirBanco(':memory:')
  t.after(() => {
    db.close()
    fs.rmSync(pastaXmls, { recursive: true, force: true })
  })
  migrarLayouts({ db, pastaXmls, logger: silencioso })
  assert.equal(db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get(), VERSAO_XML)
})

// ---------- resumos que sobraram das notas completas ----------

const MES_ATUAL = p('Luna', '2026', '11-Novembro')
const RESUMO = (chave) => p('NF-e', 'Eventos e Resumos', `${chave}-resumo.xml`)
const NOTA = (chave) => p('NF-e', 'Entradas', 'XML', `${chave}-nfe.xml`)
function comResumos(t) {
  const a = montar(t, { versao: VERSAO_XML })
  const id = a.db.prepare('SELECT id FROM clientes').pluck().get()
  const completa = (chave) => {
    a.gravar(p(MES_ATUAL, RESUMO(chave)))
    const rel = a.gravar(p(MES_ATUAL, NOTA(chave)))
    a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'completa', '2026-11', ?)").run(id, chave, rel)
  }
  a.db.prepare("INSERT INTO pasta_grupos (cliente_id, competencia, modelo, assinatura, gerado_em) VALUES (?, '2026-11', 'nfe', 'x', 'y'), (?, '2026-10', 'nfe', 'x', 'y')").run(id, id)
  const limpar = (fsOps) => limparResumosDeNotasCompletas({ db: a.db, pastaXmls: a.pastaXmls, logger: silencioso, ...fsOps })
  const grupos = () => a.db.prepare('SELECT competencia FROM pasta_grupos ORDER BY 1').pluck().all()
  return { ...a, id, completa, limpar, grupos }
}

test('limpeza: tira o resumo da nota completa, refaz só o mês dela e não repete', (t) => {
  const a = comResumos(t)
  a.completa('111')
  a.gravar(p(MES_ATUAL, RESUMO('222')))
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, status, competencia) VALUES (?, '222', 'nfe', 'resumo', '2026-11')").run(a.id)

  const r = a.limpar()

  assert.equal(r.apagados, 1)
  assert.ok(!a.existe(MES_ATUAL, RESUMO('111')))
  assert.ok(a.existe(MES_ATUAL, NOTA('111')))
  assert.ok(a.existe(MES_ATUAL, RESUMO('222')), 'nota só em resumo: o resumo fica')
  assert.deepEqual(a.grupos(), ['2026-10'], 'só o mês que mudou volta a ser gerado')

  a.gravar(p(MES_ATUAL, RESUMO('111')))
  assert.equal(a.limpar().apagados, 0, 'uma vez só')
  assert.ok(a.existe(MES_ATUAL, RESUMO('111')))
})

test('limpeza: pasta Eventos e Resumos vazia sai', (t) => {
  const a = comResumos(t)
  a.completa('111')
  a.limpar()
  assert.ok(!a.existe(MES_ATUAL, 'NF-e', 'Eventos e Resumos'))
})

test('limpeza: nota sem o arquivo no disco mantém o resumo', (t) => {
  const a = comResumos(t)
  a.completa('111')
  fs.rmSync(path.join(a.pastaXmls, MES_ATUAL, NOTA('111')))
  assert.equal(a.limpar().apagados, 0)
  assert.ok(a.existe(MES_ATUAL, RESUMO('111')))
})

test('limpeza: arquivo preso fica e tenta de novo na próxima abertura', (t) => {
  const a = comResumos(t)
  a.completa('111')
  const rm = fs.rmSync
  t.mock.method(fs, 'rmSync', (alvo, ...resto) => {
    if (String(alvo).endsWith('-resumo.xml')) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
    return rm(alvo, ...resto)
  })
  assert.equal(a.limpar().falhas, 1)
  t.mock.restoreAll()
  assert.ok(a.existe(MES_ATUAL, RESUMO('111')))
  assert.equal(a.limpar().apagados, 1)
})

test('limpeza: espera a organização das pastas e a pasta voltar', (t) => {
  const a = comResumos(t)
  a.completa('111')
  a.db.prepare("UPDATE sistema SET valor = '6' WHERE chave = 'pastas_layout'").run()
  assert.equal(a.limpar().apagados, 0)
  assert.ok(a.existe(MES_ATUAL, RESUMO('111')))
  a.db.prepare("UPDATE sistema SET valor = ? WHERE chave = 'pastas_layout'").run(VERSAO_XML)
  assert.equal(limparResumosDeNotasCompletas({ db: a.db, pastaXmls: path.join(a.pastaXmls, 'sumiu'), logger: silencioso }).apagados, 0)
  assert.equal(a.limpar().apagados, 1)
})
