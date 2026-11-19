'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { montarChave, lerRetornoConsulta, criarClienteConsulta } = require('../src/sefaz/consultaProtocolo')
const { criarSaidas } = require('../src/services/saidasPeloCertificado')
const { criarBuscaAntiga } = require('../src/services/buscaAntiga')
const { criarServicoImportacao } = require('../src/services/importacao')

const CNPJ = '20691552000109'
const logger = { info() {}, warn() {}, error() {} }
const envelope = (miolo) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4"><retConsSitNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><verAplic>SVRS</verAplic>${miolo}</retConsSitNFe></nfeResultMsg></soap:Body></soap:Envelope>`

// ---------- consulta de protocolo ----------

test('monta a chave com o dígito verificador certo', () => {
  // Chave real da Leitura (nº 63154) com o código numérico trocado: o DV desta foi aceito pela SEFAZ no teste de 18/11.
  assert.equal(montarChave({ cUF: '23', aamm: '2611', cnpj: CNPJ, serie: 1, numero: 63154, cNF: '12345678' }), '23261120691552000109550010000631541123456780')
})

test('lê 613 com a chave verdadeira, 217 e 526', () => {
  const real = '23261120691552000109550010000631551000122228'
  const r613 = lerRetornoConsulta(envelope(`<cStat>613</cStat><xMotivo>Rejeicao: Chave de Acesso difere da existente em BD Rejeicao: Codigo Numerico informado na Chave de Acesso difere do Codigo Numerico da NF-e [${real}]</xMotivo>`))
  assert.deepEqual([r613.cStat, r613.chaveVerdadeira], ['613', real])
  assert.deepEqual(lerRetornoConsulta(envelope('<cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo>')).cStat, '217')
  assert.equal(lerRetornoConsulta(envelope('<cStat>526</cStat><xMotivo>Ano-Mes da Chave de Acesso com atraso superior a 6 meses</xMotivo>')).cStat, '526')
  assert.equal(lerRetornoConsulta('<html>fora</html>').cStat, null)
})

test('cliente da consulta envia o consSitNFe e trata queda de rede', async () => {
  let enviado
  const c = criarClienteConsulta({ requisitar: async (url, corpo) => ((enviado = { url, corpo }), { status: 200, corpo: envelope('<cStat>217</cStat><xMotivo>x</xMotivo>') }) })
  assert.equal((await c.consultar('2'.repeat(44))).cStat, '217')
  assert.match(enviado.url, /nfe\.svrs\.rs\.gov\.br\/ws\/NfeConsulta\/NfeConsulta4\.asmx/)
  assert.match(enviado.corpo, /<xServ>CONSULTAR<\/xServ><chNFe>2{44}<\/chNFe>/)
  const caiu = criarClienteConsulta({ requisitar: async () => { throw new Error('ECONNRESET') } })
  assert.match((await caiu.consultar('2'.repeat(44))).erro, /ECONNRESET/)
})

// ---------- descoberta das saídas ----------

