'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { criarServicoExportacao } = require('../src/services/exportacao')
const { criarServicoCiclo } = require('../src/services/ciclo')
const { montarAmbiente, inserirNotas, AGORA } = require('./apoio/ambiente')
const { lerZip } = require('./apoio/zip')
const { CNPJ_MOCK_OK } = require('../src/sefaz/mock-client')

// Ambiente com o ciclo completo já rodado: A completa, B só resumo e cancelada, C completa.
async function preparado(t) {
  const amb = montarAmbiente()
  amb.deps.config.pastaExports = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-exp-'))
  t.after(() => {
    amb.limpar()
    fs.rmSync(amb.deps.config.pastaExports, { recursive: true, force: true })
  })
  await criarServicoCiclo(amb.deps).executarCiclo()
  const notas = amb.db.prepare('SELECT * FROM notas ORDER BY id').all()
  return { amb, notas, servico: criarServicoExportacao(amb.deps) }
}

const competencia = '2026-10'

test('ZIP com NF-e/Entradas, NF-e/Entradas/Canceladas e notas.xlsx; marca exportada_em', async (t) => {
  const { amb, notas, servico } = await preparado(t)
  const [a, b, c] = notas
  amb.db.prepare('UPDATE notas SET cancelada = 1 WHERE id = ?').run(c.id) // nota completa que foi cancelada

  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.equal(r.nome, `${CNPJ_MOCK_OK}_Cliente_1_2026-10.zip`)
  assert.equal(path.dirname(r.arquivo), amb.deps.config.pastaExports)
  assert.deepEqual([r.xmls, r.canceladas, r.semXml, r.totalNotas], [1, 1, 0, 3], 'B é cancelada: não conta como sem XML')
  assert.deepEqual(r.avisos, [])
  assert.deepEqual(r.porTipo, { entrada: { xmls: 1, canceladas: 1, semXml: 0 }, saida: { xmls: 0, canceladas: 0, semXml: 0 } })

  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.deepEqual([...zip.keys()].sort(), [`NF-e/Entradas/${a.chave}-nfe.xml`, `NF-e/Entradas/Canceladas/${c.chave}-nfe.xml`, 'notas.xlsx'])
  assert.deepEqual(zip.get(`NF-e/Entradas/${a.chave}-nfe.xml`), fs.readFileSync(path.join(amb.pastaXmls, a.caminho_xml)))

  const marcadas = amb.db.prepare('SELECT id, exportada_em FROM notas ORDER BY id').all()
  assert.equal(marcadas[0].exportada_em, AGORA.toISOString())
  assert.equal(marcadas[1].exportada_em, null, 'nota sem XML não é marcada')
  assert.equal(marcadas[2].exportada_em, AGORA.toISOString())
  assert.equal(b.status, 'resumo')

  const exec = amb.db.prepare("SELECT * FROM execucoes WHERE tipo = 'exportacao'").get()
  assert.equal(exec.docs_recebidos, 2)
  assert.ok(exec.fim)
  assert.equal(exec.erro, null)
  assert.deepEqual(fs.readdirSync(amb.deps.config.pastaExports), [r.nome], 'sem temporários sobrando')
})

test('notas.xlsx com a aba NF-e listando as notas do mês, inclusive as sem XML', async (t) => {
  const { notas, servico } = await preparado(t)
  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  const zip = lerZip(lerZip(fs.readFileSync(r.arquivo)).get('notas.xlsx'))
  const aba = zip.get('xl/worksheets/sheet1.xml').toString()
  const [a, b] = notas
  assert.match(zip.get('xl/workbook.xml').toString(), /name="NF-e".*name="NFS-e".*name="Retenções"/)
  assert.ok(aba.includes(`<t>${a.chave}</t>`))
  assert.ok(aba.includes(`<t>${b.chave}</t>`), 'nota só com resumo também aparece')
  assert.ok(aba.includes('<t>Fornecedor Alfa Ltda</t>'))
  assert.ok(aba.includes('<v>1500</v>'))
  assert.ok(aba.includes('<t>Só resumo</t>'))
})

test('competência sem notas gera ZIP só com a planilha (com os cabeçalhos)', async (t) => {
  const { servico } = await preparado(t)
  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia: '2025-01' })
  assert.equal(r.totalNotas, 0)
  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.deepEqual([...zip.keys()], ['notas.xlsx'])
  assert.ok(lerZip(zip.get('notas.xlsx')).get('xl/worksheets/sheet1.xml').toString().includes('<t>Chave</t>'))
})

