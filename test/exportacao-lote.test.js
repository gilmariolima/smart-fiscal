'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { criarServicoExportacaoLote } = require('../src/services/exportacaoLote')
const { montarAmbiente } = require('./apoio/ambiente')
const { cteProc } = require('./apoio/cte')

const fortaleza = fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8')
const CNPJS = ['11222333000181', '44555666000199', '77888999000100']

function preparar(t) {
  const amb = montarAmbiente({ clientes: CNPJS })
  t.after(amb.limpar)
  amb.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run('Luna Materiais', amb.ids[0])
  amb.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run('INOX', amb.ids[1])
  amb.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run('Zeta: Filial/Sul', amb.ids[2])
  let seq = 0
  const nota = ({ cliente = amb.ids[0], modelo = 'nfse', competencia = '2026-10', tipo = 'entrada', status = 'completa', cancelada = 0, xml = fortaleza, semArquivo = false }) => {
    const chave = String(++seq).padStart(modelo === 'nfse' ? 50 : 44, '0')
    const relativo = `x/${chave}.xml`
    if (xml && !semArquivo) {
      fs.mkdirSync(path.join(amb.pastaXmls, 'x'), { recursive: true })
      fs.writeFileSync(path.join(amb.pastaXmls, relativo), xml)
    }
    amb.db
      .prepare('INSERT INTO notas (cliente_id, chave, modelo, tipo, status, cancelada, competencia, caminho_xml) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(cliente, chave, modelo, tipo, status, cancelada, competencia, xml ? relativo : null)
    return chave
  }
  const s = criarServicoExportacaoLote(amb.deps)
  return { ...amb, nota, servico: { ...s, preparar: (e) => s.preparar({ incluir: ['pdf', 'xml'], ...e }) } }
}

async function arquivosDe(lote) {
  const lista = new Map()
  for await (const a of lote.arquivos()) lista.set(a.nome, a.caminho ? fs.readFileSync(a.caminho) : a.conteudo)
  return lista
}

test('ZIP por empresa, tipo, ano e mês, com as pastas PDF e XML', async (t) => {
  const a = preparar(t)
  const luna = a.nota({})
  const inox = a.nota({ cliente: a.ids[1], tipo: 'saida' })
  const cte = a.nota({ modelo: 'cte', competencia: '2026-03', tipo: 'outro', xml: cteProc({}) })

  const lote = a.servico.preparar({ modelos: ['nfse', 'cte'], competencias: ['2026-10', '2026-03'], clientes: [a.ids[0], a.ids[1]] })
  assert.equal(lote.total, 3)
  assert.equal(lote.nome, 'Smart-Fiscal-Exportacao-2026-10-09.zip')

  const arquivos = await arquivosDe(lote)
  assert.deepEqual([...arquivos.keys()].sort(), [
    `Luna Materiais/CT-e/2026/Março/PDF/${cte}-cte.pdf`,
    `Luna Materiais/CT-e/2026/Março/XML/${cte}-cte.xml`,
    `INOX/NFS-e/2026/Outubro/PDF/${inox}-nfse.pdf`,
    `INOX/NFS-e/2026/Outubro/XML/${inox}-nfse.xml`,
    `Luna Materiais/NFS-e/2026/Outubro/PDF/${luna}-nfse.pdf`,
    `Luna Materiais/NFS-e/2026/Outubro/XML/${luna}-nfse.xml`,
  ].sort())
  assert.equal(arquivos.get(`INOX/NFS-e/2026/Outubro/PDF/${inox}-nfse.pdf`).subarray(0, 5).toString(), '%PDF-')
  assert.equal(arquivos.get(`INOX/NFS-e/2026/Outubro/XML/${inox}-nfse.xml`).toString(), fortaleza)
})

test('clientes com o mesmo nome levam o CNPJ na pasta, para não misturar as notas', async (t) => {
  const a = preparar(t)
  a.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run('inox', a.ids[0])
  const n1 = a.nota({})
  const n2 = a.nota({ cliente: a.ids[1] })
  const n3 = a.nota({ cliente: a.ids[2] })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: a.ids })
  const nomes = [...(await arquivosDe(lote)).keys()]
  assert.ok(nomes.includes(`inox ${CNPJS[0]}/NFS-e/2026/Outubro/XML/${n1}-nfse.xml`), nomes.join())
  assert.ok(nomes.includes(`INOX ${CNPJS[1]}/NFS-e/2026/Outubro/XML/${n2}-nfse.xml`), nomes.join())
  assert.ok(nomes.includes(`Zeta Filial Sul/NFS-e/2026/Outubro/XML/${n3}-nfse.xml`), nomes.join())
})

