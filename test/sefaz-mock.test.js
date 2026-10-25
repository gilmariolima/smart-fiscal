'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarSefazMock, gerarChave, CNPJ_MOCK_OK, CNPJ_MOCK_656, CNPJ_MOCK_ESCRITORIO, CNPJ_FORA_CARTEIRA } = require('../src/sefaz/mock-client')
const { tipoDocumento } = require('../src/sefaz/client')

const tipos = (r) => r.data.docZip.map((d) => tipoDocumento(d.schema))

test('fila de NSU: lote de resumos, lote com procNFe e cancelamento, depois 137', async () => {
  const c = criarSefazMock().cliente(CNPJ_MOCK_OK)

  const r1 = await c.consultaUltNSU('000000000000000')
  assert.equal(r1.data.cStat, '138')
  assert.deepEqual(tipos(r1), ['resNFe', 'resNFe'])
  assert.equal(r1.data.ultNSU, '000000000000002')
  assert.equal(r1.data.maxNSU, '000000000000004')

  const r2 = await c.consultaUltNSU(r1.data.ultNSU)
  assert.deepEqual(tipos(r2), ['procNFe', 'procEventoNFe'])
  assert.equal(r2.data.ultNSU, '000000000000004')

  const r3 = await c.consultaUltNSU(r2.data.ultNSU)
  assert.equal(r3.data.cStat, '137')
  assert.equal(r3.data.docZip.length, 0)
  assert.equal(r3.data.ultNSU, r3.data.maxNSU)
})

test('json no formato do node-mde (atributos @_ e valores string)', async () => {
  const c = criarSefazMock().cliente(CNPJ_MOCK_OK)
  const [resA] = (await c.consultaUltNSU('0')).data.docZip
  assert.equal(resA.json.resNFe['@_versao'], '1.01')
  assert.match(resA.json.resNFe.chNFe, /^\d{44}$/)
  assert.equal(typeof resA.json.resNFe.vNF, 'string')
  assert.ok(resA.xml.startsWith('<resNFe'))

  const [proc, canc] = (await c.consultaUltNSU('000000000000002')).data.docZip
  const infNFe = proc.json.nfeProc.NFe.infNFe
  assert.equal(infNFe.ide.nNF.length > 0, true)
  assert.equal(infNFe.emit.CNPJ.length, 14)
  assert.equal(infNFe.total.ICMSTot.vNF, '99.90')
  assert.equal(canc.json.procEventoNFe.evento.infEvento.tpEvento, '110111')
})

test('ciência libera o XML completo pela fila e pela consulta por chave; repetir dá 573', async () => {
  const c = criarSefazMock().cliente(CNPJ_MOCK_OK)
  const chaveA = (await c.consultaUltNSU('0')).data.docZip[0].json.resNFe.chNFe

  const antes = await c.consultaChNFe(chaveA)
  assert.deepEqual(tipos(antes), ['resNFe'])

  const ev = await c.enviarEvento({ idLote: '1', lote: [{ chNFe: chaveA, tipoEvento: 210210 }] })
  assert.equal(ev.data.cStat, '128')
  assert.equal(ev.data.infEvento[0].cStat, '135')
  assert.match(ev.data.infEvento[0].nProt, /^\d{15}$/)

  const depois = await c.consultaChNFe(chaveA)
  assert.deepEqual(tipos(depois), ['procNFe'])

  const novo = await c.consultaUltNSU('000000000000004')
  assert.equal(novo.data.cStat, '138')
  assert.equal(novo.data.docZip[0].nsu, '000000000000005')
  assert.equal(novo.data.docZip[0].json.nfeProc.protNFe.infProt.chNFe, chaveA)

  const dup = await c.enviarEvento({ idLote: '2', lote: [{ chNFe: chaveA, tipoEvento: 210210 }] })
  assert.equal(dup.data.infEvento[0].cStat, '573')
})

test('chave desconhecida no evento dá 494 e lote fora do limite dá error', async () => {
  const c = criarSefazMock().cliente(CNPJ_MOCK_OK)
  const r = await c.enviarEvento({ idLote: '1', lote: [{ chNFe: '1'.repeat(44), tipoEvento: 210210 }] })
  assert.equal(r.data.infEvento[0].cStat, '494')

  const lote21 = Array.from({ length: 21 }, () => ({ chNFe: '1'.repeat(44), tipoEvento: 210210 }))
  assert.match((await c.enviarEvento({ idLote: '1', lote: lote21 })).error, /20 eventos/)
  assert.match((await c.enviarEvento({ idLote: '1', lote: [{ chNFe: '1'.repeat(44), tipoEvento: 210240, justificativa: 'curta' }] })).error, /Justificativa/)
})

test('CNPJ configurado para 656 devolve consumo indevido', async () => {
  const c = criarSefazMock().cliente(CNPJ_MOCK_656)
  const r = await c.consultaUltNSU('0')
  assert.equal(r.data.cStat, '656')
  assert.equal((await c.consultaChNFe('1'.repeat(44))).data.cStat, '656')
})

test('modo erro devolve error e registra as chamadas', async () => {
  const mock = criarSefazMock({ cenarios: { '12345678000195': { modo: 'erro' } } })
  const r = await mock.cliente('12345678000195').consultaUltNSU('0')
  assert.match(r.error, /ECONNREFUSED/)
  assert.deepEqual(mock.chamadas, [{ cnpj: '12345678000195', metodo: 'consultaUltNSU', arg: '0' }])
})

