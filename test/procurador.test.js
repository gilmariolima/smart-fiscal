'use strict'

const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { criarServicoClientes, lerProcuradores } = require('../src/services/clientes')
const { criarFabricaAdn } = require('../src/sefaz/adn')
const { abrirBanco } = require('../src/db')
const { criptografar } = require('../src/crypto')
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

const ecpf = (razao, senha = 's', extra = {}) => gerarPfx({ comSan: false, comCnpjNoCn: false, razao, senha, ...extra })

test('adicionarProcurador grava arquivo e linha, sem expor a senha', (t) => {
  const { clientes, config, db } = montar(t)
  const cert = ecpf('MARCOS AURELIO', 'segredo')
  const r = clientes.adicionarProcurador({ pfx: cert.pfx, senha: 'segredo' })
  assert.ok(r.id && r.titular && r.validade)
  const linha = db.prepare('SELECT * FROM procuradores WHERE id = ?').get(r.id)
  assert.ok(fs.existsSync(path.join(config.pastaCerts, linha.arquivo)))
  assert.notEqual(linha.senha_enc, 'segredo')
  const lista = clientes.listarProcuradores()
  assert.equal(lista.length, 1)
  assert.deepEqual(Object.keys(lista[0]).sort(), ['diasParaVencer', 'id', 'titular', 'validade'])
  assert.ok(!JSON.stringify(lista).includes('segredo'))
})

test('vários procuradores; o mesmo certificado duas vezes é recusado', (t) => {
  const { clientes } = montar(t)
  const a = ecpf('MARCOS AURELIO')
  clientes.adicionarProcurador({ pfx: a.pfx, senha: 's' })
  clientes.adicionarProcurador({ pfx: ecpf('JOANA SILVA').pfx, senha: 's' })
  assert.deepEqual(clientes.listarProcuradores().map((p) => p.titular.split(' ')[0]).sort(), ['JOANA', 'MARCOS'])
  assert.throws(() => clientes.adicionarProcurador({ pfx: a.pfx, senha: 's' }), /já está cadastrado/)
})

test('procurador vencido é recusado no cadastro', (t) => {
  const { clientes } = montar(t)
  assert.throws(() => clientes.adicionarProcurador({ pfx: ecpf('X', 's', { diasValidade: -60 }).pfx, senha: 's' }), /vencido/i)
})

test('removerProcurador apaga arquivo e linha e solta os clientes que usavam', (t) => {
  const { clientes, config, db } = montar(t)
  const r = clientes.adicionarProcurador({ pfx: ecpf('MARCOS').pfx, senha: 's' })
  const arquivo = db.prepare('SELECT arquivo FROM procuradores WHERE id = ?').pluck().get(r.id)
  const cli = db.prepare("INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc, procurador_id) VALUES ('10539120001430', 'S', 'CE', '', '', ?)").run(r.id).lastInsertRowid
  clientes.removerProcurador(r.id)
  assert.ok(!fs.existsSync(path.join(config.pastaCerts, arquivo)))
  assert.deepEqual(clientes.listarProcuradores(), [])
  assert.equal(db.prepare('SELECT procurador_id FROM clientes WHERE id = ?').pluck().get(cli), null)
  assert.equal(clientes.obterProcurador(), null)
})

test('lerProcuradores devolve pfx e senha de cada um', (t) => {
  const { clientes, config, db } = montar(t)
  assert.deepEqual(lerProcuradores({ db, config }), [])
  clientes.adicionarProcurador({ pfx: ecpf('MARCOS', 'minha-senha').pfx, senha: 'minha-senha' })
  const [p] = lerProcuradores({ db, config })
  assert.ok(Buffer.isBuffer(p.pfx) && p.pfx.length > 0)
  assert.equal(p.passphrase, 'minha-senha')
  assert.equal(p.vencido, false)
})

test('procurador cadastrado antes (linhas em sistema) vira o primeiro da lista', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-proc-mig-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const caminho = path.join(dir, 'nfe.db')
  const antigo = abrirBanco(caminho)
  const ins = antigo.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)')
  ins.run('procurador_senha_enc', 'iv:tag:dados')
  ins.run('procurador_titular', 'MARCOS AURELIO')
  ins.run('procurador_validade', '2027-08-01T00:00:00.000Z')
  antigo.prepare('DELETE FROM procuradores').run()
  antigo.close()
  const db = abrirBanco(caminho)
  const linhas = db.prepare('SELECT arquivo, senha_enc, titular, validade FROM procuradores').all()
  assert.deepEqual(linhas.map((l) => ({ ...l })), [{ arquivo: 'procurador.pfx', senha_enc: 'iv:tag:dados', titular: 'MARCOS AURELIO', validade: '2027-08-01T00:00:00.000Z' }])
  assert.equal(db.prepare("SELECT COUNT(*) FROM sistema WHERE chave LIKE 'procurador_%'").pluck().get(), 0)
  db.close()
})

// ---- escolha do procurador na captura de NFS-e ----

// Cliente do ADN falso: cada procurador responde conforme `respostas[titular]`.
function fabricaFalsa(config, procuradores, respostas, lembrados = []) {
  const usados = []
  const fabrica = criarFabricaAdn(config, () => procuradores, {
    lembrar: (clienteId, procId) => lembrados.push([clienteId, procId]),
    criarCliente: ({ cnpj, passphrase }) => ({
      cnpj,
      consultarLote: async () => (usados.push(passphrase), respostas[passphrase]),
    }),
  })
  return { fabrica, usados, lembrados }
}

