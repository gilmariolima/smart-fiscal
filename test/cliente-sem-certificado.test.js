'use strict'

const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { criarServicoClientes } = require('../src/services/clientes')
const { criarServicoResumo } = require('../src/services/resumo')
const { montarAmbiente } = require('./apoio/ambiente')
const { gerarPfx } = require('./apoio/certificado')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const SEM = '27865757000102'

function montar(t) {
  const usados = []
  const pastaCerts = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-certs-'))
  t.after(() => fs.rmSync(pastaCerts, { recursive: true, force: true }))
  const amb = montarAmbiente({ config: { pastaCerts, masterKey: 'a'.repeat(64) } })
  t.after(amb.limpar)
  const espiar = (f) => (c) => (usados.push(c.cnpj), f(c))
  const deps = { ...amb.deps, fabricaSefaz: espiar(amb.deps.fabricaSefaz), fabricaAdn: espiar(amb.deps.fabricaAdn), fabricaCte: espiar(amb.deps.fabricaCte) }
  const clientes = criarServicoClientes(deps)
  return { amb, deps, usados, clientes, ciclo: criarServicoCiclo(deps) }
}

test('cadastrar sem certificado grava a linha sem arquivo nem senha', (t) => {
  const { amb, clientes } = montar(t)
  const r = clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE', apelido: 'Sem Cert' })
  assert.equal(r.certificado, null)
  const linha = amb.db.prepare('SELECT cert_arquivo, cert_senha_enc, cert_validade, ativo FROM clientes WHERE cnpj = ?').get(SEM)
  assert.deepEqual({ ...linha }, { cert_arquivo: '', cert_senha_enc: '', cert_validade: null, ativo: 1 }, 'nasce ativo: a captura já o pula por não ter certificado')
})

test('sem certificado desativa e reativa; adicionar o certificado mantém a escolha', (t) => {
  const { clientes } = montar(t)
  clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })
  clientes.definirAtivo(SEM, false)
  assert.equal(clientes.obter(SEM).ativo, 0)
  const cert = gerarPfx({ cnpj: SEM })
  clientes.trocarCertificado({ cnpj: SEM, pfx: cert.pfx, senha: cert.senha })
  assert.equal(clientes.obter(SEM).ativo, 0, 'desativado por escolha continua desativado')
  clientes.definirAtivo(SEM, true)
  assert.equal(clientes.obter(SEM).ativo, 1)
})

test('trocar o certificado de um cliente desativado por escolha não o reativa', (t) => {
  const { clientes } = montar(t)
  clientes.definirAtivo(CNPJ_MOCK_OK, false)
  const cert = gerarPfx({ cnpj: CNPJ_MOCK_OK })
  clientes.trocarCertificado({ cnpj: CNPJ_MOCK_OK, pfx: cert.pfx, senha: cert.senha })
  assert.equal(clientes.obter(CNPJ_MOCK_OK).ativo, 0)
})

test('o ciclo não consulta a SEFAZ de quem não tem certificado, nos horários nem pela lista', async (t) => {
  const { usados, clientes, ciclo } = montar(t)
  clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })

  const todos = await ciclo.executarCiclo({ automatica: true })
  assert.equal(todos.ok, true)
  assert.ok(usados.includes(CNPJ_MOCK_OK), 'quem tem certificado continua')
  assert.ok(!usados.includes(SEM))
  assert.ok(!todos.clientes.some((c) => c.cnpj === SEM))

  const lista = await ciclo.executarCiclo({ cnpjs: [SEM, CNPJ_MOCK_OK] })
  assert.ok(!lista.clientes.some((c) => c.cnpj === SEM))
  assert.ok(!usados.includes(SEM))

  const um = await ciclo.executarCiclo({ cnpj: SEM })
  assert.equal(um.ok, false)
  assert.match(um.erro, /sem certificado/i)
})

test('o resumo não conta quem não tem certificado como vencido nem a vencer', (t) => {
  const { amb, deps, clientes } = montar(t)
  clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })
  amb.db.prepare('UPDATE clientes SET cert_validade = ? WHERE cnpj = ?').run('2030-01-01T00:00:00.000Z', CNPJ_MOCK_OK)
  const r = criarServicoResumo(deps).resumo()
  assert.equal(r.certificados.total, 1)
  assert.equal(r.certificados.vencidos, 0)
  assert.ok(!r.certificadosVencendo.some((c) => c.cnpj === SEM))
})

