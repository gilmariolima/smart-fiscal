'use strict'

const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { criarServicoClientes, lerProcuradorCert } = require('../src/services/clientes')
const { criarFabricaAdn } = require('../src/sefaz/adn')
const { montarAmbiente } = require('./apoio/ambiente')
const { gerarPfx } = require('./apoio/certificado')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

function montar(t) {
  const pastaCerts = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-proc-'))
  t.after(() => fs.rmSync(pastaCerts, { recursive: true, force: true }))
  const amb = montarAmbiente({ config: { pastaCerts, masterKey: 'a'.repeat(64) } })
  t.after(amb.limpar)
  const clientes = criarServicoClientes(amb.deps)
  return { amb, clientes, config: amb.deps.config, db: amb.db }
}

const senhaDe = (db, chave) => db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(chave)

test('salvarProcurador grava arquivo e linhas em sistema', (t) => {
  const { clientes, config, db } = montar(t)
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, razao: 'MARCOS AURELIO', senha: 'segredo' })
  const r = clientes.salvarProcurador({ pfx: cert.pfx, senha: 'segredo' })
  assert.ok(r.titular && r.validade)
  assert.ok(fs.existsSync(path.join(config.pastaCerts, 'procurador.pfx')))
  assert.ok(senhaDe(db, 'procurador_senha_enc') && senhaDe(db, 'procurador_senha_enc') !== 'segredo')
  assert.ok(senhaDe(db, 'procurador_titular'))
  assert.ok(senhaDe(db, 'procurador_validade'))
  const info = clientes.obterProcurador()
  assert.deepEqual(Object.keys(info).sort(), ['diasParaVencer', 'titular', 'validade'])
  assert.ok(!JSON.stringify(info).includes('segredo'))
})

test('salvarProcurador recusa certificado vencido', (t) => {
  const { clientes } = montar(t)
  const vencido = gerarPfx({ comSan: false, comCnpjNoCn: false, diasValidade: -60, senha: 's' })
  assert.throws(() => clientes.salvarProcurador({ pfx: vencido.pfx, senha: 's' }), /vencido/i)
})

test('salvarProcurador aceita e-CPF sem CNPJ', (t) => {
  const { clientes } = montar(t)
  const ecpf = gerarPfx({ comSan: false, comCnpjNoCn: false, razao: 'MARCOS AURELIO TAVARES', senha: 's' })
  assert.doesNotThrow(() => clientes.salvarProcurador({ pfx: ecpf.pfx, senha: 's' }))
  assert.match(clientes.obterProcurador().titular, /MARCOS AURELIO/)
})

test('removerProcurador limpa arquivo e sistema', (t) => {
  const { clientes, config, db } = montar(t)
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, senha: 's' })
  clientes.salvarProcurador({ pfx: cert.pfx, senha: 's' })
  clientes.removerProcurador()
  assert.ok(!fs.existsSync(path.join(config.pastaCerts, 'procurador.pfx')))
  assert.equal(senhaDe(db, 'procurador_senha_enc'), undefined)
  assert.equal(clientes.obterProcurador(), null)
})

test('lerProcuradorCert devolve pfx e senha, ou null', (t) => {
  const { clientes, config, db } = montar(t)
  assert.equal(lerProcuradorCert({ db, config }), null)
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, senha: 'minha-senha' })
  clientes.salvarProcurador({ pfx: cert.pfx, senha: 'minha-senha' })
  const lido = lerProcuradorCert({ db, config })
  assert.ok(Buffer.isBuffer(lido.pfx) && lido.pfx.length > 0)
  assert.equal(lido.passphrase, 'minha-senha')
})

// ---- Tarefa 2: fabricaAdn escolhe o procurador ----

test('fabricaAdn usa o procurador para cliente sem certificado próprio', (t) => {
  const { clientes, config, db } = montar(t)
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, senha: 's' })
  clientes.salvarProcurador({ pfx: cert.pfx, senha: 's' })
  const chamado = []
  const fabrica = criarFabricaAdn(config, () => (chamado.push('proc'), lerProcuradorCert({ db, config })))

  const semCert = fabrica({ cnpj: '10539120001430', cert_arquivo: '' })
  assert.equal(semCert.cnpj, '10539120001430')
  assert.equal(chamado.length, 1, 'o procurador foi consultado para quem não tem A1')

  const comCert = gerarPfx({ cnpj: CNPJ_MOCK_OK, senha: 'c' })
  const nome = clientes.salvarCertificadoDeTeste ? null : null
  fs.writeFileSync(path.join(config.pastaCerts, `${CNPJ_MOCK_OK}.pfx`), comCert.pfx)
  const { criptografar } = require('../src/crypto')
  const cli = { cnpj: CNPJ_MOCK_OK, cert_arquivo: `${CNPJ_MOCK_OK}.pfx`, cert_senha_enc: criptografar('c', config.masterKey) }
  fabrica(cli)
  assert.equal(chamado.length, 1, 'cliente com A1 não consulta o procurador')
})

test('fabricaAdn sem procurador devolve o cliente indisponível', async (t) => {
  const { config } = montar(t)
  const fabrica = criarFabricaAdn(config, () => null)
  const r = await fabrica({ cnpj: '10539120001430', cert_arquivo: '' }).consultarLote(0)
  assert.equal(r.ok, false)
  assert.match(r.erro, /indispon/i)
})

// ---- correções da revisão ----

test('procurador vencido depois de salvo é tratado como indisponível', async (t) => {
  const { clientes, config, db } = montar(t)
  const cert = gerarPfx({ comSan: false, comCnpjNoCn: false, senha: 's' })
  clientes.salvarProcurador({ pfx: cert.pfx, senha: 's' })
  db.prepare("UPDATE sistema SET valor = '2020-01-01T00:00:00.000Z' WHERE chave = 'procurador_validade'").run()
  const fabrica = criarFabricaAdn(config, () => lerProcuradorCert({ db, config }))
  const r = await fabrica({ cnpj: '10539120001430', cert_arquivo: '' }).consultarLote(0)
  assert.equal(r.ok, false)
  assert.match(r.erro, /procurador vencido/i)
})
