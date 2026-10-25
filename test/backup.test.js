'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')
const { criarServicoBackup, MANTER_DIARIOS } = require('../src/services/backup')
const { montarAmbiente, inserirNotas, silencioso } = require('./apoio/ambiente')

const HORA = 3600e3

function montar(t, { semPasta = false } = {}) {
  const amb = montarAmbiente()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-backup-'))
  t.after(() => {
    amb.limpar()
    fs.rmSync(base, { recursive: true, force: true })
  })
  const raiz = path.join(base, 'raiz')
  const pastaCerts = path.join(base, 'certs')
  fs.mkdirSync(raiz)
  fs.mkdirSync(pastaCerts)
  fs.writeFileSync(path.join(raiz, '.env'), 'MASTER_KEY=abc\n')
  fs.writeFileSync(path.join(pastaCerts, '11222333000181.pfx'), 'pfx')
  const gravarXml = (rel, conteudo = '<nfe/>') => {
    const destino = path.join(amb.pastaXmls, rel)
    fs.mkdirSync(path.dirname(destino), { recursive: true })
    fs.writeFileSync(destino, conteudo)
  }
  gravarXml('11222333000181_Exemplo/2026-10/1-nfe.xml')
  gravarXml('11222333000181_Exemplo/2026-10/2-nfe.xml')
  inserirNotas(amb.db, amb.ids[0], 3)
  const pastaBackup = semPasta ? null : path.join(base, 'backup')
  let agora = new Date('2026-10-13T15:00:00Z')
  const servico = criarServicoBackup({
    db: amb.db,
    config: { ...amb.deps.config, raiz, pastaCerts, pastaBackup },
    logger: silencioso,
    agora: () => agora,
  })
  return { amb, servico, pastaBackup, gravarXml, avancar: (ms) => (agora = new Date(agora.getTime() + ms)), definir: (d) => (agora = new Date(d)) }
}

const diarios = (pastaBackup) => fs.readdirSync(path.join(pastaBackup, 'diarios')).sort()
const ultimaExecucao = (db) => db.prepare("SELECT * FROM execucoes WHERE tipo = 'backup' ORDER BY id DESC LIMIT 1").get()

test('primeiro backup: espelho dos XMLs e cópia do dia com banco, certificados e .env', async (t) => {
  const m = montar(t)
  const r = await m.servico.fazerBackup()
  assert.equal(r.ok, true)
  assert.equal(r.xmlsNovos, 2)
  assert.equal(fs.readFileSync(path.join(m.pastaBackup, 'xmls', '11222333000181_Exemplo', '2026-10', '1-nfe.xml'), 'utf8'), '<nfe/>')
  // Dia no horário de Brasília: 15:00Z = 12:00 em 13/10.
  assert.deepEqual(diarios(m.pastaBackup), ['2026-10-13'])
  const dia = path.join(m.pastaBackup, 'diarios', '2026-10-13')
  assert.equal(fs.readFileSync(path.join(dia, '.env'), 'utf8'), 'MASTER_KEY=abc\n')
  assert.equal(fs.readFileSync(path.join(dia, 'certs', '11222333000181.pfx'), 'utf8'), 'pfx')
  const copia = new Database(path.join(dia, 'nfe.db'), { readonly: true })
  const notas = copia.prepare('SELECT COUNT(*) n FROM notas').get().n
  copia.close()
  assert.equal(notas, 3, 'o banco copiado abre e tem os dados')

  const e = ultimaExecucao(m.amb.db)
  assert.ok(e.fim)
  assert.equal(e.erro, null)
  assert.equal(e.docs_recebidos, 2)
  assert.match(e.x_motivo, /2 XMLs novos/)
})

