'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { abrirBanco } = require('../src/db')
const { lerCertificado, diasParaVencer } = require('../src/certificado')
const { criarServicoClientes, cnpjValido } = require('../src/services/clientes')
const { criarServicoResumo } = require('../src/services/resumo')
const { descriptografar } = require('../src/crypto')
const { gerarPfx } = require('./apoio/certificado')
const { silencioso } = require('./apoio/ambiente')

const CNPJ = '11222333000181'
const FILIAL = '11222333000262'
const OUTRO = '34567890000130'
const AGORA = new Date('2026-10-09T12:00:00Z')

// Gerar chave RSA é o passo lento: um certificado reaproveitado pelos testes.
const certOk = gerarPfx({ cnpj: CNPJ })

function montar() {
  const pastaCerts = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-certs-'))
  const db = abrirBanco(':memory:')
  const config = { pastaCerts, masterKey: crypto.randomBytes(32).toString('hex') }
  const servico = criarServicoClientes({ db, config, logger: silencioso, agora: () => new Date() })
  return { db, config, servico, pastaCerts, limpar: () => fs.rmSync(pastaCerts, { recursive: true, force: true }) }
}

const dados = (extra = {}) => ({ cnpj: CNPJ, razao: 'Empresa Teste Ltda', uf: 'ce', apelido: 'Teste', pfx: certOk.pfx, senha: certOk.senha, ...extra })

test('lerCertificado: CNPJ pelo SAN (otherName ICP-Brasil) ou pelo CN', () => {
  const soSan = gerarPfx({ cnpj: OUTRO, comCnpjNoCn: false })
  assert.equal(lerCertificado(soSan.pfx, soSan.senha).cnpj, OUTRO)
  const soCn = gerarPfx({ cnpj: OUTRO, comSan: false })
  const c = lerCertificado(soCn.pfx, soCn.senha)
  assert.equal(c.cnpj, OUTRO)
  assert.equal(c.titular, `EMPRESA TESTE LTDA:${OUTRO}`)
  assert.equal(c.emissor, 'AC SIMULADA PARA TESTES')
  const nenhum = gerarPfx({ comSan: false, comCnpjNoCn: false })
  assert.equal(lerCertificado(nenhum.pfx, nenhum.senha).cnpj, null)
})

test('lerCertificado: senha errada e arquivo inválido com mensagem clara', () => {
  assert.throws(() => lerCertificado(certOk.pfx, 'errada'), /Senha do certificado incorreta/)
  assert.throws(() => lerCertificado(Buffer.from('não é pfx'), 'x'), /não é um certificado/)
  assert.equal(diasParaVencer('2026-10-19T12:00:00Z', AGORA), 10)
})

test('cnpjValido confere os dígitos verificadores', () => {
  assert.equal(cnpjValido(CNPJ), true)
  assert.equal(cnpjValido('11.222.333/0001-81'), true)
  assert.equal(cnpjValido(FILIAL), true)
  assert.equal(cnpjValido('11222333000182'), false)
  assert.equal(cnpjValido('00000000000000'), false)
  assert.equal(cnpjValido('123'), false)
})

test('cadastro: copia o .pfx, criptografa a senha e nunca a devolve', (t) => {
  const m = montar()
  t.after(m.limpar)
  const r = m.servico.cadastrar(dados())
  assert.deepEqual(r.avisos, [])
  assert.equal(r.cliente.uf, 'CE')
  assert.equal(r.cliente.cert_arquivo, `${CNPJ}.pfx`)
  assert.equal(r.cliente.cert_validade, r.certificado.validade)
  assert.ok(!('cert_senha_enc' in r.cliente))
  assert.deepEqual(fs.readFileSync(path.join(m.pastaCerts, `${CNPJ}.pfx`)), certOk.pfx)

  const enc = m.db.prepare('SELECT cert_senha_enc FROM clientes').get().cert_senha_enc
  assert.ok(!enc.includes(certOk.senha))
  assert.equal(descriptografar(enc, m.config.masterKey), certOk.senha)

  const [lista] = m.servico.listar()
  assert.ok(!('cert_senha_enc' in lista))
  assert.ok(lista.cert_dias > 300)
  assert.throws(() => m.servico.cadastrar(dados()), /já cadastrado/)
})