test('XML ausente no disco vira aviso e a nota fica fora do ZIP', async (t) => {
  const { amb, notas, servico } = await preparado(t)
  fs.rmSync(path.join(amb.pastaXmls, notas[0].caminho_xml))
  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.equal(r.xmls, 1)
  assert.match(r.avisos[0], /não encontrado/)
  assert.equal(amb.db.prepare('SELECT exportada_em FROM notas WHERE id = ?').get(notas[0].id).exportada_em, null)
})

test('valida competência e CNPJ e registra a falha', async (t) => {
  const { amb, servico } = await preparado(t)
  await assert.rejects(servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia: '2026-13' }), /Competência inválida/)
  await assert.rejects(servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia: '10/2026' }), /Competência inválida/)
  await assert.rejects(servico.exportar({ cnpj: '00000000000000', competencia }), /não cadastrado/)

  // Pasta de exports bloqueada por um arquivo: a falha fica registrada em execucoes.
  const bloqueio = path.join(amb.deps.config.pastaExports, 'arquivo')
  fs.writeFileSync(bloqueio, 'x')
  const s2 = criarServicoExportacao({ ...amb.deps, config: { ...amb.deps.config, pastaExports: bloqueio } })
  await assert.rejects(s2.exportar({ cnpj: CNPJ_MOCK_OK, competencia }))
  assert.ok(amb.db.prepare("SELECT erro FROM execucoes WHERE tipo = 'exportacao' AND erro IS NOT NULL").get())
})

test('exportar de novo substitui o ZIP e só pega notas do cliente e da competência', async (t) => {
  const { amb, servico } = await preparado(t)
  inserirNotas(amb.db, amb.ids[0], 1, { competencia: '2026-09', status: 'completa' })
  const r1 = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  const r2 = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.equal(r1.arquivo, r2.arquivo)
  assert.equal(r2.totalNotas, 3)
  assert.equal(fs.readdirSync(amb.deps.config.pastaExports).length, 1)
})

// Insere uma nota completa com XML no disco (tipo e destinatário à escolha).
function notaComXml(amb, clienteId, i, extra = {}) {
  const [chave] = inserirNotas(amb.db, clienteId, 1, { inicio: i, status: 'completa' })
  const rel = `teste/${chave}-${extra.modelo === 'nfse' ? 'nfse' : 'nfe'}.xml`
  fs.mkdirSync(path.join(amb.pastaXmls, 'teste'), { recursive: true })
  fs.writeFileSync(path.join(amb.pastaXmls, rel), `<xml ${chave}/>`)
  const campos = { caminho_xml: rel, tipo: 'entrada', modelo: 'nfe', destinatario_cnpj: null, destinatario_nome: null, cancelada: 0, ...extra }
  amb.db.prepare('UPDATE notas SET caminho_xml=@caminho_xml, tipo=@tipo, modelo=@modelo, destinatario_cnpj=@destinatario_cnpj, destinatario_nome=@destinatario_nome, cancelada=@cancelada WHERE chave=@chave')
    .run({ ...campos, chave })
  return chave
}

function ambienteVazio(t) {
  const amb = montarAmbiente()
  amb.deps.config.pastaExports = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-exp-'))
  t.after(() => {
    amb.limpar()
    fs.rmSync(amb.deps.config.pastaExports, { recursive: true, force: true })
  })
  return amb
}