// SEFAZ falsa: `existe(numero)` diz se o número tem nota; o 613 devolve uma chave verdadeira inventada.
// `meses`: Map número → AAMM (613 com a chave daquele mês) ou 'antiga' (526); com ele, `existe` não é usado.
function montar({ existe = () => false, resposta = null, ultimoNoApp = 100, ligado = true, aoDormir = null, meses = null } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'saidas-'))
  const db = abrirBanco(':memory:')
  const id = db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, cert_validade, saidas_auto) VALUES (?, 'Leitura', 'Leitura', 'CE', 'c.pfx', 'a:b:c', '2027-08-28T00:00:00Z', ?)").run(CNPJ, ligado ? 1 : 0).lastInsertRowid
  if (ultimoNoApp) {
    db.prepare("INSERT INTO notas (cliente_id, chave, tipo, modelo, status, emitente_cnpj, serie, numero) VALUES (?, ?, 'saida', 'nfe', 'completa', ?, '1', ?)").run(id, montarChave({ cUF: '23', aamm: '2611', cnpj: CNPJ, serie: 1, numero: ultimoNoApp, cNF: '00000001' }), CNPJ, String(ultimoNoApp))
  }
  const config = { pastaXmls }
  const importacao = criarServicoImportacao({ db, config, logger })
  const buscaAntiga = criarBuscaAntiga({ db, config, logger, importacao, fabricaSvrs: () => ({}), agora: () => new Date('2026-11-18T12:00:00Z') })
  const consultas = []
  const fabricaConsulta = () => ({
    consultar: async (chave) => {
      const numero = Number(chave.slice(25, 34))
      consultas.push(numero)
      if (resposta) {
        const r = resposta(numero)
        if (r) return r
      }
      if (meses) {
        const mes = meses.get(numero)
        if (mes === 'antiga') return { cStat: '526', xMotivo: 'atraso superior a 6 meses' }
        if (mes) return { cStat: '613', chaveVerdadeira: chaveDe(numero, mes) }
        return { cStat: '217' }
      }
      if (existe(numero)) return { cStat: '613', chaveVerdadeira: montarChave({ cUF: '23', aamm: '2611', cnpj: CNPJ, serie: 1, numero, cNF: '99999999' }) }
      return { cStat: '217' }
    },
  })
  const pausas = []
  const ref = {}
  const dormir = async (ms) => {
    pausas.push(ms)
    // Sem esperar o retorno: parar() devolve a própria procura, que está dentro deste dormir.
    if (aoDormir) aoDormir({ db, id, consultas, saidas: ref.saidas, buscaAntiga })
  }
  // Relógio falso das retomadas automáticas: guarda o que foi agendado em vez de esperar.
  const agendados = []
  const depois = (fn, ms) => {
    agendados.push({ fn, ms })
    return () => {}
  }
  const novaSaidas = () => criarSaidas({ db, config, logger, buscaAntiga, fabricaConsulta, dormir, depois, agora: () => new Date('2026-11-18T12:00:00Z') })
  const saidas = novaSaidas()
  ref.saidas = saidas
  return { db, id, saidas, novaSaidas, consultas, pausas, buscaAntiga, agendados, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const chaveDe = (numero, mes) => montarChave({ cUF: '23', aamm: mes, cnpj: CNPJ, serie: 1, numero, cNF: '99999999' })
const faixas = (...lista) => {
  const m = new Map()
  for (const [de, ate, mes] of lista) for (let n = de; n <= ate; n++) m.set(n, mes)
  return m
}
const naFila = (db) => db.prepare("SELECT chave, direcao, origem FROM busca_antiga ORDER BY chave").all()

// ---------- saídas por período ----------

const tresMeses = () => faixas([1, 100, '2607'], [101, 160, '2608'], [161, 200, '2609'])
const pedido = (db) => db.prepare('SELECT * FROM saidas_periodos ORDER BY id DESC').get()
// Buscar o período já cria o pedido (sem passo de confirmar): devolve o id dele.
async function buscarPeriodo(saidas, clienteId, de = '2608', ate = '2608') {
  return (await saidas.pedirPeriodo({ clienteId, de, ate, serie: '1' })).id
}
const esperarParar = async (saidas) => {
  for (let i = 0; i < 200 && saidas.rodando(); i++) await new Promise((ok) => setTimeout(ok, 5))
}

test('buscar o período acha o trecho e já põe só as chaves do período na fila', async (t) => {
  const { db, id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  assert.deepEqual(saidas.janela(), { de: '2606', ate: '2611' })
  const r = await saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: '1' })
  assert.deepEqual(r, { id: 1, serie: '1', primeiro: 101, ultimo: 160, estimadas: 60, foraDaJanela: false })
  await saidas.procurar()
  const fila = naFila(db)
  assert.equal(fila.length, 60)
  assert.ok(fila.every((l) => l.origem === 'periodo' && l.direcao === 'saida'))
  assert.deepEqual([pedido(db).situacao, pedido(db).achadas], ['concluido', 60])
  assert.equal(saidas.listarPeriodos()[0].cnpj, CNPJ)
})

test('pedido pula chave que já está no app ou na fila', async (t) => {
  const { db, id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  db.prepare("INSERT INTO notas (cliente_id, chave, tipo, modelo, status, emitente_cnpj, serie, numero) VALUES (?, ?, 'saida', 'nfe', 'completa', ?, '1', '120')").run(id, chaveDe(120, '2608'), CNPJ)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.equal(naFila(db).length, 59)
})

test('pedido continua do próximo depois de 656', async (t) => {
  let bloqueado = true
  const { db, id, saidas, consultas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses(), resposta: (n) => (n === 130 && bloqueado ? { cStat: '656', xMotivo: 'Consumo Indevido' } : null) })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.deepEqual([pedido(db).situacao, pedido(db).proximo], ['procurando', 130])
  assert.match(pedido(db).erro, /656/)
  bloqueado = false
  consultas.length = 0
  await saidas.procurar()
  assert.equal(consultas[0], 130)
  assert.equal(naFila(db).length, 60)
  assert.equal(pedido(db).situacao, 'concluido')
})

