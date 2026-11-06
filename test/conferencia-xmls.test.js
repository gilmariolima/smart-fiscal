'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { criarConferenciaXmls } = require('../src/services/conferenciaXmls')
const { montarAmbiente, inserirNotas } = require('./apoio/ambiente')

function registrador() {
  const linhas = []
  const anota = (nivel) => (msg, dados) => linhas.push({ nivel, msg, dados })
  return { linhas, info: anota('info'), warn: anota('warn'), error: anota('error') }
}

function montar(t) {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const [comArquivo, semArquivo] = inserirNotas(amb.db, amb.ids[0], 3)
  const relativo = path.join('Empresa', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'a.xml')
  fs.mkdirSync(path.join(amb.pastaXmls, path.dirname(relativo)), { recursive: true })
  fs.writeFileSync(path.join(amb.pastaXmls, relativo), '<x/>')
  const apontar = amb.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?')
  apontar.run(relativo, comArquivo)
  apontar.run(path.join('Empresa', '2026', '10-Outubro', 'NF-e', 'Entradas', 'XML', 'sumiu.xml'), semArquivo)
  return { amb, logger: registrador() }
}

test('conta os XMLs que o banco conhece e os que faltam no disco', async (t) => {
  const { amb, logger } = montar(t)
  const r = await criarConferenciaXmls({ ...amb.deps, logger }).conferir()
  assert.deepEqual({ conferidos: r.conferidos, faltando: r.faltando }, { conferidos: 2, faltando: 1 })
  assert.equal(logger.linhas.at(-1).nivel, 'warn')
  assert.deepEqual(logger.linhas.at(-1).dados, { conferidos: 2, faltando: 1, notasFaltando: 1, eventosFaltando: 0 })
})

test('tudo no lugar fica registrado como informação', async (t) => {
  const { amb, logger } = montar(t)
  amb.db.prepare("UPDATE notas SET caminho_xml = NULL WHERE caminho_xml LIKE '%sumiu%'").run()
  const r = await criarConferenciaXmls({ ...amb.deps, logger }).conferir()
  assert.equal(r.faltando, 0)
  assert.equal(logger.linhas.at(-1).nivel, 'info')
})

test('pasta indisponível (rede desconectada) não acusa falta', async (t) => {
  const { amb, logger } = montar(t)
  const config = { ...amb.deps.config, pastaXmls: path.join(amb.pastaXmls, 'nao-existe') }
  const r = await criarConferenciaXmls({ ...amb.deps, config, logger }).conferir()
  assert.equal(r.pulada, true)
  assert.equal(logger.linhas.filter((l) => l.dados?.faltando).length, 0)
})

test('parar durante a conferência interrompe antes de fechar o banco', async (t) => {
  const { amb, logger } = montar(t)
  const conferencia = criarConferenciaXmls({ ...amb.deps, logger })
  const andando = conferencia.conferir()
  await conferencia.parar()
  const r = await andando
  assert.equal(r.interrompida, true)
})