test('cadastro recusa dados inválidos sem gravar nada', (t) => {
  const m = montar()
  t.after(m.limpar)
  const casos = [
    [dados({ cnpj: '11222333000182' }), /CNPJ inválido/],
    [dados({ razao: '  ' }), /razão social/],
    [dados({ uf: 'XX' }), /UF inválida/],
    [dados({ senha: 'errada' }), /Senha do certificado incorreta/],
    [dados({ pfx: Buffer.from('lixo') }), /não é um certificado/],
    [dados({ cnpj: OUTRO }), /de outra empresa/],
  ]
  for (const [entrada, erro] of casos) assert.throws(() => m.servico.cadastrar(entrada), erro)

  const vencido = gerarPfx({ cnpj: CNPJ, diasValidade: -1 })
  assert.throws(() => m.servico.cadastrar(dados({ pfx: vencido.pfx, senha: vencido.senha })), /vencido/)
  const semCnpj = gerarPfx({ comSan: false, comCnpjNoCn: false })
  assert.throws(() => m.servico.cadastrar(dados({ pfx: semCnpj.pfx, senha: semCnpj.senha })), /Não encontrei o CNPJ/)

  assert.equal(m.db.prepare('SELECT COUNT(*) n FROM clientes').get().n, 0)
  assert.deepEqual(fs.readdirSync(m.pastaCerts), [])
})

test('cadastro aceita filial com a mesma raiz e avisa certificado perto de vencer', (t) => {
  const m = montar()
  t.after(m.limpar)
  const r = m.servico.cadastrar(dados({ cnpj: FILIAL }))
  assert.match(r.avisos.join(' '), /matriz\/filial/)

  const quaseVencendo = gerarPfx({ cnpj: OUTRO, diasValidade: 10 })
  const r2 = m.servico.cadastrar(dados({ cnpj: OUTRO, pfx: quaseVencendo.pfx, senha: quaseVencendo.senha }))
  assert.match(r2.avisos.join(' '), /vence em (9|10) dia/)

  const resumo = criarServicoResumo({ db: m.db }).resumo()
  assert.deepEqual(resumo.certificadosVencendo.map((c) => c.cnpj), [OUTRO])
})

test('troca de certificado e ativação', (t) => {
  const m = montar()
  t.after(m.limpar)
  m.servico.cadastrar(dados())
  m.db.prepare("UPDATE clientes SET ultimo_erro = 'Senha do certificado incorreta'").run()
  const novo = gerarPfx({ cnpj: CNPJ, senha: 'nova-senha', diasValidade: 700 })
  const r = m.servico.trocarCertificado({ cnpj: CNPJ, pfx: novo.pfx, senha: novo.senha })
  assert.equal(r.cliente.ultimo_erro, null)
  assert.equal(r.cliente.cert_validade, r.certificado.validade)
  assert.deepEqual(fs.readFileSync(path.join(m.pastaCerts, `${CNPJ}.pfx`)), novo.pfx)
  assert.equal(descriptografar(m.db.prepare('SELECT cert_senha_enc FROM clientes').get().cert_senha_enc, m.config.masterKey), 'nova-senha')
  assert.throws(() => m.servico.trocarCertificado({ cnpj: OUTRO, pfx: novo.pfx, senha: novo.senha }), /não cadastrado/)

  assert.equal(m.servico.definirAtivo(CNPJ, false).ativo, 0)
  assert.equal(m.servico.definirAtivo('11.222.333/0001-81', true).ativo, 1)
  assert.throws(() => m.servico.definirAtivo(OUTRO, true), /não cadastrado/)
})