test('CNPJs diferentes têm filas e chaves independentes', async () => {
  const mock = criarSefazMock()
  const a = (await mock.cliente(CNPJ_MOCK_OK).consultaUltNSU('0')).data.docZip[0].json.resNFe.chNFe
  const b = (await mock.cliente('34567890000130').consultaUltNSU('0')).data.docZip[0].json.resNFe.chNFe
  assert.notEqual(a, b)
})

test('gerarChave monta os campos na ordem do layout e fecha o DV módulo 11', () => {
  const ch = gerarChave({ cUF: '52', data: new Date('2006-04-15T12:00:00Z'), cnpjEmit: '33009911002506', nNF: 7, cNF: 18005409 })
  assert.equal(ch.length, 44)
  // cUF | AAMM | CNPJ | mod | série | nNF | tpEmis | cNF
  assert.equal(ch.slice(0, 43), '52' + '0604' + '33009911002506' + '55' + '001' + '000000007' + '1' + '18005409')
  // Com o DV, a soma ponderada (pesos 2..9 da direita, incluindo o DV com peso 1) fecha em 0 ou 1 mod 11.
  const pesos = [...ch.slice(0, 43)].reverse().reduce((s, d, i) => s + Number(d) * ((i % 8) + 2), 0)
  const resto = pesos % 11
  assert.equal(Number(ch[43]), resto < 2 ? 0 : 11 - resto)
})

test('tipoDocumento pelo prefixo do schema', () => {
  assert.equal(tipoDocumento('resNFe_v1.01.xsd'), 'resNFe')
  assert.equal(tipoDocumento('procNFe_v4.00.xsd'), 'procNFe')
  assert.equal(tipoDocumento('resEvento_v1.01.xsd'), 'resEvento')
  assert.equal(tipoDocumento('procEventoNFe_v1.00.xsd'), 'procEventoNFe')
  assert.equal(tipoDocumento('outro.xsd'), 'desconhecido')
  assert.equal(tipoDocumento(undefined), 'desconhecido')
})

test('fila do escritório: 4 procNFe, 1 cancelamento, 1 resNFe; chave de E1 = nota a do cliente', async () => {
  const dataBase = new Date('2026-10-09T13:00:00Z')
  const sefaz = criarSefazMock({ dataBase })
  const esc = sefaz.cliente(CNPJ_MOCK_ESCRITORIO)
  const docs = []
  let ult = '000000000000000'
  for (;;) {
    const r = await esc.consultaUltNSU(ult)
    if (r.data.cStat === '137') break
    docs.push(...r.data.docZip)
    ult = r.data.ultNSU
  }
  assert.deepEqual(docs.map((d) => tipoDocumento(d.schema)), ['procNFe', 'procNFe', 'procNFe', 'procNFe', 'procEventoNFe', 'resNFe'])
  const inf = (d) => d.json.nfeProc.NFe.infNFe
  const [s1, s2, e1, f1] = docs.slice(0, 4).map(inf)
  assert.equal(s1.emit.CNPJ, CNPJ_MOCK_OK)
  assert.equal(s1.emit.xNome, 'Cliente Simulado Ltda')
  assert.equal(s1.dest.CNPJ, CNPJ_FORA_CARTEIRA)
  assert.equal(s2.emit.CNPJ, CNPJ_MOCK_OK)
  assert.equal(s2.dest.CNPJ, CNPJ_FORA_CARTEIRA)
  assert.equal(e1.emit.CNPJ, '12345678000195')
  assert.equal(e1.dest.CNPJ, CNPJ_MOCK_OK)
  assert.equal(f1.emit.CNPJ, '34567890000130')
  assert.equal(f1.dest.CNPJ, CNPJ_FORA_CARTEIRA)
  const chaves = [s1, s2, e1, f1].map((i) => i['@_Id'])
  assert.equal(new Set(chaves).size, 4)

  const r = await sefaz.cliente(CNPJ_MOCK_OK).consultaUltNSU('000000000000000')
  const a = r.data.docZip[0].json.resNFe.chNFe
  assert.equal(e1['@_Id'], `NFe${a}`)
  assert.equal(docs[4].json.procEventoNFe.evento.infEvento.chNFe, s2['@_Id'].slice(3))
  assert.equal(docs[5].json.resNFe.CNPJ, '23456789000195')
})

test('fila do escritório: chaves de S1, S2 e F1 não colidem com a fila normal do cliente', async () => {
  const sefaz = criarSefazMock()
  const consumir = async (cnpj) => {
    const docs = []
    let ult = '000000000000000'
    for (;;) {
      const r = await sefaz.cliente(cnpj).consultaUltNSU(ult)
      if (r.data.cStat === '137') return docs
      docs.push(...r.data.docZip)
      ult = r.data.ultNSU
    }
  }
  const docsEsc = await consumir(CNPJ_MOCK_ESCRITORIO)
  const docsCli = await consumir(CNPJ_MOCK_OK)
  const chavesCli = [...sefaz.estado(CNPJ_MOCK_OK).notas.keys()]
  assert.equal(chavesCli.length, 3)
  const [s1, s2, , f1] = docsEsc.slice(0, 4).map((d) => d.json.nfeProc.NFe.infNFe['@_Id'].slice(3))
  for (const ch of [s1, s2, f1]) assert.ok(!chavesCli.includes(ch))
  assert.equal(new Set([s1, s2, f1]).size, 3)
  // E1 divide a nota "a" (chave e protocolo) com o cliente, mesmo consultando o escritório primeiro
  const protE1 = docsEsc[2].json.nfeProc.protNFe.infProt.nProt
  assert.equal(protE1, docsCli[0].json.resNFe.nProt)
  assert.equal(docsCli[0].json.resNFe.nProt, '323260000000001')
})