test('ZIP separa entradas e saídas e o CSV traz tipo e destinatário', async (t) => {
  const amb = ambienteVazio(t)
  const e1 = notaComXml(amb, amb.ids[0], 1)
  const e2 = notaComXml(amb, amb.ids[0], 2, { cancelada: 1 })
  const s1 = notaComXml(amb, amb.ids[0], 3, { tipo: 'saida', destinatario_cnpj: '98765432000110', destinatario_nome: 'Comprador SA' })
  const s2 = notaComXml(amb, amb.ids[0], 4, { tipo: 'saida', cancelada: 1 })
  const [s3] = inserirNotas(amb.db, amb.ids[0], 1, { inicio: 5, status: 'resumo' })
  amb.db.prepare("UPDATE notas SET tipo = 'saida' WHERE chave = ?").run(s3)

  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.deepEqual([r.xmls, r.canceladas, r.semXml, r.totalNotas], [2, 2, 1, 5])
  assert.deepEqual(r.porTipo, { entrada: { xmls: 1, canceladas: 1, semXml: 0 }, saida: { xmls: 1, canceladas: 1, semXml: 1 } })

  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.deepEqual([...zip.keys()].sort(), [
    `NF-e/Entradas/Canceladas/${e2}-nfe.xml`, `NF-e/Entradas/${e1}-nfe.xml`,
    `NF-e/Saidas/Canceladas/${s2}-nfe.xml`, `NF-e/Saidas/${s1}-nfe.xml`, 'notas.xlsx',
  ].sort())

  const aba = lerZip(zip.get('notas.xlsx')).get('xl/worksheets/sheet1.xml').toString()
  const linhaDe = (chave) => [...aba.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map((m) => m[1]).find((r) => r.includes(chave))
  assert.match(linhaDe(s1), /<t>Saída<\/t>.*<t>98\.765\.432\/0001-10<\/t><\/is><\/c><c [^>]+><is><t>Comprador SA<\/t>/)
  assert.match(linhaDe(e1), /<t>Entrada<\/t>/)
})

test('cliente só com saídas: ZIP só com NF-e/Saidas', async (t) => {
  const amb = ambienteVazio(t)
  const s1 = notaComXml(amb, amb.ids[0], 1, { tipo: 'saida' })
  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.deepEqual([...lerZip(fs.readFileSync(r.arquivo)).keys()].sort(), [`NF-e/Saidas/${s1}-nfe.xml`, 'notas.xlsx'])
  assert.deepEqual(r.porTipo.entrada, { xmls: 0, canceladas: 0, semXml: 0 })
})

test('recusa exportar pelo CNPJ do escritório', async (t) => {
  const amb = ambienteVazio(t)
  amb.db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, papel, cert_arquivo, cert_senha_enc) VALUES ('55666777000100', 'Escritório', 'escritorio', 'CE', 'escritorio', 'x.pfx', 'a:b:c')").run()
  await assert.rejects(criarServicoExportacao(amb.deps).exportar({ cnpj: '55666777000100', competencia }),
    /CNPJ 55666777000100 é do escritório: exporte pelo CNPJ do cliente\./)
})

test('NFS-e no ZIP: NFS-e/Saidas, NFS-e/Entradas/Canceladas e aba NFS-e na planilha', async (t) => {
  const amb = ambienteVazio(t)
  const e1 = notaComXml(amb, amb.ids[0], 1)
  const s1 = notaComXml(amb, amb.ids[0], 2, { modelo: 'nfse', tipo: 'saida' })
  const e2 = notaComXml(amb, amb.ids[0], 3, { modelo: 'nfse', cancelada: 1 })
  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.deepEqual([...zip.keys()].sort(), [`NF-e/Entradas/${e1}-nfe.xml`, `NFS-e/Entradas/Canceladas/${e2}-nfse.xml`, `NFS-e/Saidas/${s1}-nfse.xml`, 'notas.xlsx'].sort())
  const planilha = lerZip(zip.get('notas.xlsx'))
  assert.ok(planilha.get('xl/worksheets/sheet2.xml').toString().includes(`<t>${s1}</t>`), 'saída de NFS-e na aba NFS-e')
  assert.ok(!planilha.get('xl/worksheets/sheet1.xml').toString().includes(`<t>${s1}</t>`), 'e não na aba NF-e')
})

test('NFS-e no ZIP leva o PDF (DANFSe) ao lado do XML; XML ilegível vira aviso', async (t) => {
  const amb = ambienteVazio(t)
  const boa = notaComXml(amb, amb.ids[0], 1, { modelo: 'nfse', cancelada: 1 })
  const rel = amb.db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(boa).caminho_xml
  fs.writeFileSync(path.join(amb.pastaXmls, rel), fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml')))
  const ruim = notaComXml(amb, amb.ids[0], 2, { modelo: 'nfse' })
  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.ok(zip.has(`NFS-e/Entradas/Canceladas/${boa}-nfse.xml`))
  assert.ok(zip.get(`NFS-e/Entradas/Canceladas/${boa}-nfse.pdf`).subarray(0, 5).toString() === '%PDF-')
  assert.ok(zip.has(`NFS-e/Entradas/${ruim}-nfse.xml`))
  assert.ok(!zip.has(`NFS-e/Entradas/${ruim}-nfse.pdf`))
  assert.ok(r.avisos.some((a) => a.includes(ruim) && /PDF/.test(a)))
})