test('fechar o app no meio do pedido: um app novo continua do próximo gravado', async (t) => {
  const { db, id, saidas, novaSaidas, consultas, limpar } = montar({
    ligado: false,
    ultimoNoApp: 0,
    meses: tresMeses(),
    aoDormir: ({ db: d, saidas: s }) => d.prepare('SELECT proximo FROM saidas_periodos').pluck().get() === 110 && s.parar(),
  })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  const parou = pedido(db).proximo
  assert.ok(parou >= 110 && parou < 160, `parou em ${parou}`)
  consultas.length = 0
  await novaSaidas().procurar()
  assert.equal(consultas[0], parou)
  assert.equal(naFila(db).length, 60)
})

test('pausar a empresa no meio do pedido para', async (t) => {
  const { db, id, saidas, limpar } = montar({
    ligado: false,
    ultimoNoApp: 0,
    meses: tresMeses(),
    aoDormir: ({ db: d }) => d.prepare('SELECT proximo FROM saidas_periodos').pluck().get() === 110 && d.prepare('UPDATE clientes SET busca_pausada = 1').run(),
  })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.equal(pedido(db).situacao, 'procurando')
  assert.ok(naFila(db).length < 60)
})

test('pedido valida mês, série e empresa', async (t) => {
  const { db, id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  await assert.rejects(saidas.pedirPeriodo({ clienteId: id, de: '2605', ate: '2608', serie: '1' }), /6 meses/)
  await assert.rejects(saidas.pedirPeriodo({ clienteId: id, de: '2609', ate: '2608', serie: '1' }), /Até/)
  await assert.rejects(saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: '1000' }), /Série/)
  await assert.rejects(saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: 'x' }), /Série/)
  const sp = db.prepare("INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc, cert_validade) VALUES ('11222333000181', 'SP', 'SP', 'c.pfx', 'a:b:c', '2027-08-28T00:00:00Z')").run().lastInsertRowid
  await assert.rejects(saidas.pedirPeriodo({ clienteId: sp, de: '2608', ate: '2608', serie: '1' }), /não pode/)
  const vencido = db.prepare("INSERT INTO clientes (cnpj, razao_social, uf, cert_arquivo, cert_senha_enc, cert_validade) VALUES ('66777888000199', 'V', 'CE', 'c.pfx', 'a:b:c', '2025-01-01T00:00:00Z')").run().lastInsertRowid
  await assert.rejects(saidas.pedirPeriodo({ clienteId: vencido, de: '2608', ate: '2608', serie: '1' }), /não pode/)
})

test('mês sem nota não cria pedido', async (t) => {
  const { db, id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: faixas([1, 100, '2607'], [101, 200, '2609']) })
  t.after(limpar)
  assert.deepEqual(await saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: '1' }), { nenhuma: true, motivo: 'nenhuma nota no período' })
  assert.equal(db.prepare('SELECT COUNT(*) FROM saidas_periodos').pluck().get(), 0)
})

test('excluir pedido', async (t) => {
  const { id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  const pid = await buscarPeriodo(saidas, id)
  assert.equal(saidas.excluirPeriodo(pid), true)
  assert.equal(saidas.excluirPeriodo(pid), false)
})

test('pedido na espera durante um Buscar roda logo depois, sem esperar a captura', async (t) => {
  let outro = null
  const { db, id, saidas, limpar } = montar({
    ligado: false,
    ultimoNoApp: 0,
    meses: tresMeses(),
    aoDormir: ({ id: cid, saidas: s }) => {
      if (!outro) outro = s.pedirPeriodo({ clienteId: cid, de: '2609', ate: '2609', serie: '1' })
    },
  })
  t.after(limpar)
  await saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: '1' })
  assert.equal((await outro).naEspera, true)
  await new Promise((ok) => setImmediate(ok))
  await esperarParar(saidas)
  assert.equal(pedido(db).situacao, 'concluido')
  // 2608 (o Buscar) e 2609 (o que esperou a vez).
  assert.equal(naFila(db).length, 100)
})