test('escritório: cadastra, recusa segundo e recusa CNPJ de cliente', (t) => {
  const m = montar()
  t.after(m.limpar)
  assert.equal(m.servico.obterEscritorio(), null)
  const { cliente } = m.servico.cadastrarEscritorio({ cnpj: CNPJ, razao: 'Contabilidade Exemplo', uf: 'ce', pfx: certOk.pfx, senha: certOk.senha })
  assert.equal(cliente.papel, 'escritorio')
  assert.equal(cliente.apelido, 'escritorio')
  assert.equal(cliente.uf, 'CE')
  assert.equal(m.servico.obterEscritorio().cnpj, CNPJ)
  assert.ok(fs.existsSync(path.join(m.pastaCerts, `${CNPJ}.pfx`)))

  assert.throws(() => m.servico.cadastrarEscritorio({ cnpj: FILIAL, razao: 'Outro', uf: 'CE', pfx: certOk.pfx, senha: certOk.senha }), /Já existe um escritório cadastrado \(11222333000181\)\./)

  const m2 = montar()
  t.after(m2.limpar)
  m2.servico.cadastrar(dados())
  assert.throws(() => m2.servico.cadastrarEscritorio({ cnpj: CNPJ, razao: 'Escritório', uf: 'CE', pfx: certOk.pfx, senha: certOk.senha }), /CNPJ 11222333000181 já cadastrado\./)
  assert.equal(m2.servico.obterEscritorio(), null)
})

test('listar traz papel e nunca a senha', (t) => {
  const m = montar()
  t.after(m.limpar)
  m.servico.cadastrar(dados({ cnpj: CNPJ }))
  const outro = gerarPfx({ cnpj: OUTRO })
  m.servico.cadastrarEscritorio({ cnpj: OUTRO, razao: 'Contabilidade', uf: 'CE', pfx: outro.pfx, senha: outro.senha })
  const lista = m.servico.listar()
  assert.deepEqual(lista.map((c) => c.papel).sort(), ['cliente', 'escritorio'])
  assert.ok(lista.every((c) => !('cert_senha_enc' in c)))
})

test('resumo não conta o escritório como cliente, mas avisa o certificado dele', (t) => {
  const m = montar()
  t.after(m.limpar)
  m.servico.cadastrarEscritorio({ cnpj: CNPJ, razao: 'Contabilidade Exemplo', uf: 'CE', pfx: certOk.pfx, senha: certOk.senha })
  m.db.prepare("UPDATE clientes SET cert_validade = ?, ultimo_erro = 'falha', proxima_consulta = ?").run(new Date(Date.now() + 5 * 86400e3).toISOString(), new Date(Date.now() + 3600e3).toISOString())
  const r = criarServicoResumo({ db: m.db }).resumo()
  assert.equal(r.clientesAtivos, 0)
  assert.equal(r.clientesTotal, 0)
  assert.deepEqual(r.agenda, [])
  assert.equal(r.certificadosVencendo.length, 1)
  assert.equal(r.certificadosVencendo[0].nome, 'escritorio')
  assert.equal(r.clientesComErro.length, 1)
})

test('escritório cadastrado como cliente vira cliente também, sem linha nova', (t) => {
  const m = montar()
  t.after(m.limpar)
  m.servico.cadastrarEscritorio({ cnpj: CNPJ, razao: 'Contabilidade Exemplo', uf: 'CE', pfx: certOk.pfx, senha: certOk.senha })
  const { cliente } = m.servico.cadastrar(dados())
  assert.equal(cliente.papel, 'escritorio')
  assert.equal(cliente.tambem_cliente, 1)
  assert.equal(cliente.apelido, 'escritorio', 'a pasta do escritório não muda')
  assert.equal(m.db.prepare('SELECT COUNT(*) n FROM clientes').get().n, 1)
  assert.throws(() => m.servico.cadastrar(dados()), /já cadastrado/)
  assert.equal(criarServicoResumo({ db: m.db }).resumo().clientesTotal, 1)

  // Desativar como cliente só tira a marca; o escritório continua ativo para as saídas.
  m.servico.definirAtivo(CNPJ, false)
  const e = m.servico.obterEscritorio()
  assert.deepEqual([e.ativo, e.tambem_cliente], [1, 0])
})
