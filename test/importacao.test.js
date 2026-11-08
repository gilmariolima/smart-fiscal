'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { zipSync, strToU8 } = require('fflate')
const { abrirBanco } = require('../src/db')
const { criarServicoImportacao } = require('../src/services/importacao')
const { xmlNfse, chaveNfse, PRESTADOR_MOCK } = require('../src/sefaz/adn-mock')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

const OUTRO = '99888777000100'
const FORA = '11111111000191'

function montar() {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'importar-'))
  const db = abrirBanco(':memory:')
  const id = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Cliente 1 Ltda', 'Cliente 1', 'CE', 'x.pfx', 'a:b:c')`).run(CNPJ_MOCK_OK).lastInsertRowid
  const servico = criarServicoImportacao({ db, config: { pastaXmls }, logger: { info() {}, warn() {}, error() {} } })
  return { db, servico, id, pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

const notas = (db) => db.prepare('SELECT * FROM notas ORDER BY cliente_id, tipo').all()
const arquivos = (pasta) => fs.readdirSync(pasta, { recursive: true }).filter((f) => f.endsWith('.xml')).map((f) => f.replace(/\\/g, '/')).sort()
const arq = (nome, texto) => ({ nome, bytes: Buffer.from(texto) })
const entrada = (n = 1) => xmlNfse({ chave: chaveNfse(PRESTADOR_MOCK, n), prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK, numero: String(n) })
const saida = (n = 2) => xmlNfse({ chave: chaveNfse(CNPJ_MOCK_OK, n), prestador: CNPJ_MOCK_OK, tomador: PRESTADOR_MOCK, numero: String(n) })

test('importa entrada e saída com origem importada', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const r = servico.importar([arq('a.xml', entrada()), arq('b.xml', saida())])
  assert.deepEqual(r.importadas, { entrada: 1, saida: 1 })
  assert.equal(r.jaExistiam, 0)
  assert.deepEqual(r.ignoradas, [])
  const [e, s] = notas(db)
  assert.deepEqual([e.tipo, s.tipo], ['entrada', 'saida'])
  assert.ok([e, s].every((n) => n.modelo === 'nfse' && n.status === 'completa' && n.origem === 'importada' && n.nsu === null && n.competencia === '2026-10'))
  const base = 'Cliente 1/2026/10-Outubro/NFS-e'
  assert.deepEqual(arquivos(pastaXmls), [`${base}/Entradas/XML/${e.chave}-nfse.xml`, `${base}/Saidas/XML/${s.chave}-nfse.xml`].sort())
})

test('CNPJ não cadastrado é ignorado', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const r = servico.importar([arq('fora.xml', xmlNfse({ chave: chaveNfse(FORA, 5), prestador: FORA, tomador: PRESTADOR_MOCK }))])
  assert.deepEqual(r.ignoradas, [{ nome: 'fora.xml', motivo: 'cnpj-nao-cadastrado' }])
  assert.equal(notas(db).length, 0)
})

test('nota já existente conta como já existia', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const r1 = servico.importar([arq('a.xml', entrada()), arq('a-copia.xml', entrada())])
  assert.deepEqual([r1.importadas.entrada, r1.jaExistiam], [1, 1])
  const r2 = servico.importar([arq('a.xml', entrada())])
  assert.deepEqual([r2.importadas.entrada, r2.jaExistiam], [0, 1])
  assert.equal(notas(db).length, 1)
})

test('nota entre dois clientes grava nos dois', (t) => {
  const { db, servico, id, limpar } = montar()
  t.after(limpar)
  const outro = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Outro Ltda', 'Outro', 'CE', '', '')`).run(OUTRO).lastInsertRowid
  const r = servico.importar([arq('x.xml', xmlNfse({ chave: chaveNfse(OUTRO, 7), prestador: OUTRO, tomador: CNPJ_MOCK_OK }))])
  assert.deepEqual(r.importadas, { entrada: 1, saida: 1 })
  assert.deepEqual(r.clientesAfetados.sort(), [id, outro].sort())
  assert.deepEqual(notas(db).map((n) => [n.cliente_id, n.tipo]), [[id, 'entrada'], [outro, 'saida']])
})

test('zip com pastas e arquivos misturados', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const zip = Buffer.from(zipSync({ a: { '1.xml': strToU8(entrada(1)), b: { '2.XML': strToU8(entrada(3)) } }, 'leia.txt': strToU8('oi') }))
  const r = servico.importar([{ nome: 'Lote.ZIP', bytes: zip }])
  assert.equal(r.importadas.entrada, 2)
  assert.deepEqual(r.ignoradas, [{ nome: 'Lote.ZIP/leia.txt', motivo: 'nao-xml' }])
  assert.equal(notas(db).length, 2)
})

test('zip corrompido e arquivos que não são NFS-e', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const r = servico.importar([
    { nome: 'x.zip', bytes: Buffer.from('nao sou zip') },
    arq('nota.pdf', '%PDF-1.4'),
    arq('nfe.xml', '<?xml version="1.0"?><nfeProc><NFe/></nfeProc>'),
    arq('quebrado.xml', '<NFSe><infNFSe'),
    arq('boa.XML', entrada()),
  ])
  assert.deepEqual(r.ignoradas, [
    { nome: 'x.zip', motivo: 'zip-invalido' },
    { nome: 'nota.pdf', motivo: 'nao-xml' },
    { nome: 'nfe.xml', motivo: 'nao-nfse' },
    { nome: 'quebrado.xml', motivo: 'invalido' },
  ])
  assert.equal(r.importadas.entrada, 1)
  assert.equal(notas(db).length, 1)
})

test('XML com BOM e em ISO-8859-1', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const latin = Buffer.from(entrada(1).replace('UTF-8', 'ISO-8859-1'), 'latin1')
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(entrada(3))])
  const r = servico.importar([{ nome: 'latin.xml', bytes: latin }, { nome: 'bom.xml', bytes: bom }])
  assert.deepEqual(r.ignoradas, [])
  assert.equal(r.importadas.entrada, 2)
  assert.ok(notas(db).every((n) => n.destinatario_nome === `TOMADOR ${CNPJ_MOCK_OK}`))
})

test('cancelamento já existente marca a nota', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, descricao) VALUES (?, '101101', 1, 'Cancelamento')").run(chaveNfse(PRESTADOR_MOCK, 1))
  servico.importar([arq('a.xml', entrada(1))])
  assert.equal(notas(db)[0].cancelada, 1)
})

test('banco novo tem a coluna origem com padrão captura', (t) => {
  const { db, id, limpar } = montar()
  t.after(limpar)
  db.prepare("INSERT INTO notas (cliente_id, chave, tipo, status) VALUES (?, 'k', 'entrada', 'completa')").run(id)
  assert.equal(db.prepare('SELECT origem FROM notas').get().origem, 'captura')
})
