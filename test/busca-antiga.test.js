'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { criarServicoImportacao } = require('../src/services/importacao')
const { criarBuscaAntiga } = require('../src/services/buscaAntiga')
const { chaveNfe, nfeProc } = require('./apoio/nfe-importada')

const CLIENTE = '11222333000181'
const FORNECEDOR = '66777888000199'
const logger = { info() {}, warn() {}, error() {} }
const AGORA = new Date('2026-11-13T12:00:00Z')

function temporizadorFalso() {
  const agenda = []
  return {
    agenda,
    setTimeout: (fn, ms) => (agenda.push({ fn, ms, ativo: true }), agenda.length),
    clearTimeout: (id) => id && (agenda[id - 1].ativo = false),
    ultimo: () => agenda.filter((a) => a.ativo).at(-1),
  }
}

// respostas: { [chave]: resposta | resposta[] } — lista = uma por chamada.
function montar({ respostas = {}, validade = '2027-08-28T00:00:00Z', podeRodar, config: extra = {} } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'busca-antiga-'))
  const db = abrirBanco(':memory:')
  const id = db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, cert_validade) VALUES (?, 'Cliente Ltda', 'Cliente', 'CE', 'c.pfx', 'a:b:c', ?)").run(CLIENTE, validade).lastInsertRowid
  const semCert = db.prepare("INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc) VALUES ('99888777000100', 'Sem Cert', 'CE', '', '')").run().lastInsertRowid
  const config = { pastaXmls, ...extra }
  const importacao = criarServicoImportacao({ db, config, logger })
  const chamadas = []
  const fabricaSvrs = () => ({
    baixarNfe: async (chave) => {
      chamadas.push(chave)
      const r = respostas[chave]
      return Array.isArray(r) ? r.shift() : r
    },
  })
  const tempo = temporizadorFalso()
  const importados = []
  const criar = () => criarBuscaAntiga({ db, config, logger, importacao, fabricaSvrs, podeRodar, aoImportar: (ids) => importados.push(ids), agora: () => AGORA, temporizador: tempo })
  return { db, id, semCert, chamadas, tempo, importados, criar, servico: criar(), pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const linha = (db, chave) => db.prepare('SELECT * FROM busca_antiga WHERE chave = ?').get(chave)
const blocos = (c) => c.match(/.{4}/g).join(' ')

test('adicionar pega chaves no meio do texto, em blocos e ignora repetidas', (t) => {
  const { db, id, servico, limpar } = montar()
  t.after(limpar)
  const c1 = chaveNfe(FORNECEDOR, 1)
  const c2 = chaveNfe(FORNECEDOR, 2)
  const nfce = c1.slice(0, 20) + '65' + c1.slice(22)
  const r = servico.adicionar(id, `a ${blocos(c1)}, b;${c2}\n${c2} ${'1'.repeat(45)} ${nfce}`)
  assert.deepEqual(r, { adicionadas: 2, repetidas: 1, naoNfe: 1 })
  assert.equal(linha(db, c1).situacao, 'fila')
  assert.equal(linha(db, nfce).situacao, 'nao-nfe')
  assert.equal(db.prepare('SELECT COUNT(*) FROM busca_antiga').pluck().get(), 3)
})

test('chave em erro volta para a fila ao colar de novo; cliente sem certificado dá 404', (t) => {
  const { db, id, semCert, servico, limpar } = montar()
  t.after(limpar)
  const c = chaveNfe(FORNECEDOR, 3)
  servico.adicionar(id, c)
  db.prepare("UPDATE busca_antiga SET situacao = 'erro', tentativas = 3, mensagem = 'x'").run()
  assert.deepEqual(servico.adicionar(id, c), { adicionadas: 1, repetidas: 0, naoNfe: 0 })
  assert.deepEqual([linha(db, c).situacao, linha(db, c).tentativas, linha(db, c).mensagem], ['fila', 0, null])
  assert.throws(() => servico.adicionar(semCert, c), (e) => e.codigo === 404)
  assert.throws(() => servico.adicionar(999, c), (e) => e.codigo === 404)
})

test('nota baixada é importada', async (t) => {
  const c = chaveNfe(FORNECEDOR, 4)
  const { db, id, servico, importados, limpar } = montar({ respostas: { [c]: { xml: nfeProc({ chave: c, emit: FORNECEDOR, dest: CLIENTE, nNF: '4' }) } } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'baixada')
  assert.equal(linha(db, c).situacao, 'baixada')
  const nota = db.prepare('SELECT * FROM notas WHERE chave = ?').get(c)
  assert.deepEqual([nota.origem, nota.tipo, nota.cliente_id], ['importada', 'entrada', id])
  assert.deepEqual(importados, [[id]])
  assert.equal(await servico.processarProxima(), null)
})

test('nota que o cliente já tem não consulta a SVRS', async (t) => {
  const c = chaveNfe(FORNECEDOR, 5)
  const { id, servico, chamadas, limpar, criar } = montar({ respostas: { [c]: { xml: nfeProc({ chave: c, emit: FORNECEDOR, dest: CLIENTE, nNF: '5' }) } } })
  t.after(limpar)
  servico.adicionar(id, c)
  await servico.processarProxima()
  // Some da tabela da fila e volta: já está no Smart Fiscal.
  const outro = criar()
  outro.limparConcluidas()
  outro.adicionar(id, c)
  assert.equal(await outro.processarProxima(), 'ja-existia')
  assert.equal(chamadas.length, 1)
})

test('certificado de quem não participou da nota', async (t) => {
  const c = chaveNfe(FORNECEDOR, 6)
  const { db, id, servico, limpar } = montar({ respostas: { [c]: { motivo: 'nao-envolvido', mensagem: 'CNPJ base do certificado difere' } } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'nao-envolvido')
  assert.deepEqual([linha(db, c).situacao, linha(db, c).mensagem], ['nao-envolvido', 'CNPJ base do certificado difere'])
})

test('bloqueio da SVRS pausa 5 min, aumenta o intervalo e não gasta tentativa', async (t) => {
  const c = chaveNfe(FORNECEDOR, 7)
  const { db, id, servico, limpar } = montar({ respostas: { [c]: { motivo: 'bloqueado', mensagem: 'IP não autorizado devido múltiplas consultas' } } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'bloqueado')
  assert.deepEqual([linha(db, c).situacao, linha(db, c).tentativas], ['fila', 0])
  const e = servico.estado()
  assert.equal(e.intervaloS, 90)
  assert.equal(e.voltaAs, new Date(AGORA.getTime() + 5 * 60e3).toISOString())
})

test('erro de rede tenta 3 vezes', async (t) => {
  const c = chaveNfe(FORNECEDOR, 8)
  const falha = { motivo: 'erro', mensagem: 'Sem resposta da SVRS: socket hang up', repetir: true }
  const { db, id, servico, limpar } = montar({ respostas: { [c]: [falha, falha, falha] } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'fila')
  assert.equal(await servico.processarProxima(), 'fila')
  assert.equal(await servico.processarProxima(), 'erro')
  assert.deepEqual([linha(db, c).situacao, linha(db, c).tentativas, linha(db, c).mensagem], ['erro', 3, 'Sem resposta da SVRS: socket hang up'])
})

test('XML de homologação e certificado vencido viram erro', async (t) => {
  const c = chaveNfe(FORNECEDOR, 9)
  const { db, id, servico, limpar } = montar({ respostas: { [c]: { xml: nfeProc({ chave: c, emit: FORNECEDOR, dest: CLIENTE, tpAmb: '2' }) } } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'erro')
  assert.equal(linha(db, c).mensagem, 'nota de homologação (teste)')

  const v = montar({ validade: '2026-01-01T00:00:00Z' })
  t.after(v.limpar)
  const c2 = chaveNfe(FORNECEDOR, 10)
  v.servico.adicionar(v.id, c2)
  assert.equal(await v.servico.processarProxima(), 'erro')
  assert.equal(linha(v.db, c2).mensagem, 'Certificado vencido')
  assert.equal(v.chamadas.length, 0)
})

test('ritmo: 60 s ao iniciar e entre consultas, 5 min depois de bloqueio', async (t) => {
  const c1 = chaveNfe(FORNECEDOR, 11)
  const c2 = chaveNfe(FORNECEDOR, 12)
  const { id, servico, tempo, limpar } = montar({
    respostas: { [c1]: { motivo: 'nao-envolvido', mensagem: 'x' }, [c2]: [{ motivo: 'bloqueado', mensagem: 'y' }, { motivo: 'nao-envolvido', mensagem: 'x' }] },
  })
  t.after(limpar)
  servico.adicionar(id, `${c1} ${c2}`)
  servico.iniciar()
  assert.equal(tempo.ultimo().ms, 60000)
  await tempo.ultimo().fn()
  assert.equal(tempo.ultimo().ms, 60000)
  await tempo.ultimo().fn()
  assert.equal(tempo.ultimo().ms, 300000)
  await tempo.ultimo().fn()
  // Fila vazia: nada agendado.
  const ativos = tempo.agenda.filter((a) => a.ativo).length
  await tempo.ultimo().fn()
  assert.equal(tempo.agenda.filter((a) => a.ativo).length, ativos - 1)
})

test('sem poder rodar, verifica a cada 30 s e mostra o motivo', async (t) => {
  let motivo = 'Esperando a captura terminar'
  const c = chaveNfe(FORNECEDOR, 13)
  const { id, servico, tempo, chamadas, limpar } = montar({ podeRodar: () => motivo, respostas: { [c]: { motivo: 'nao-envolvido', mensagem: 'x' } } })
  t.after(limpar)
  servico.adicionar(id, c)
  servico.iniciar()
  await tempo.ultimo().fn()
  assert.equal(tempo.ultimo().ms, 30000)
  assert.equal(servico.estado().motivo, 'Esperando a captura terminar')
  assert.equal(chamadas.length, 0)
  motivo = null
  await tempo.ultimo().fn()
  assert.equal(chamadas.length, 1)
  assert.equal(servico.estado().motivo, null)
})

test('pausa vale depois de reabrir e continuar agenda de novo', async (t) => {
  const c = chaveNfe(FORNECEDOR, 14)
  const { id, servico, tempo, criar, limpar } = montar()
  t.after(limpar)
  servico.adicionar(id, c)
  servico.iniciar()
  servico.pausar()
  assert.equal(tempo.agenda.filter((a) => a.ativo).length, 0)
  const reaberto = criar()
  reaberto.iniciar()
  assert.equal(reaberto.estado().pausada, true)
  assert.equal(tempo.agenda.filter((a) => a.ativo).length, 0)
  reaberto.continuar()
  assert.equal(reaberto.estado().pausada, false)
  assert.equal(tempo.agenda.filter((a) => a.ativo).length, 1)
})

test('pausar no meio de uma consulta deixa terminar e não agenda a próxima', async (t) => {
  const c = chaveNfe(FORNECEDOR, 15)
  let soltar
  const { db, id, servico, tempo, limpar } = montar({ respostas: { [c]: new Promise((r) => (soltar = r)) } })
  t.after(limpar)
  servico.adicionar(id, `${c} ${chaveNfe(FORNECEDOR, 16)}`)
  servico.iniciar()
  const rodada = tempo.ultimo().fn()
  servico.pausar()
  soltar({ motivo: 'nao-envolvido', mensagem: 'x' })
  await rodada
  assert.equal(linha(db, c).situacao, 'nao-envolvido')
  assert.equal(tempo.agenda.filter((a) => a.ativo).length, 0)
})

test('limpar concluídas e cliente excluído', async (t) => {
  const { db, id, servico, limpar } = montar()
  t.after(limpar)
  const cs = [17, 18, 19, 20].map((n) => chaveNfe(FORNECEDOR, n))
  servico.adicionar(id, cs.join(' '))
  const set = db.prepare('UPDATE busca_antiga SET situacao = ? WHERE chave = ?')
  set.run('baixada', cs[0])
  set.run('ja-existia', cs[1])
  set.run('erro', cs[2])
  assert.equal(servico.limparConcluidas(), 2)
  assert.deepEqual(servico.listar().map((l) => l.situacao).sort(), ['erro', 'fila'])
  assert.equal(servico.listar({ situacao: 'erro' }).length, 1)
  assert.equal(servico.listar()[0].nome, 'Cliente')
  db.prepare('DELETE FROM clientes WHERE id = ?').run(id)
  assert.equal(await servico.processarProxima(), null)
  assert.equal(servico.estado().total, 0)
})

// ---------- correções da revisão final ----------

test('reabrir o app respeita o intervalo desde a última consulta', async (t) => {
  const c1 = chaveNfe(FORNECEDOR, 21)
  const c2 = chaveNfe(FORNECEDOR, 22)
  const { id, servico, tempo, criar, limpar } = montar({ respostas: { [c1]: { motivo: 'nao-envolvido', mensagem: 'x' } } })
  t.after(limpar)
  servico.adicionar(id, `${c1} ${c2}`)
  await servico.processarProxima()
  servico.pausar()
  const reaberto = criar()
  reaberto.iniciar()
  reaberto.continuar()
  assert.equal(tempo.ultimo().ms, 60000)
})

test('bloqueio e intervalo sobrevivem a reabrir o app', async (t) => {
  const c = chaveNfe(FORNECEDOR, 23)
  const { id, servico, criar, limpar } = montar({ respostas: { [c]: { motivo: 'bloqueado', mensagem: 'y' } } })
  t.after(limpar)
  servico.adicionar(id, c)
  await servico.processarProxima()
  const e = criar().estado()
  assert.equal(e.intervaloS, 90)
  assert.equal(e.voltaAs, new Date(AGORA.getTime() + 5 * 60e3).toISOString())
})

test('SVRS sem resposta 3 vezes seguidas pausa a fila sem gastar tentativas', async (t) => {
  const c = chaveNfe(FORNECEDOR, 24)
  const fora = { motivo: 'erro', mensagem: 'Sem resposta da SVRS: ENOTFOUND', repetir: true, semResposta: true }
  const { db, id, servico, limpar } = montar({ respostas: { [c]: [fora, fora, fora] } })
  t.after(limpar)
  servico.adicionar(id, c)
  assert.equal(await servico.processarProxima(), 'fila')
  assert.equal(await servico.processarProxima(), 'fila')
  assert.equal(await servico.processarProxima(), 'bloqueado')
  assert.deepEqual([linha(db, c).situacao, linha(db, c).tentativas], ['fila', 0])
  const e = servico.estado()
  assert.equal(e.voltaAs, new Date(AGORA.getTime() + 5 * 60e3).toISOString())
  assert.equal(e.pausaPor, 'sem-resposta')
})

test('intervalo de demonstração só vale com a SEFAZ simulada', (t) => {
  const real = montar({ config: { buscaAntigaIntervaloMs: 3000 } })
  t.after(real.limpar)
  assert.equal(real.servico.estado().intervaloS, 60)
  const demo = montar({ config: { buscaAntigaIntervaloMs: 3000, sefazMock: true } })
  t.after(demo.limpar)
  assert.equal(demo.servico.estado().intervaloS, 3)
})

test('excluir linhas marcadas', (t) => {
  const { db, id, servico, limpar } = montar()
  t.after(limpar)
  const cs = [31, 32, 33].map((n) => chaveNfe(FORNECEDOR, n))
  servico.adicionar(id, cs.join(' '))
  const ids = [linha(db, cs[0]).id, linha(db, cs[2]).id]
  assert.equal(servico.excluir([...ids, 9999, 'x']), 2)
  assert.deepEqual(servico.listar().map((l) => l.chave), [cs[1]])
  assert.equal(servico.excluir([]), 0)
})
