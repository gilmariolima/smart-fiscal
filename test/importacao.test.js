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
  assert.deepEqual(r.importadas.nfse, { entrada: 1, saida: 1 })
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
  assert.deepEqual([r1.importadas.nfse.entrada, r1.jaExistiam], [1, 1])
  const r2 = servico.importar([arq('a.xml', entrada())])
  assert.deepEqual([r2.importadas.nfse.entrada, r2.jaExistiam], [0, 1])
  assert.equal(notas(db).length, 1)
})

test('nota entre dois clientes grava nos dois', (t) => {
  const { db, servico, id, limpar } = montar()
  t.after(limpar)
  const outro = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Outro Ltda', 'Outro', 'CE', '', '')`).run(OUTRO).lastInsertRowid
  const r = servico.importar([arq('x.xml', xmlNfse({ chave: chaveNfse(OUTRO, 7), prestador: OUTRO, tomador: CNPJ_MOCK_OK }))])
  assert.deepEqual(r.importadas.nfse, { entrada: 1, saida: 1 })
  assert.deepEqual(r.clientesAfetados.sort(), [id, outro].sort())
  assert.deepEqual(notas(db).map((n) => [n.cliente_id, n.tipo]), [[id, 'entrada'], [outro, 'saida']])
})

test('zip com pastas e arquivos misturados', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const zip = Buffer.from(zipSync({ a: { '1.xml': strToU8(entrada(1)), b: { '2.XML': strToU8(entrada(3)) } }, 'leia.txt': strToU8('oi') }))
  const r = servico.importar([{ nome: 'Lote.ZIP', bytes: zip }])
  assert.equal(r.importadas.nfse.entrada, 2)
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
    { nome: 'nfe.xml', motivo: 'nao-suportado' },
    { nome: 'quebrado.xml', motivo: 'invalido' },
  ])
  assert.equal(r.importadas.nfse.entrada, 1)
  assert.equal(notas(db).length, 1)
})

test('XML com BOM e em ISO-8859-1', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const latin = Buffer.from(entrada(1).replace('UTF-8', 'ISO-8859-1'), 'latin1')
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(entrada(3))])
  const r = servico.importar([{ nome: 'latin.xml', bytes: latin }, { nome: 'bom.xml', bytes: bom }])
  assert.deepEqual(r.ignoradas, [])
  assert.equal(r.importadas.nfse.entrada, 2)
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

// ---------- correções da revisão final ----------

