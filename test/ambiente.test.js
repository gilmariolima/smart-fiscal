'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { verificarAmbiente, ambienteDoBanco, passarParaProducao, previaProducao } = require('../src/ambiente')
const { criarPrograma } = require('../src/cli')
const { montarAmbiente, inserirNotas, silencioso } = require('./apoio/ambiente')

const HOMOLOGACAO = { tpAmb: '2', sefazMock: false }
const PRODUCAO = { tpAmb: '1', sefazMock: false }
const SIMULADA = { tpAmb: '2', sefazMock: true }

// Banco de homologação com 1 cliente que já andou na fila, 2 notas (1 com XML) e 1 evento.
function bancoDeHomologacao(t) {
  const amb = montarAmbiente()
  t.after(amb.limpar)
  const { db, ids, pastaXmls } = amb
  verificarAmbiente(db, HOMOLOGACAO)
  db.prepare("UPDATE clientes SET ult_nsu = '000000000000005', max_nsu = '000000000000005', proxima_consulta = '2026-10-09T13:00:00Z', ultimo_erro = 'x'").run()
  const [comXml] = inserirNotas(db, ids[0], 2)
  const relativo = path.join('cliente', `${comXml}-nfe.xml`)
  fs.mkdirSync(path.join(pastaXmls, 'cliente'), { recursive: true })
  fs.writeFileSync(path.join(pastaXmls, relativo), '<nfeProc/>')
  db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(relativo, comXml)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq) VALUES (?, '210210', '1')").run(comXml)
  return { ...amb, arquivoXml: path.join(pastaXmls, relativo) }
}

test('banco novo ou vazio adota o ambiente do .env', () => {
  const { db, limpar } = montarAmbiente({ clientes: [] })
  try {
    assert.equal(verificarAmbiente(db, SIMULADA), 'simulada')
    assert.equal(ambienteDoBanco(db), 'simulada')
    // vazio: pode trocar sem perder nada
    assert.equal(verificarAmbiente(db, PRODUCAO), 'producao')
    assert.equal(ambienteDoBanco(db), 'producao')
  } finally {
    limpar()
  }
})

test('banco com dados recusa .env de outro ambiente', (t) => {
  const { db } = bancoDeHomologacao(t)
  assert.equal(verificarAmbiente(db, HOMOLOGACAO), 'homologacao')
  assert.throws(() => verificarAmbiente(db, PRODUCAO), /ambiente:producao/)
  assert.throws(() => verificarAmbiente(db, SIMULADA), /é de homologação e o \.env está em SEFAZ simulada/)
  assert.equal(ambienteDoBanco(db), 'homologacao')

  const simulado = montarAmbiente()
  t.after(simulado.limpar)
  verificarAmbiente(simulado.db, SIMULADA)
  assert.throws(() => verificarAmbiente(simulado.db, PRODUCAO), /é de SEFAZ simulada .*PASTA_DADOS/)
})

test('passar para produção zera a fila, apaga notas, eventos e XMLs de teste e mantém os clientes', (t) => {
  const { db, deps, arquivoXml } = bancoDeHomologacao(t)
  const config = { ...deps.config, ...PRODUCAO }
  assert.deepEqual(previaProducao(db), { ambienteBanco: 'homologacao', clientes: 1, notas: 2, eventos: 1 })

  const r = passarParaProducao({ db, config, logger: silencioso })
  assert.deepEqual(r, { clientes: 1, notas: 2, eventos: 1, xmls: 1 })
  assert.equal(fs.existsSync(arquivoXml), false)
  const c = db.prepare('SELECT * FROM clientes').get()
  assert.equal(c.ult_nsu, '000000000000000')
  assert.equal(c.max_nsu, null)
  assert.equal(c.proxima_consulta, null)
  assert.equal(c.ultimo_erro, null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas').get().n, 0)
  assert.equal(ambienteDoBanco(db), 'producao')
  assert.equal(verificarAmbiente(db, PRODUCAO), 'producao')

  assert.throws(() => passarParaProducao({ db, config, logger: silencioso }), /já está em produção/)
  // depois de produção, voltar para homologação no mesmo banco é recusado
  assert.throws(() => verificarAmbiente(db, HOMOLOGACAO), /é de produção/)
})

test('passar para produção exige o .env em produção e banco de homologação', (t) => {
  const { db, deps } = bancoDeHomologacao(t)
  assert.throws(() => passarParaProducao({ db, config: { ...deps.config, ...HOMOLOGACAO } }), /TP_AMB=1/)
  const simulado = montarAmbiente()
  t.after(simulado.limpar)
  verificarAmbiente(simulado.db, SIMULADA)
  assert.throws(() => passarParaProducao({ db: simulado.db, config: { ...simulado.deps.config, ...PRODUCAO } }), /só dá para passar para produção a partir de homologação/)
})

test('CLI ambiente:producao pede confirmação e aplica', async (t) => {
  const { db, deps } = bancoDeHomologacao(t)
  const ctx = { db, config: { ...deps.config, ...PRODUCAO }, logger: silencioso, fechar() {} }
  const executar = async (respostas, ...args) => {
    const saida = []
    const programa = criarPrograma({ contexto: () => ctx, log: (m) => saida.push(m), texto: async () => respostas.shift() ?? '', entradaInterativa: true })
    programa.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
    await programa.parseAsync(['node', 'cli', 'ambiente:producao', ...args])
    return saida.join('\n')
  }
  assert.match(await executar(['n']), /Cancelado/)
  assert.equal(ambienteDoBanco(db), 'homologacao')
  const saida = await executar(['s'])
  assert.match(saida, /2 nota\(s\)/)
  assert.match(saida, /Banco em produção/)
  assert.equal(ambienteDoBanco(db), 'producao')
})

test('CLI ambiente:producao com o .env em homologação recusa antes de perguntar', async (t) => {
  const { db, deps } = bancoDeHomologacao(t)
  const perguntas = []
  const programa = criarPrograma({ contexto: () => ({ db, config: { ...deps.config, ...HOMOLOGACAO }, logger: silencioso, fechar() {} }), log: () => {}, texto: async (m) => (perguntas.push(m), 's'), entradaInterativa: true })
  programa.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
  await assert.rejects(programa.parseAsync(['node', 'cli', 'ambiente:producao']), /TP_AMB=1/)
  assert.deepEqual(perguntas, [])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notas').get().n, 2)
})