test('agenda do Início não lista quem não tem certificado', (t) => {
  const { deps, clientes } = montar(t)
  clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })
  const agenda = criarServicoResumo(deps).resumo().agenda.map((c) => c.cnpj)
  assert.ok(agenda.includes(CNPJ_MOCK_OK))
  assert.ok(!agenda.includes(SEM))
})

test('banco antigo: sem certificado desativado volta ativo uma vez só', (t) => {
  const { abrirBanco } = require('../src/db')
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-banco-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const arquivo = path.join(pasta, 'nfe.db')
  let db = abrirBanco(arquivo)
  db.prepare("INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc, ativo) VALUES (?, 'Sem Cert', 'CE', '', '', 0)").run(SEM)
  db.prepare("DELETE FROM sistema WHERE chave = 'sem_certificado_ativos'").run()
  db.close()
  db = abrirBanco(arquivo)
  assert.equal(db.prepare('SELECT ativo FROM clientes WHERE cnpj = ?').get(SEM).ativo, 1)
  db.prepare('UPDATE clientes SET ativo = 0 WHERE cnpj = ?').run(SEM)
  db.close()
  db = abrirBanco(arquivo)
  assert.equal(db.prepare('SELECT ativo FROM clientes WHERE cnpj = ?').get(SEM).ativo, 0, 'desativar depois da migração vale')
  db.close()
})

// ---- captura de NFS-e por procuração (Tarefa 3) ----

const { nfse: nfseDoc, chaveNfse: chaveNfseProc, PRESTADOR_MOCK: PRESTADOR_PROC } = require('../src/sefaz/adn-mock')

function comProcurador(t, { procurador = true } = {}) {
  const r = montar(t)
  r.clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })
  r.amb.db.prepare('UPDATE clientes SET auto_nfe = 1, auto_nfse = 1, auto_cte = 1 WHERE cnpj = ?').run(SEM)
  r.amb.adn.adicionar(SEM, [nfseDoc({ chave: chaveNfseProc(PRESTADOR_PROC, 1), prestador: PRESTADOR_PROC, tomador: SEM })])
  if (procurador) r.amb.db.prepare("INSERT INTO procuradores (arquivo, senha_enc, titular) VALUES ('p.pfx', 'x', 'PROCURADOR')").run()
  return r
}
const linhaDe = (res, cnpj) => res.clientes.find((c) => c.cnpj === cnpj)

test('com procurador, cliente sem A1 roda só NFS-e no ciclo automático', async (t) => {
  const { ciclo } = comProcurador(t)
  const res = await ciclo.executarCiclo({ automatica: true })
  const linha = linhaDe(res, SEM)
  assert.ok(linha, 'o cliente sem A1 entrou no ciclo')
  assert.ok(linha.nfse, 'rodou NFS-e')
  assert.ok(!('captura' in linha) && !('cte' in linha), 'não rodou NF-e nem CT-e')
})

test('sem procurador, cliente sem A1 continua fora', async (t) => {
  const { ciclo } = comProcurador(t, { procurador: false })
  const res = await ciclo.executarCiclo({ automatica: true })
  assert.ok(!linhaDe(res, SEM), 'sem procurador, fica fora do ciclo')
})

test('auto_nfse = 0 no cliente sem A1 é respeitado', async (t) => {
  const { ciclo, amb } = comProcurador(t)
  amb.db.prepare('UPDATE clientes SET auto_nfse = 0 WHERE cnpj = ?').run(SEM)
  const res = await ciclo.executarCiclo({ automatica: true })
  const linha = linhaDe(res, SEM)
  assert.ok(linha && linha.pulado, 'pulado por auto_nfse 0')
})

test('captura manual de CNPJ sem A1 vale com procurador e erra sem ele', async (t) => {
  const { ciclo } = comProcurador(t)
  const com = await ciclo.executarCiclo({ cnpj: SEM })
  assert.ok(linhaDe(com, SEM)?.nfse, 'NFS-e pelo procurador')

  const semProc = comProcurador(t, { procurador: false })
  const sem = await semProc.ciclo.executarCiclo({ cnpj: SEM })
  assert.equal(sem.ok, false)
  assert.match(sem.erro, /sem certificado/i)
})