function montarCom(config) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'importar-'))
  const db = abrirBanco(':memory:')
  db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Cliente 1 Ltda', 'Cliente 1', 'CE', 'x.pfx', 'a:b:c')`).run(CNPJ_MOCK_OK)
  const avisos = []
  const servico = criarServicoImportacao({ db, config: { pastaXmls, ...config }, logger: { info() {}, warn: (m) => avisos.push(m), error() {} } })
  return { db, servico, avisos, pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

test('escritório só é dono quando também é cliente', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES (?, 'Escritório Ltda', 'Escritório', 'CE', 'e.pfx', 'a:b:c', 'escritorio')`).run(OUTRO)
  const honorario = () => arq('honorario.xml', xmlNfse({ chave: chaveNfse(OUTRO, 8), prestador: OUTRO, tomador: FORA }))
  // Sem o escritório como cliente, a nota dele não tem dono: vai para Sem cliente cadastrado, como na captura.
  const r1 = servico.importar([honorario()])
  assert.deepEqual([r1.ignoradas, r1.semCliente, notas(db).length], [[], 1, 0])
  db.prepare('UPDATE clientes SET tambem_cliente = 1 WHERE cnpj = ?').run(OUTRO)
  assert.deepEqual(servico.importar([honorario()]).importadas.nfse, { entrada: 0, saida: 1 })
})

test('cliente só intermediário entra como entrada', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const xml = xmlNfse({ chave: chaveNfse(PRESTADOR_MOCK, 9), prestador: PRESTADOR_MOCK, tomador: FORA }).replace('</toma>', `</toma><interm><CNPJ>${CNPJ_MOCK_OK}</CNPJ></interm>`)
  const r = servico.importar([arq('interm.xml', xml)])
  assert.deepEqual(r.importadas.nfse, { entrada: 1, saida: 0 })
  assert.equal(notas(db)[0].tipo, 'entrada')
})

test('chave fora do formato é inválida', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const semDigitos = xmlNfse({ chave: 'ABC', prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK })
  const curta = xmlNfse({ chave: '123', prestador: PRESTADOR_MOCK, tomador: CNPJ_MOCK_OK })
  const r = servico.importar([arq('a.xml', semDigitos), arq('b.xml', curta)])
  assert.deepEqual(r.ignoradas, [{ nome: 'a.xml', motivo: 'invalido' }, { nome: 'b.xml', motivo: 'invalido' }])
  assert.equal(notas(db).length, 0)
})

test('erro ao gravar um arquivo não perde o lote', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Outro Ltda', 'Outro', 'CE', '', '')`).run(OUTRO)
  fs.writeFileSync(path.join(pastaXmls, 'Cliente 1'), 'arquivo no lugar da pasta')
  const r = servico.importar([arq('do-cliente-1.xml', entrada(1)), arq('do-outro.xml', xmlNfse({ chave: chaveNfse(OUTRO, 4), prestador: OUTRO, tomador: FORA }))])
  assert.deepEqual(r.ignoradas, [{ nome: 'do-cliente-1.xml', motivo: 'erro-gravacao' }])
  assert.deepEqual(r.importadas.nfse, { entrada: 0, saida: 1 })
  assert.deepEqual(notas(db).map((n) => n.emitente_cnpj), [OUTRO])
})

test('arquivo grande demais e ZIP acima do total são ignorados', (t) => {
  const { db, servico, limpar } = montarCom({ importacaoLimiteArquivo: 50 * 1024, importacaoLimiteTotal: 1000 }) // cada XML de teste tem 789 bytes: o 2º passa do total
  t.after(limpar)
  const zip = Buffer.from(zipSync({ '1.xml': strToU8(entrada(1)), '2.xml': strToU8(entrada(3)), 'grande.xml': strToU8('a'.repeat(60 * 1024)) }))
  const r = servico.importar([{ nome: 'z.zip', bytes: zip }, arq('solto-grande.xml', 'a'.repeat(60 * 1024))])
  assert.deepEqual(r.ignoradas, [
    { nome: 'z.zip/2.xml', motivo: 'zip-grande-demais' },
    { nome: 'z.zip/grande.xml', motivo: 'arquivo-grande' },
    { nome: 'solto-grande.xml', motivo: 'arquivo-grande' },
  ])
  assert.equal(notas(db).length, 1)
})

// ---------- NF-e, CT-e, eventos e notas sem cliente ----------

const { chaveNfe, nfeProc, procEventoNfe } = require('./apoio/nfe-importada')
const { cteProc, procEventoCte, chaveCte, TRANSP, REM, DEST } = require('./apoio/cte')
const { xmlEventoNfse } = require('../src/sefaz/adn-mock')
const { caminhoDa } = require('../src/services/armazenamento')

const comOutro = (db) => db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Outro Ltda', 'Outro', 'CE', '', '')`).run(OUTRO).lastInsertRowid
const comEscritorio = (db) => db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc, papel) VALUES ('44555666000181', 'Escritorio Ltda', 'Escritorio', 'CE', 'e.pfx', 'a:b:c', 'escritorio')`).run()
const comCliente = (db, cnpj, apelido) => db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, ?, ?, 'CE', '', '')`).run(cnpj, apelido, apelido).lastInsertRowid

