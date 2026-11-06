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

function montar(t, { semPasta = false, comEstoque = false } = {}) {
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
  const pastaEstoque = comEstoque ? path.join(base, 'estoque') : null
  if (comEstoque) {
    fs.mkdirSync(path.join(pastaEstoque, 'saida'), { recursive: true })
    fs.writeFileSync(path.join(pastaEstoque, 'empresas.json'), '{}')
    fs.writeFileSync(path.join(pastaEstoque, 'saida', 'SPED.txt'), '|0000|')
    fs.writeFileSync(path.join(pastaEstoque, 'painel.log'), 'log')
    fs.writeFileSync(path.join(pastaEstoque, 'painel.token'), 'token')
  }
  let agora = new Date('2026-10-13T15:00:00Z')
  const avisos = []
  const servico = criarServicoBackup({
    db: amb.db,
    config: { ...amb.deps.config, raiz, pastaCerts, pastaBackup, pastaEstoque },
    logger: { ...silencioso, warn: (m) => avisos.push(m) },
    agora: () => agora,
  })
  return { amb, base, raiz, servico, pastaBackup, pastaEstoque, avisos, gravarXml, avancar: (ms) => (agora = new Date(agora.getTime() + ms)), definir: (d) => (agora = new Date(d)) }
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
  assert.match(e.alerta, /tela Backup/)
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

test('cópia do dia leva os dados do SPED, sem os logs nem o token', async (t) => {
  const m = montar(t, { comEstoque: true })
  await m.servico.fazerBackup()
  const estoque = path.join(m.pastaBackup, 'diarios', '2026-10-13', 'estoque')
  assert.equal(fs.readFileSync(path.join(estoque, 'empresas.json'), 'utf8'), '{}')
  assert.equal(fs.readFileSync(path.join(estoque, 'saida', 'SPED.txt'), 'utf8'), '|0000|')
  assert.ok(!fs.existsSync(path.join(estoque, 'painel.log')))
  assert.ok(!fs.existsSync(path.join(estoque, 'painel.token')))
  assert.equal(m.servico.estado().incluiSped, true)
})

test('pasta escolhida na tela: vale mais que o .env, testa a gravação e "nenhuma" desliga', async (t) => {
  const m = montar(t)
  assert.equal(m.servico.estado().origem, 'env')
  assert.throws(() => m.servico.definirPasta('backup'), /endereço completo/)
  assert.throws(() => m.servico.definirPasta(path.join(m.raiz, 'bkp')), /dentro da pasta de dados/)
  const bloqueio = path.join(m.base, 'arquivo')
  fs.writeFileSync(bloqueio, 'x')
  assert.throws(() => m.servico.definirPasta(path.join(bloqueio, 'sub')), /Não consegui gravar/)

  const nova = path.join(m.base, 'Backup Smart Fiscal')
  const r = m.servico.definirPasta(`"${nova}"`)
  assert.equal(r.pasta, nova)
  assert.deepEqual(fs.readdirSync(nova), [], 'o arquivo de teste é apagado')
  assert.deepEqual([m.servico.estado().pasta, m.servico.estado().origem], [nova, 'painel'])
  assert.equal((await m.servico.fazerBackup()).ok, true)
  assert.ok(fs.existsSync(path.join(nova, 'diarios', '2026-10-13', 'nfe.db')))
  assert.ok(!fs.existsSync(m.pastaBackup), 'a pasta do .env não é usada')

  assert.equal(m.servico.definirPasta('  ').pasta, null)
  assert.equal(m.servico.ativo, false)
  assert.deepEqual([m.servico.estado().configurado, m.servico.estado().origem], [false, null])
  assert.equal((await m.servico.fazerBackup()).desligado, true)
})

test('espelho copia só .xml', async (t) => {
  const m = montar(t)
  m.gravarXml('11222333000181_Exemplo/2026-10/1-nfe.pdf', 'pdf')
  m.gravarXml('11222333000181_Exemplo/2026-10/.smart-fiscal', '')
  m.gravarXml('11222333000181_Exemplo/2026-10/1.xlsx', 'x')
  const r = await m.servico.fazerBackup()
  assert.equal(r.xmlsNovos, 2)
  const espelho = path.join(m.pastaBackup, 'xmls', '11222333000181_Exemplo', '2026-10')
  assert.deepEqual(fs.readdirSync(espelho).sort(), ['1-nfe.xml', '2-nfe.xml'])
})

test('I10: pasta_saida do motor fora da pasta de dados é espelhada em sped, sem depender do nome da pasta principal', async (t) => {
  const m = montar(t, { comEstoque: true })
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-sped-'))
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }))
  const arquivo = path.join(fora, '11222333000181_X', '2026-10', 'SPED_1.txt')
  fs.mkdirSync(path.dirname(arquivo), { recursive: true })
  fs.writeFileSync(arquivo, '|0000|')
  fs.writeFileSync(path.join(m.pastaEstoque, 'config.json'), JSON.stringify({ pasta_saida: fora }))
  m.amb.db.prepare("INSERT INTO sistema (chave, valor) VALUES ('pasta_principal', ?)").run(path.join(fora, 'Contabilidade'))
  assert.equal((await m.servico.fazerBackup()).ok, true)
  const copia = path.join(m.pastaBackup, 'sped', '11222333000181_X', '2026-10', 'SPED_1.txt')
  assert.equal(fs.readFileSync(copia, 'utf8'), '|0000|')
  // O backup leva e nunca apaga.
  fs.rmSync(arquivo)
  await m.servico.fazerBackup({ forcar: true })
  assert.ok(fs.existsSync(copia), 'apagado do PC continua no backup')
})