test('segundo backup no mesmo dia é pulado; forçado, copia só os XMLs novos e refaz a cópia do dia', async (t) => {
  const m = montar(t)
  await m.servico.fazerBackup()
  m.gravarXml('11222333000181_Exemplo/2026-10/3-nfe.xml')
  m.avancar(2 * HORA)
  const pulado = await m.servico.fazerBackup()
  assert.equal(pulado.pulado, true)
  assert.equal(m.amb.db.prepare("SELECT COUNT(*) n FROM execucoes WHERE tipo = 'backup'").get().n, 1, 'pular não registra execução')

  const forcado = await m.servico.fazerBackup({ forcar: true })
  assert.equal(forcado.xmlsNovos, 1)
  assert.deepEqual(diarios(m.pastaBackup), ['2026-10-13'])
})

test('XML apagado do PC continua no backup; XML que mudou de tamanho é copiado de novo', async (t) => {
  const m = montar(t)
  await m.servico.fazerBackup()
  fs.rmSync(path.join(m.amb.pastaXmls, '11222333000181_Exemplo', '2026-10', '1-nfe.xml'))
  m.gravarXml('11222333000181_Exemplo/2026-10/2-nfe.xml', '<nfe>completa</nfe>')
  const r = await m.servico.fazerBackup({ forcar: true })
  assert.equal(r.xmlsNovos, 1)
  const espelho = path.join(m.pastaBackup, 'xmls', '11222333000181_Exemplo', '2026-10')
  assert.ok(fs.existsSync(path.join(espelho, '1-nfe.xml')))
  assert.equal(fs.readFileSync(path.join(espelho, '2-nfe.xml'), 'utf8'), '<nfe>completa</nfe>')
})

test(`rodízio: guarda só as ${MANTER_DIARIOS} cópias diárias mais recentes`, async (t) => {
  const m = montar(t)
  fs.mkdirSync(path.join(m.pastaBackup, 'diarios', 'outra-pasta'), { recursive: true })
  for (let i = 0; i < MANTER_DIARIOS + 3; i++) {
    m.definir(new Date(Date.UTC(2026, 8, 1 + i, 15)))
    await m.servico.fazerBackup()
  }
  const lista = diarios(m.pastaBackup)
  assert.equal(lista.length, MANTER_DIARIOS + 1, 'pastas com outro nome não são mexidas')
  assert.ok(lista.includes('outra-pasta'))
  assert.ok(!lista.includes('2026-09-01'))
  assert.ok(lista.includes('2026-10-03'))
})

test('sem PASTA_BACKUP o backup fica desligado e o estado avisa', async (t) => {
  const m = montar(t, { semPasta: true })
  const r = await m.servico.fazerBackup()
  assert.equal(r.ok, false)
  assert.equal(r.desligado, true)
  const e = m.servico.estado()
  assert.equal(e.configurado, false)
  assert.match(e.alerta, /PASTA_BACKUP/)
})

test('pasta indisponível: erro registrado na execução e no alerta', async (t) => {
  const m = montar(t)
  // Um arquivo no lugar da pasta faz o mkdir falhar (como um pendrive desconectado).
  fs.mkdirSync(path.dirname(m.pastaBackup), { recursive: true })
  fs.writeFileSync(m.pastaBackup, 'não é pasta')
  const r = await m.servico.fazerBackup()
  assert.equal(r.ok, false)
  assert.match(r.erro, /pasta de backup/i)
  const e = ultimaExecucao(m.amb.db)
  assert.ok(e.fim)
  assert.match(e.erro, /pasta de backup/i)
  assert.match(m.servico.estado().alerta, /último backup falhou/i)
})

test('estado: em dia sem alerta; mais de 2 dias sem backup avisa', async (t) => {
  const m = montar(t)
  assert.match(m.servico.estado().alerta, /nenhum backup/i)
  await m.servico.fazerBackup()
  const ok = m.servico.estado()
  assert.equal(ok.configurado, true)
  assert.equal(ok.alerta, null)
  assert.ok(ok.ultimoEm)
  m.avancar(3 * 24 * HORA)
  assert.match(m.servico.estado().alerta, /3 dias/)
})