test('caracteres proibidos no Windows saem do nome da pasta', async (t) => {
  const a = preparar(t)
  const zeta = a.nota({ cliente: a.ids[2] })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[2]] })
  assert.ok((await arquivosDe(lote)).has(`Zeta Filial Sul/NFS-e/2026/Outubro/XML/${zeta}-nfse.xml`))
})

test('nome longo é cortado em palavra inteira, para o caminho caber no Windows', async (t) => {
  const a = preparar(t)
  a.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run('SM Smart Auditoria e Consultoria Contábil Ltda', a.ids[0])
  const n = a.nota({})
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]] })
  assert.ok((await arquivosDe(lote)).has(`SM Smart Auditoria e Consultoria/NFS-e/2026/Outubro/XML/${n}-nfse.xml`))
})

test('escritório usa a razão social, não o apelido interno', async (t) => {
  const a = preparar(t)
  a.db.prepare("UPDATE clientes SET papel = 'escritorio', tambem_cliente = 1, apelido = 'escritorio', razao_social = 'SM Smart Auditoria Ltda' WHERE id = ?").run(a.ids[2])
  const n = a.nota({ cliente: a.ids[2] })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[2]] })
  assert.ok((await arquivosDe(lote)).has(`SM Smart Auditoria Ltda/NFS-e/2026/Outubro/XML/${n}-nfse.xml`))
  assert.ok(a.servico.opcoes().clientes.some((c) => c.nome === 'SM Smart Auditoria Ltda'))
})

test('só entram notas com XML completo, do tipo, mês e cliente escolhidos', async (t) => {
  const a = preparar(t)
  const certa = a.nota({})
  a.nota({ status: 'resumo', xml: null })
  a.nota({ competencia: '2026-09' })
  a.nota({ cliente: a.ids[1] })
  a.nota({ modelo: 'cte', xml: cteProc({}) })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]] })
  assert.equal(lote.total, 1)
  assert.deepEqual([...(await arquivosDe(lote)).keys()].sort(), [
    `Luna Materiais/NFS-e/2026/Outubro/PDF/${certa}-nfse.pdf`,
    `Luna Materiais/NFS-e/2026/Outubro/XML/${certa}-nfse.xml`,
  ])
})

test('nota cancelada leva o XML do cancelamento na pasta XML', async (t) => {
  const a = preparar(t)
  const c = a.nota({ cancelada: 1 })
  const evento = `x/${c}-evento-110111-1.xml`
  fs.writeFileSync(path.join(a.pastaXmls, evento), '<evento/>')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(c, evento)
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]] })
  assert.equal((await arquivosDe(lote)).get(`Luna Materiais/NFS-e/2026/Outubro/XML/${c}-evento-110111-1.xml`).toString(), '<evento/>')
})

test('XML sumido ou PDF com erro não param a exportação: vão para avisos.txt', async (t) => {
  const a = preparar(t)
  const boa = a.nota({})
  const sumida = a.nota({ semArquivo: true })
  const ruim = a.nota({ xml: '<nada/>' })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]] })
  const arquivos = await arquivosDe(lote)
  assert.ok(arquivos.has(`Luna Materiais/NFS-e/2026/Outubro/PDF/${boa}-nfse.pdf`))
  assert.ok(arquivos.has(`Luna Materiais/NFS-e/2026/Outubro/XML/${ruim}-nfse.xml`))
  assert.ok(![...arquivos.keys()].some((n) => n.includes(sumida)))
  const avisos = arquivos.get('avisos.txt').toString()
  assert.match(avisos, new RegExp(`${sumida}.*XML não encontrado`))
  assert.match(avisos, new RegExp(`${ruim}.*não gerado`))
})