test('NF-e de saída vai para NF-e/Saidas', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const chave = chaveNfe(CNPJ_MOCK_OK, 5)
  const r = servico.importar([arq('n.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '5' }))])
  assert.deepEqual(r.importadas.nfe, { entrada: 0, saida: 1 })
  const [n] = notas(db)
  assert.deepEqual([n.modelo, n.tipo, n.origem, n.nsu, n.status, n.chave], ['nfe', 'saida', 'importada', null, 'completa', chave])
  assert.deepEqual(arquivos(pastaXmls), [`Cliente 1/2026/10-Outubro/NF-e/Saidas/XML/${chave}-nfe.xml`])
})

test('NF-e entre dois clientes grava nos dois', (t) => {
  const { db, servico, id, limpar } = montar()
  t.after(limpar)
  const outro = comOutro(db)
  const r = servico.importar([arq('n.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: OUTRO }))])
  assert.deepEqual(r.importadas.nfe, { entrada: 1, saida: 1 })
  assert.deepEqual(notas(db).map((n) => [n.cliente_id, n.tipo]), [[id, 'saida'], [outro, 'entrada']])
})

test('NF-e que era resumo vira completa e o resumo sai da pasta', (t) => {
  const { db, servico, id, pastaXmls, limpar } = montar()
  t.after(limpar)
  const chave = chaveNfe(FORA, 3)
  db.prepare("INSERT INTO notas (cliente_id, chave, tipo, modelo, status, competencia) VALUES (?, ?, 'entrada', 'nfe', 'resumo', '2026-10')").run(id, chave)
  const cliente = { cnpj: CNPJ_MOCK_OK, apelido: 'Cliente 1', razao_social: 'Cliente 1 Ltda' }
  const resumo = path.join(pastaXmls, caminhoDa({ cliente, competencia: '2026-10', categoria: 'resumo', nomeArquivo: `${chave}-resumo.xml` }))
  fs.mkdirSync(path.dirname(resumo), { recursive: true })
  fs.writeFileSync(resumo, '<resNFe/>')
  const r = servico.importar([arq('n.xml', nfeProc({ emit: FORA, dest: CNPJ_MOCK_OK, nNF: '3' }))])
  assert.deepEqual([r.importadas.nfe.entrada, r.jaExistiam], [1, 0])
  const [n] = notas(db)
  assert.deepEqual([n.status, n.origem, n.emitente_cnpj], ['completa', 'captura', FORA])
  assert.ok(n.caminho_xml.endsWith(`${chave}-nfe.xml`))
  assert.equal(fs.existsSync(resumo), false)
})

test('CT-e do tomador e de quem só aparece no CT-e', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const tom = comCliente(db, DEST, 'Tomador')
  const rem = comCliente(db, REM, 'Remetente')
  const chave = chaveCte(TRANSP, '77')
  const r = servico.importar([arq('c.xml', cteProc({}))])
  assert.deepEqual(r.importadas.cte, { entrada: 1, saida: 0, outro: 1 })
  const linhas = notas(db).map((n) => [n.cliente_id, n.tipo, n.modelo]).sort((a, b) => a[0] - b[0])
  assert.deepEqual(linhas, [[tom, 'entrada', 'cte'], [rem, 'outro', 'cte']])
  assert.ok(arquivos(pastaXmls).includes(`Tomador/2026/10-Outubro/CT-e/Entradas/XML/${chave}-cte.xml`))
  assert.ok(arquivos(pastaXmls).includes(`Remetente/2026/10-Outubro/CT-e/Outros/XML/${chave}-cte.xml`))
})

test('cancelamento de NF-e depois e antes da nota', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const c1 = chaveNfe(CNPJ_MOCK_OK, 1)
  servico.importar([arq('n.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '1' }))])
  const r = servico.importar([arq('e.xml', procEventoNfe({ chave: c1, emit: CNPJ_MOCK_OK }))])
  assert.equal(r.eventos, 1)
  assert.equal(notas(db)[0].cancelada, 1)
  assert.ok(arquivos(pastaXmls).includes(`Cliente 1/2026/10-Outubro/NF-e/Eventos e Resumos/${c1}-evento-110111-1.xml`))
  const c2 = chaveNfe(CNPJ_MOCK_OK, 2)
  servico.importar([arq('e2.xml', procEventoNfe({ chave: c2, emit: CNPJ_MOCK_OK }))])
  servico.importar([arq('n2.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '2' }))])
  assert.equal(db.prepare('SELECT cancelada FROM notas WHERE chave = ?').get(c2).cancelada, 1)
})

test('evento de NF-e sem a nota fica com o emitente da chave', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const chave = chaveNfe(CNPJ_MOCK_OK, 4)
  const r = servico.importar([arq('e.xml', procEventoNfe({ chave, emit: CNPJ_MOCK_OK }))])
  assert.deepEqual([r.eventos, r.ignoradas], [1, []])
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE chave = ?').get(chave).n, 1)
  assert.ok(arquivos(pastaXmls).some((f) => f.startsWith('Cliente 1/2026/10-Outubro/NF-e/Eventos e Resumos/')))
})

test('cancelamento de CT-e marca a nota', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  comCliente(db, DEST, 'Tomador')
  const chave = chaveCte(TRANSP, '77')
  servico.importar([arq('c.xml', cteProc({}))])
  const r = servico.importar([arq('e.xml', procEventoCte({ chave }))])
  assert.equal(r.eventos, 1)
  assert.equal(notas(db)[0].cancelada, 1)
})

test('evento de NFS-e sem a nota é ignorado e evento repetido já existia', (t) => {
  const { servico, limpar } = montar()
  t.after(limpar)
  const sem = servico.importar([arq('e.xml', xmlEventoNfse({ chave: chaveNfse(PRESTADOR_MOCK, 30) }))])
  assert.deepEqual(sem.ignoradas, [{ nome: 'e.xml', motivo: 'cnpj-nao-cadastrado' }])
  servico.importar([arq('a.xml', entrada(1))])
  const ev = () => arq('c.xml', xmlEventoNfse({ chave: chaveNfse(PRESTADOR_MOCK, 1) }))
  assert.equal(servico.importar([ev()]).eventos, 1)
  assert.equal(servico.importar([ev()]).jaExistiam, 1)
})

test('nota sem cliente vai para Sem cliente cadastrado, por tipo', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  comEscritorio(db)
  const nfe = chaveNfe(FORA, 9)
  const cte = chaveCte(TRANSP, '77')
  const nfse = chaveNfse(FORA, 9)
  const lote = () => [
    arq('n.xml', nfeProc({ emit: FORA, dest: OUTRO, nNF: '9' })),
    arq('c.xml', cteProc({})),
    arq('s.xml', xmlNfse({ chave: nfse, prestador: FORA, tomador: OUTRO })),
  ]
  const r = servico.importar(lote())
  assert.deepEqual([r.semCliente, r.ignoradas, notas(db).length], [3, [], 0])
  // A pasta do escritório leva a razão social.
  const base = 'Escritorio Ltda/Sem cliente cadastrado/2026/10-Outubro'
  assert.deepEqual(arquivos(pastaXmls), [`${base}/CT-e/Entradas/XML/${cte}-cte.xml`, `${base}/NF-e/Entradas/XML/${nfe}-nfe.xml`, `${base}/NFS-e/Entradas/XML/${nfse}-nfse.xml`])
  const deNovo = servico.importar(lote())
  assert.deepEqual([deNovo.semCliente, deNovo.ignoradas.length, arquivos(pastaXmls).length], [3, 0, 3])
})

test('sem escritório ou só da carteira, nota sem dono é ignorada', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const n = () => arq('n.xml', nfeProc({ emit: FORA, dest: OUTRO }))
  assert.deepEqual(servico.importar([n()]).ignoradas, [{ nome: 'n.xml', motivo: 'cnpj-nao-cadastrado' }])
  comEscritorio(db)
  const r = servico.importar([n()], { soDaCarteira: true })
  assert.deepEqual([r.ignoradas, r.semCliente], [[{ nome: 'n.xml', motivo: 'cnpj-nao-cadastrado' }], 0])
})

test('ZIP misto com os três tipos e um resumo', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  comCliente(db, DEST, 'Tomador')
  const zip = Buffer.from(zipSync({
    'nfe.xml': strToU8(nfeProc({ emit: FORA, dest: CNPJ_MOCK_OK })),
    'cte.xml': strToU8(cteProc({})),
    'nfse.xml': strToU8(entrada(1)),
    'resumo.xml': strToU8(`<resNFe xmlns="http://www.portalfiscal.inf.br/nfe"><chNFe>${chaveNfe(FORA, 8)}</chNFe></resNFe>`),
  }))
  const r = servico.importar([{ nome: 'lote.zip', bytes: zip }])
  assert.deepEqual([r.importadas.nfe.entrada, r.importadas.cte.entrada, r.importadas.nfse.entrada], [1, 1, 1])
  assert.deepEqual(r.ignoradas, [{ nome: 'lote.zip/resumo.xml', motivo: 'nao-suportado' }])
})

// ---------- correções da revisão final (NF-e e CT-e) ----------

test('evento que já existe sem XML recebe o arquivo', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const chave = chaveNfe(CNPJ_MOCK_OK, 21)
  servico.importar([arq('n.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '21' }))])
  db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, descricao) VALUES (?, '110111', '1', 'Cancelamento')").run(chave)
  const r = servico.importar([arq('e.xml', procEventoNfe({ chave, emit: CNPJ_MOCK_OK }))])
  assert.deepEqual([r.eventos, r.ignoradas], [1, []])
  const ev = db.prepare('SELECT * FROM eventos WHERE chave = ?').all(chave)
  assert.equal(ev.length, 1)
  assert.ok(ev[0].caminho_xml.endsWith(`${chave}-evento-110111-1.xml`))
})

test('nota completa no banco sem o arquivo no disco é regravada', (t) => {
  const { db, servico, pastaXmls, limpar } = montar()
  t.after(limpar)
  const xml = nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '22' })
  servico.importar([arq('n.xml', xml)])
  const n = notas(db)[0]
  fs.rmSync(path.join(pastaXmls, n.caminho_xml))
  const r = servico.importar([arq('n.xml', xml)])
  assert.deepEqual([r.importadas.nfe.saida, r.jaExistiam], [1, 0])
  assert.equal(fs.existsSync(path.join(pastaXmls, n.caminho_xml)), true)
  assert.equal(notas(db).length, 1)
})

test('evento rejeitado ou de homologação não cancela a nota', (t) => {
  const { db, servico, limpar } = montar()
  t.after(limpar)
  const chave = chaveNfe(CNPJ_MOCK_OK, 23)
  servico.importar([arq('n.xml', nfeProc({ emit: CNPJ_MOCK_OK, dest: FORA, nNF: '23' }))])
  const rejeitado = procEventoNfe({ chave, emit: CNPJ_MOCK_OK }).replace('<cStat>135</cStat>', '<cStat>573</cStat>')
  const homolog = procEventoNfe({ chave, emit: CNPJ_MOCK_OK }).replace('<tpAmb>1</tpAmb><CNPJ>', '<tpAmb>2</tpAmb><CNPJ>')
  const cteRejeitado = procEventoCte({ chave: chaveCte(TRANSP, '77') }).replace('<cStat>135</cStat>', '<cStat>220</cStat>')
  const r = servico.importar([arq('r.xml', rejeitado), arq('h.xml', homolog), arq('c.xml', cteRejeitado)])
  assert.deepEqual(r.ignoradas, [{ nome: 'r.xml', motivo: 'sem-protocolo' }, { nome: 'h.xml', motivo: 'homologacao' }, { nome: 'c.xml', motivo: 'sem-protocolo' }])
  assert.equal(notas(db)[0].cancelada, 0)
})