test('nota com data retroativa no limite da busca não derruba as outras do período', async (t) => {
  // 106 foi emitida com data de 2607 no meio das de 2608: o período de 2608 ainda traz 101 a 105 e 107 a 160.
  const meses = tresMeses()
  meses.set(106, '2607')
  const { db, id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.equal(naFila(db).length, 59)
})

test('excluir o pedido em andamento para as consultas', async (t) => {
  const { db, id, saidas, consultas, limpar } = montar({
    ligado: false,
    ultimoNoApp: 0,
    meses: tresMeses(),
    aoDormir: ({ db: d }) => d.prepare('SELECT proximo FROM saidas_periodos').pluck().get() === 110 && d.prepare('DELETE FROM saidas_periodos').run(),
  })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  consultas.length = 0
  await saidas.procurar()
  assert.ok(consultas.length < 35, `fez ${consultas.length} consultas depois de excluir`)
  assert.ok(naFila(db).length < 60)
})

test('buscar o mesmo período duas vezes não cria pedido em dobro', async (t) => {
  const { id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await assert.rejects(saidas.pedirPeriodo({ clienteId: id, de: '2608', ate: '2608', serie: '1' }), /pedido igual/)
})

test('empresa marcada no antigo "notas novas, sozinho" não é mais procurada', async (t) => {
  const { saidas, consultas, limpar } = montar({ ligado: true, existe: () => true })
  t.after(limpar)
  await saidas.procurar()
  assert.equal(consultas.length, 0)
})

test('procurar duas vezes ao mesmo tempo faz uma só', async (t) => {
  const { id, saidas, consultas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  consultas.length = 0
  await Promise.all([saidas.procurar(), saidas.procurar()])
  assert.equal(consultas.filter((n) => n === 120).length, 1)
})

test('pausar a fila inteira no meio do pedido para', async (t) => {
  const { db, id, saidas, limpar } = montar({
    ligado: false,
    ultimoNoApp: 0,
    meses: tresMeses(),
    aoDormir: ({ db: d, buscaAntiga }) => d.prepare('SELECT proximo FROM saidas_periodos').pluck().get() === 110 && buscaAntiga.pausar(),
  })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.equal(pedido(db).situacao, 'procurando')
  assert.ok(naFila(db).length < 60)
})

test('a empresa sendo procurada aparece como procurando', async (t) => {
  const vistos = []
  const { id, saidas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses(), aoDormir: ({ saidas: s }) => vistos.push(s.listar()[0].procurando) })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.ok(vistos.includes(true))
  assert.equal(saidas.listar()[0].procurando, false)
})

test('sem internet no meio do pedido: fica em andamento e tenta de novo sozinho em 5 min', async (t) => {
  let semRede = true
  const { db, id, saidas, agendados, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses(), resposta: (n) => (n === 130 && semRede ? { erro: 'getaddrinfo ENOTFOUND nfe.svrs.rs.gov.br' } : null) })
  t.after(limpar)
  await buscarPeriodo(saidas, id)
  await saidas.procurar()
  assert.deepEqual([pedido(db).situacao, pedido(db).proximo], ['procurando', 130])
  assert.match(pedido(db).erro, /Sem conexão com a SEFAZ/)
  assert.equal(agendados.length, 1)
  assert.equal(agendados[0].ms, 5 * 60 * 1000)
  semRede = false
  agendados[0].fn()
  await new Promise((ok) => setImmediate(ok))
  await esperarParar(saidas)
  assert.equal(pedido(db).situacao, 'concluido')
  assert.equal(naFila(db).length, 60)
})

test('tentar de novo um pedido que terminou com erro continua de onde parou', async (t) => {
  const { db, id, saidas, consultas, limpar } = montar({ ligado: false, ultimoNoApp: 0, meses: tresMeses() })
  t.after(limpar)
  const pid = await buscarPeriodo(saidas, id)
  db.prepare("UPDATE saidas_periodos SET situacao = 'erro', erro = 'Sem resposta da SEFAZ', proximo = 120 WHERE id = ?").run(pid)
  assert.equal(saidas.retomarPeriodo(pid), true)
  assert.equal(saidas.retomarPeriodo(9999), false)
  consultas.length = 0
  await saidas.procurar()
  assert.equal(consultas[0], 120)
  assert.equal(pedido(db).situacao, 'concluido')
})