test('I10: pasta_saida dentro da pasta de dados ou sem pasta_saida: a cópia do dia já leva, sem espelho nem aviso', async (t) => {
  const m = montar(t, { comEstoque: true })
  for (const config of [{ pasta_saida: path.join(m.pastaEstoque, 'saida') }, { pasta_saida: path.join(m.raiz, 'x') }, {}]) {
    fs.writeFileSync(path.join(m.pastaEstoque, 'config.json'), JSON.stringify(config))
    assert.equal((await m.servico.fazerBackup({ forcar: true })).ok, true)
    assert.ok(!fs.existsSync(path.join(m.pastaBackup, 'sped')))
  }
  assert.deepEqual(m.avisos, [])
})

test('I10: config.json ausente ou inválido: sem espelho, com aviso no log, e o backup termina', async (t) => {
  const m = montar(t, { comEstoque: true })
  assert.equal((await m.servico.fazerBackup()).ok, true)
  assert.ok(!fs.existsSync(path.join(m.pastaBackup, 'sped')))
  assert.match(m.avisos.at(-1), /config\.json/)
  const antes = m.avisos.length
  for (const invalido of ['{ruim', '[]', 'null']) {
    fs.writeFileSync(path.join(m.pastaEstoque, 'config.json'), invalido)
    assert.equal((await m.servico.fazerBackup({ forcar: true })).ok, true, invalido)
    assert.ok(!fs.existsSync(path.join(m.pastaBackup, 'sped')))
  }
  assert.equal(m.avisos.length, antes + 3)
})

test('I10: pasta_saida fora do ar: aviso no log e a cópia do dia sai', async (t) => {
  const m = montar(t, { comEstoque: true })
  const fora = path.join(os.tmpdir(), `nfe-sped-sumiu-${process.pid}`)
  fs.writeFileSync(path.join(m.pastaEstoque, 'config.json'), JSON.stringify({ pasta_saida: fora }))
  const r = await m.servico.fazerBackup()
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(path.join(m.pastaBackup, 'diarios', r.dia, 'nfe.db')))
  assert.ok(m.avisos.some((a) => /SPED/.test(a)), m.avisos.join('|'))
})

test('I10: erro no espelho do SPED avisa e não impede a cópia do dia', async (t) => {
  const m = montar(t, { comEstoque: true })
  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-sped-'))
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }))
  fs.writeFileSync(path.join(fora, 'SPED_1.txt'), '|0000|')
  fs.writeFileSync(path.join(m.pastaEstoque, 'config.json'), JSON.stringify({ pasta_saida: fora }))
  const original = fs.promises.copyFile
  t.mock.method(fs.promises, 'copyFile', async (de, ...resto) => {
    if (String(de).startsWith(fora)) throw Object.assign(new Error('EIO'), { code: 'EIO' })
    return original(de, ...resto)
  })
  const r = await m.servico.fazerBackup()
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(path.join(m.pastaBackup, 'diarios', r.dia, 'nfe.db')))
  assert.ok(m.avisos.some((a) => /SPED/.test(a)), m.avisos.join('|'))
})

test('sem pasta principal não há pasta sped no backup: o SPED vai na cópia do dia', async (t) => {
  const m = montar(t)
  await m.servico.fazerBackup()
  assert.ok(!fs.existsSync(path.join(m.pastaBackup, 'sped')))
})
