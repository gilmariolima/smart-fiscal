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
function montar({ existe = () => false, resposta = null, ultimoNoApp = 100, ligado = true, aoDormir = null } = {}) {
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
  const saidas = criarSaidas({ db, config, logger, buscaAntiga, fabricaConsulta, dormir, agora: () => new Date('2026-11-18T12:00:00Z') })
  ref.saidas = saidas
  return { db, id, saidas, consultas, pausas, buscaAntiga, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const naFila = (db) => db.prepare("SELECT chave, direcao, origem FROM busca_antiga ORDER BY chave").all()

test('acha as saídas seguidas a partir do maior número no app e põe na fila', async (t) => {
  const { db, saidas, consultas, pausas, limpar } = montar({ existe: (n) => n <= 105 })
  t.after(limpar)
  const r = await saidas.procurar()
  assert.equal(r.achadas, 5)
  assert.deepEqual(consultas.slice(0, 6), [101, 102, 103, 104, 105, 106])
  assert.equal(consultas.length, 5 + 20)
  assert.ok(pausas.every((ms) => ms === 2000))
  const fila = naFila(db)
  assert.equal(fila.length, 5)
  assert.ok(fila.every((l) => l.direcao === 'saida' && l.origem === 'saidas'))
  const serie = db.prepare('SELECT * FROM saidas_series').get()
  assert.deepEqual([serie.serie, serie.ultimo_numero, serie.achadas], ['1', 105, 5])
  // Na próxima vez, continua do 106.
  consultas.length = 0
  await saidas.procurar()
  assert.equal(consultas[0], 106)
})

test('atravessa furos na numeração', async (t) => {
  const { db, saidas, limpar } = montar({ existe: (n) => [101, 103, 110].includes(n) })
  t.after(limpar)
  assert.equal((await saidas.procurar()).achadas, 3)
  assert.equal(db.prepare('SELECT ultimo_numero FROM saidas_series').pluck().get(), 110)
})

test('656 para tudo e grava o erro; 526 marca fora dos 6 meses', async (t) => {
  const bloqueio = montar({ resposta: (n) => (n === 102 ? { cStat: '656', xMotivo: 'Consumo Indevido' } : null), existe: () => true })
  t.after(bloqueio.limpar)
  const r = await bloqueio.saidas.procurar()
  assert.equal(r.achadas, 1)
  assert.match(bloqueio.db.prepare('SELECT ultimo_erro FROM saidas_series').pluck().get(), /656/)
  assert.deepEqual(bloqueio.consultas, [101, 102])
  const velha = montar({ resposta: () => ({ cStat: '526', xMotivo: 'atraso superior a 6 meses' }) })
  t.after(velha.limpar)
  await velha.saidas.procurar()
  assert.match(velha.db.prepare('SELECT ultimo_erro FROM saidas_series').pluck().get(), /6 meses/)
})

test('cliente desligado, pausado ou sem início não consulta', async (t) => {
  const desligado = montar({ ligado: false, existe: () => true })
  t.after(desligado.limpar)
  await desligado.saidas.procurar()
  assert.equal(desligado.consultas.length, 0)
  const pausado = montar({ existe: () => true })
  t.after(pausado.limpar)
  pausado.db.prepare('UPDATE clientes SET busca_pausada = 1').run()
  await pausado.saidas.procurar()
  assert.equal(pausado.consultas.length, 0)
  const semInicio = montar({ ultimoNoApp: 0, existe: () => true })
  t.after(semInicio.limpar)
  await semInicio.saidas.procurar()
  assert.equal(semInicio.consultas.length, 0)
  assert.equal(semInicio.saidas.listar()[0].series.length, 0)
})

test('chave colada dá o início da série e entra na fila', async (t) => {
  const { db, id, saidas, consultas, limpar } = montar({ ultimoNoApp: 0, existe: (n) => n <= 502 })
  t.after(limpar)
  const chave = montarChave({ cUF: '23', aamm: '2611', cnpj: CNPJ, serie: 2, numero: 500, cNF: '11111111' })
  saidas.definirInicio(id, chave)
  assert.throws(() => saidas.definirInicio(id, montarChave({ cUF: '23', aamm: '2611', cnpj: '66777888000199', serie: 1, numero: 1, cNF: '1' })), /emitida por este cliente/)
  await saidas.procurar()
  assert.deepEqual(consultas.slice(0, 3), [501, 502, 503])
  assert.equal(naFila(db).length, 3)
  assert.deepEqual(saidas.listar()[0].series.map((s) => [s.serie, s.ultimo_numero]), [['2', 502]])
})

test('procurar duas vezes ao mesmo tempo faz uma só', async (t) => {
  const { saidas, consultas, limpar } = montar({ existe: (n) => n <= 102 })
  t.after(limpar)
  const [a, b] = await Promise.all([saidas.procurar(), saidas.procurar()])
  assert.equal(a, b)
  assert.equal(consultas.filter((n) => n === 101).length, 1)
})

test('fechar o app no meio: para de consultar, grava a série e não começa outra procura', async (t) => {
  const { db, saidas, consultas, limpar } = montar({ existe: () => true, aoDormir: ({ consultas: c, saidas: s }) => c.length === 3 && s.parar() })
  t.after(limpar)
  const r = await saidas.procurar()
  assert.equal(consultas.length, 3)
  assert.equal(r.achadas, 3)
  assert.equal(db.prepare('SELECT ultimo_numero FROM saidas_series').pluck().get(), 103)
  assert.deepEqual(await saidas.procurar(), { clientes: 0, achadas: 0 })
  assert.equal(consultas.length, 3)
})

test('pausar a empresa ou a fila inteira no meio para a procura das saídas', async (t) => {
  const empresa = montar({ existe: () => true, aoDormir: ({ db, consultas: c }) => c.length === 2 && db.prepare('UPDATE clientes SET busca_pausada = 1').run() })
  t.after(empresa.limpar)
  await empresa.saidas.procurar()
  assert.equal(empresa.consultas.length, 2)
  const geral = montar({ existe: () => true, aoDormir: ({ consultas: c, buscaAntiga }) => c.length === 2 && buscaAntiga.pausar() })
  t.after(geral.limpar)
  await geral.saidas.procurar()
  assert.equal(geral.consultas.length, 2)
})

test('o intervalo vale também entre uma série e outra', async (t) => {
  const { db, id, saidas, consultas, pausas, limpar } = montar({ existe: (n) => n === 101 })
  t.after(limpar)
  db.prepare("INSERT INTO saidas_series (cliente_id, serie, ultimo_numero) VALUES (?, '2', 500)").run(id)
  await saidas.procurar()
  assert.ok(consultas.includes(501))
  assert.equal(pausas.length, consultas.length - 1)
})

test('início colado durante a procura não é desfeito pela gravação da série', async (t) => {
  const { db, saidas, limpar } = montar({ existe: (n) => n <= 102, aoDormir: ({ db: d, id: cid, consultas: c }) => c.length === 1 && d.prepare("INSERT INTO saidas_series (cliente_id, serie, ultimo_numero) VALUES (?, '1', 900) ON CONFLICT(cliente_id, serie) DO UPDATE SET ultimo_numero = 900").run(cid) })
  t.after(limpar)
  await saidas.procurar()
  assert.equal(db.prepare('SELECT ultimo_numero FROM saidas_series').pluck().get(), 900)
})