const ok = { ok: true, status: 'NENHUM_DOCUMENTO_LOCALIZADO', documentos: [], erro: null }
const semProcuracao = { ok: false, status: null, documentos: [], erro: 'E2245 Contribuinte sem procuração' }
const proc = (id, passphrase, vencido = false) => ({ id, titular: passphrase.toUpperCase(), pfx: Buffer.from('x'), passphrase, vencido })

test('cliente sem certificado tenta os procuradores até um ter procuração e guarda qual serviu', async (t) => {
  const { config } = montar(t)
  const { fabrica, usados, lembrados } = fabricaFalsa(config, [proc(1, 'ana'), proc(2, 'bia')], { ana: semProcuracao, bia: ok })
  const adn = fabrica({ id: 7, cnpj: '10539120001430', cert_arquivo: '' })
  assert.deepEqual(await adn.consultarLote('0'), ok)
  assert.deepEqual(usados, ['ana', 'bia'])
  assert.deepEqual(lembrados, [[7, 2]])
  // O próximo lote da mesma captura já vai direto no que serviu.
  await adn.consultarLote('5')
  assert.deepEqual(usados, ['ana', 'bia', 'bia'])
})

test('o procurador guardado no cliente é tentado primeiro', async (t) => {
  const { config } = montar(t)
  const { fabrica, usados, lembrados } = fabricaFalsa(config, [proc(1, 'ana'), proc(2, 'bia')], { ana: ok, bia: ok })
  await fabrica({ id: 7, cnpj: '10539120001430', cert_arquivo: '', procurador_id: 2 }).consultarLote('0')
  assert.deepEqual(usados, ['bia'])
  assert.deepEqual(lembrados, [])
})

test('nenhum procurador com procuração dá E2245; vencido não é usado', async (t) => {
  const { config } = montar(t)
  const { fabrica, usados } = fabricaFalsa(config, [proc(1, 'ana'), proc(2, 'velho', true)], { ana: semProcuracao, velho: ok })
  const r = await fabrica({ id: 7, cnpj: '10539120001430', cert_arquivo: '' }).consultarLote('0')
  assert.equal(r.ok, false)
  assert.match(r.erro, /E2245/)
  assert.deepEqual(usados, ['ana'])
})

test('outro erro do ADN não troca de procurador', async (t) => {
  const { config } = montar(t)
  const caiu = { ok: false, status: null, documentos: [], erro: 'Sem conexão com o ADN: ECONNRESET' }
  const { fabrica, usados } = fabricaFalsa(config, [proc(1, 'ana'), proc(2, 'bia')], { ana: caiu, bia: ok })
  assert.deepEqual(await fabrica({ id: 7, cnpj: '10539120001430', cert_arquivo: '' }).consultarLote('0'), caiu)
  assert.deepEqual(usados, ['ana'])
})

test('sem procurador, ou só vencidos, o cliente fica indisponível', async (t) => {
  const { config } = montar(t)
  const vazio = await criarFabricaAdn(config, () => [])({ cnpj: '10539120001430', cert_arquivo: '' }).consultarLote(0)
  assert.match(vazio.erro, /indispon/i)
  const vencidos = await criarFabricaAdn(config, () => [proc(1, 'velho', true)])({ cnpj: '10539120001430', cert_arquivo: '' }).consultarLote(0)
  assert.match(vencidos.erro, /procurador vencido/i)
})

test('cliente com certificado próprio não usa procurador', (t) => {
  const { config } = montar(t)
  let chamado = 0
  const fabrica = criarFabricaAdn(config, () => (chamado++, [proc(1, 'ana')]))
  const comCert = gerarPfx({ cnpj: CNPJ_MOCK_OK, senha: 'c' })
  fs.writeFileSync(path.join(config.pastaCerts, `${CNPJ_MOCK_OK}.pfx`), comCert.pfx)
  fabrica({ cnpj: CNPJ_MOCK_OK, cert_arquivo: `${CNPJ_MOCK_OK}.pfx`, cert_senha_enc: criptografar('c', config.masterKey) })
  assert.equal(chamado, 0)
})

test('cliente com certificado vencido usa o procurador; sem procurador, fica com o dele', async (t) => {
  const { config } = montar(t)
  const vencido = { id: 9, cnpj: '10539120001430', cert_arquivo: 'velho.pfx', cert_senha_enc: 'x', cert_validade: '2020-01-01T00:00:00.000Z' }
  const { fabrica, usados, lembrados } = fabricaFalsa(config, [proc(1, 'ana')], { ana: ok })
  assert.deepEqual(await fabrica(vencido).consultarLote('0'), ok)
  assert.deepEqual(usados, ['ana'])
  assert.deepEqual(lembrados, [[9, 1]])
  // Sem procurador: segue o certificado do cliente (o arquivo não existe aqui, então fica indisponível, sem tentar procurador).
  const r = await criarFabricaAdn(config, () => [])(vencido).consultarLote('0')
  assert.equal(r.ok, false)
  assert.doesNotMatch(r.erro, /procurador/)
})
