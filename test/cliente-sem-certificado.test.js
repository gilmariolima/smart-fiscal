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
  assert.deepEqual({ ...linha }, { cert_arquivo: '', cert_senha_enc: '', cert_validade: null, ativo: 0 }, 'nasce desativado: não tem o que capturar')
})

test('reativar sem certificado é recusado; adicionar o certificado ativa sozinho', (t) => {
  const { clientes } = montar(t)
  clientes.cadastrar({ cnpj: SEM, razao: 'Sem Cert Ltda', uf: 'CE' })
  assert.throws(() => clientes.definirAtivo(SEM, true), /sem certificado/i)
  assert.equal(clientes.obter(SEM).ativo, 0)
  const cert = gerarPfx({ cnpj: SEM })
  clientes.trocarCertificado({ cnpj: SEM, pfx: cert.pfx, senha: cert.senha })
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
