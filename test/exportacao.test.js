'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { criarServicoExportacao, montarCsv } = require('../src/services/exportacao')
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

test('ZIP com entradas/xml, entradas/canceladas e resumo.csv; marca exportada_em', async (t) => {
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
  assert.deepEqual([...zip.keys()].sort(), [`entradas/canceladas/${c.chave}-nfe.xml`, `entradas/xml/${a.chave}-nfe.xml`, 'resumo.csv'])
  assert.deepEqual(zip.get(`entradas/xml/${a.chave}-nfe.xml`), fs.readFileSync(path.join(amb.pastaXmls, a.caminho_xml)))

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

test('resumo.csv no formato do Excel brasileiro, com as notas sem XML', async (t) => {
  const { notas, servico } = await preparado(t)
  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  const csv = lerZip(fs.readFileSync(r.arquivo)).get('resumo.csv').toString('utf8')
  assert.ok(csv.startsWith('﻿'), 'UTF-8 com BOM')
  const linhas = csv.slice(1).split('\r\n')
  assert.equal(linhas[0], 'chave;tipo;numero;serie;data_emissao;emitente_cnpj;emitente_nome;destinatario_cnpj;destinatario_nome;valor_total;status;cancelada')
  assert.equal(linhas.at(-1), '', 'termina com quebra de linha')
  assert.equal(linhas.length, 5)

  const porChave = Object.fromEntries(linhas.slice(1, -1).map((l) => [l.split(';')[0], l]))
  const [a, b] = notas
  const dia = a.data_emissao.slice(0, 10).split('-').reverse().join('/')
  assert.equal(porChave[`="${a.chave}"`], `="${a.chave}";entrada;${a.numero};1;${dia};="12345678000195";Fornecedor Alfa Ltda;="11222333000181";CLIENTE SIMULADO;1500,00;completa;não`)
  assert.match(porChave[`="${b.chave}"`], /;820,50;resumo;sim$/)
})

test('CSV protege contra fórmula e escapa separador e aspas', () => {
  const csv = montarCsv([
    { chave: '1'.repeat(44), numero: '1', serie: '1', data_emissao: '2026-10-01T10:00:00-03:00', emitente_cnpj: '1")+HYPERLINK("x', emitente_nome: '=HYPERLINK("http://x")', tipo: 'saida', destinatario_cnpj: '98.765.432/0001-10', destinatario_nome: '+cmd', valor_total: 10, status: 'completa', cancelada: 0 },
    { chave: '2'.repeat(44), numero: null, serie: null, data_emissao: null, emitente_cnpj: null, emitente_nome: 'Alfa; Beta "Filial"', tipo: 'entrada', valor_total: null, status: 'resumo', cancelada: 1 },
  ])
  const [, l1, l2] = csv.slice(1).split('\r\n')
  assert.equal(l1, `="${'1'.repeat(44)}";saida;1;1;01/10/2026;="1";"'=HYPERLINK(""http://x"")";="98765432000110";'+cmd;10,00;completa;não`)
  assert.equal(l2, `="${'2'.repeat(44)}";entrada;;;;;"Alfa; Beta ""Filial""";;;;resumo;sim`)
})

test('competência sem notas gera ZIP só com o cabeçalho do CSV', async (t) => {
  const { servico } = await preparado(t)
  const r = await servico.exportar({ cnpj: CNPJ_MOCK_OK, competencia: '2025-01' })
  assert.equal(r.totalNotas, 0)
  const zip = lerZip(fs.readFileSync(r.arquivo))
  assert.deepEqual([...zip.keys()], ['resumo.csv'])
  assert.equal(zip.get('resumo.csv').toString('utf8').split('\r\n').length, 2)
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
  const rel = `teste/${chave}-nfe.xml`
  fs.mkdirSync(path.join(amb.pastaXmls, 'teste'), { recursive: true })
  fs.writeFileSync(path.join(amb.pastaXmls, rel), `<xml ${chave}/>`)
  const campos = { caminho_xml: rel, tipo: 'entrada', destinatario_cnpj: null, destinatario_nome: null, cancelada: 0, ...extra }
  amb.db.prepare('UPDATE notas SET caminho_xml=@caminho_xml, tipo=@tipo, destinatario_cnpj=@destinatario_cnpj, destinatario_nome=@destinatario_nome, cancelada=@cancelada WHERE chave=@chave')
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
    `entradas/canceladas/${e2}-nfe.xml`, `entradas/xml/${e1}-nfe.xml`,
    `saidas/canceladas/${s2}-nfe.xml`, `saidas/xml/${s1}-nfe.xml`, 'resumo.csv',
  ].sort())

  const linhas = zip.get('resumo.csv').toString('utf8').slice(1).split('\r\n')
  const l = linhas.find((x) => x.startsWith(`="${s1}"`))
  assert.match(l, /;saida;/)
  assert.match(l, /;="98765432000110";Comprador SA;/)
  assert.match(linhas.find((x) => x.startsWith(`="${e1}"`)), /;entrada;/)
})

test('cliente só com saídas: ZIP só com saidas/', async (t) => {
  const amb = ambienteVazio(t)
  const s1 = notaComXml(amb, amb.ids[0], 1, { tipo: 'saida' })
  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: CNPJ_MOCK_OK, competencia })
  assert.deepEqual([...lerZip(fs.readFileSync(r.arquivo)).keys()].sort(), ['resumo.csv', `saidas/xml/${s1}-nfe.xml`])
  assert.deepEqual(r.porTipo.entrada, { xmls: 0, canceladas: 0, semXml: 0 })
})

test('recusa exportar pelo CNPJ do escritório', async (t) => {
  const amb = ambienteVazio(t)
  amb.db.prepare("INSERT INTO clientes (cnpj, razao_social, apelido, uf, papel, cert_arquivo, cert_senha_enc) VALUES ('55666777000100', 'Escritório', 'escritorio', 'CE', 'escritorio', 'x.pfx', 'a:b:c')").run()
  await assert.rejects(criarServicoExportacao(amb.deps).exportar({ cnpj: '55666777000100', competencia }),
    /CNPJ 55666777000100 é do escritório: exporte pelo CNPJ do cliente\./)
})