test('escolha inválida ou sem notas é recusada antes de gerar', (t) => {
  const a = preparar(t)
  const base = { modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]] }
  for (const errado of [{ modelos: [] }, { modelos: ['xyz'] }, { competencias: [] }, { competencias: ['2026/10'] }, { clientes: [] }, { clientes: ['1 OR 1'] }, { incluir: [] }, { incluir: ['exe'] }, { incluir: null }]) {
    assert.throws(() => a.servico.preparar({ ...base, ...errado }), (e) => e.status === 400, JSON.stringify(errado))
  }
  assert.throws(() => a.servico.preparar({ ...base, clientes: [99999] }), (e) => e.status === 400)
  assert.throws(() => a.servico.preparar(base), (e) => e.status === 409)
})

test('opções trazem os clientes em ordem e a contagem só das notas com XML', (t) => {
  const a = preparar(t)
  a.nota({})
  a.nota({})
  a.nota({ status: 'resumo', xml: null })
  a.nota({ modelo: 'cte', competencia: '2025-12', cliente: a.ids[1], xml: cteProc({}) })
  const o = a.servico.opcoes()
  assert.deepEqual(o.clientes.map((c) => c.nome), ['INOX', 'Luna Materiais', 'Zeta: Filial/Sul'])
  assert.equal(o.clientes[0].cnpj, CNPJS[1], 'o CNPJ vai junto, para a busca da tela')
  assert.deepEqual(o.notas.sort((x, y) => x.total - y.total), [
    { modelo: 'cte', competencia: '2025-12', clienteId: a.ids[1], total: 1 },
    { modelo: 'nfse', competencia: '2026-10', clienteId: a.ids[0], total: 2 },
  ])
})

test('tudo: relatório e planilha de cada mês soltos na pasta do mês, ao lado de PDF e XML', async (t) => {
  const a = preparar(t)
  const luna = a.nota({})
  a.nota({ tipo: 'saida' })
  const lote = a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]], incluir: ['pdf', 'xml', 'relatorio', 'excel'] })
  const arquivos = await arquivosDe(lote)
  const mes = 'Luna Materiais/NFS-e/2026/Outubro'
  assert.ok(arquivos.has(`${mes}/PDF/${luna}-nfse.pdf`))
  assert.ok(arquivos.has(`${mes}/XML/${luna}-nfse.xml`))
  assert.equal(arquivos.get(`${mes}/Relatorio NFS-e Outubro 2026.pdf`).subarray(0, 5).toString(), '%PDF-')
  assert.equal(arquivos.get(`${mes}/Relatorio NFS-e Outubro 2026.xlsx`).subarray(0, 2).toString(), 'PK')
  assert.equal([...arquivos.keys()].filter((n) => /Relatorio/.test(n)).length, 2, 'um de cada por mês, não por nota')
})

test('só o que foi escolhido entra no ZIP', async (t) => {
  const a = preparar(t)
  const n = a.nota({})
  const so = async (incluir) => [...(await arquivosDe(a.servico.preparar({ modelos: ['nfse'], competencias: ['2026-10'], clientes: [a.ids[0]], incluir }))).keys()]
  const mes = 'Luna Materiais/NFS-e/2026/Outubro'
  assert.deepEqual(await so(['xml']), [`${mes}/XML/${n}-nfse.xml`])
  assert.deepEqual(await so(['pdf']), [`${mes}/PDF/${n}-nfse.pdf`])
  assert.deepEqual(await so(['relatorio']), [`${mes}/Relatorio NFS-e Outubro 2026.pdf`])
  assert.deepEqual(await so(['excel']), [`${mes}/Relatorio NFS-e Outubro 2026.xlsx`])
})

test('relatório e planilha de empresas e tipos diferentes não se misturam', async (t) => {
  const a = preparar(t)
  a.nota({})
  a.nota({ cliente: a.ids[1] })
  a.nota({ modelo: 'cte', tipo: 'outro', xml: cteProc({}) })
  const lote = a.servico.preparar({ modelos: ['nfse', 'cte'], competencias: ['2026-10'], clientes: [a.ids[0], a.ids[1]], incluir: ['excel'] })
  assert.deepEqual([...(await arquivosDe(lote)).keys()].sort(), [
    'INOX/NFS-e/2026/Outubro/Relatorio NFS-e Outubro 2026.xlsx',
    'Luna Materiais/CT-e/2026/Outubro/Relatorio CT-e Outubro 2026.xlsx',
    'Luna Materiais/NFS-e/2026/Outubro/Relatorio NFS-e Outubro 2026.xlsx',
  ])
})
