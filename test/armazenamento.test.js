'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { caminhoDa, caminhoDoPdf, pastaDoGrupo, direcaoPelaChave, modeloPelaChave, nomes, pastaNoZip, nomeNoZip } = require('../src/services/armazenamento')

const cliente = { cnpj: '12138481000185', apelido: 'INOX' }
const escritorio = { cnpj: '01904741000160', apelido: 'escritorio', papel: 'escritorio', razao_social: 'SM Smart Auditoria' }
const p = (...partes) => path.join(...partes)

test('caminhoDa: nota, resumo e evento na ordem das telas (empresa, ano, mês, tipo, direção)', () => {
  const base = { cliente, competencia: '2026-10', nomeArquivo: 'x.xml' }
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada', categoria: 'nota' }), p('INOX', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfe', direcao: 'entrada', categoria: 'resumo' }), p('INOX', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'Resumos', 'x.xml'))
  assert.equal(caminhoDa({ ...base, modelo: 'nfse', direcao: 'saida', categoria: 'evento' }), p('INOX', '2026', 'Outubro', 'NFS-e', 'XML', 'Saidas', 'Eventos', 'x.xml'))
})

test('caminhoDa: fora da carteira e sem competência', () => {
  assert.equal(
    caminhoDa({ cliente: escritorio, foraDaCarteira: true, competencia: '2026-10', modelo: 'nfe', direcao: 'entrada', categoria: 'nota', nomeArquivo: 'x.xml' }),
    p('SM Smart Auditoria', 'fora-da-carteira', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'x.xml'),
  )
  assert.equal(
    caminhoDa({ cliente, competencia: null, modelo: 'nfe', direcao: 'entrada', categoria: 'nota', nomeArquivo: 'x.xml' }),
    p('INOX', 'sem-data', 'NF-e', 'XML', 'Entradas', 'x.xml'),
  )
})

test('caminhoDa: clientes com o mesmo nome levam o CNPJ; nome sem letras vira o CNPJ', () => {
  const base = { competencia: '2026-10', nomeArquivo: 'x.xml' }
  const outrosClientes = [cliente, { cnpj: '44555666000199', apelido: 'inox' }]
  assert.equal(caminhoDa({ ...base, cliente, outrosClientes }), p('INOX 12138481000185', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'x.xml'))
  assert.equal(caminhoDa({ ...base, cliente, outrosClientes: [cliente] }), p('INOX', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'x.xml'))
  assert.equal(caminhoDa({ ...base, cliente: { cnpj: '12138481000185', apelido: '***' } }), p('12138481000185', '2026', 'Outubro', 'NF-e', 'XML', 'Entradas', 'x.xml'))
})

test('direção e modelo pela chave', () => {
  const nfeDaInox = '23261012138481000185550010000157371500405319'
  const nfseDaInox = `230440012${cliente.cnpj}${'0'.repeat(27)}`
  assert.equal(nfseDaInox.length, 50)
  assert.equal(direcaoPelaChave(nfeDaInox, cliente.cnpj), 'saida')
  assert.equal(direcaoPelaChave(nfseDaInox, cliente.cnpj), 'saida')
  assert.equal(direcaoPelaChave(nfeDaInox, '10966475000190'), 'entrada')
  assert.equal(direcaoPelaChave(`230440012${'9'.repeat(14)}${'0'.repeat(27)}`, cliente.cnpj), 'entrada')
  assert.equal(modeloPelaChave(nfeDaInox), 'nfe')
  assert.equal(modeloPelaChave(nfseDaInox), 'nfse')
})

test('nome do arquivo da NFS-e', () => {
  assert.equal(nomes.nfse('1'.repeat(50)), `${'1'.repeat(50)}-nfse.xml`)
})

test('salvar regrava a declaração ISO-8859-1 como UTF-8', (t) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const { criarArmazenamento } = require('../src/services/armazenamento')
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-arm-'))
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }))
  const arm = criarArmazenamento({ pastaXmls: pasta })
  const rel = arm.salvar({ cliente, competencia: '2026-01', modelo: 'nfse', nomeArquivo: 'x.xml', xml: "<?xml version='1.0' encoding='ISO-8859-1'?><a>São Paulo</a>" })
  const gravado = fs.readFileSync(arm.absoluto(rel), 'utf8')
  assert.equal(gravado, "<?xml version='1.0' encoding=\"UTF-8\"?><a>São Paulo</a>")
})

test('CT-e: pastas CT-e/Entradas|Saidas|Outros e nome <chave>-cte.xml', () => {
  const CH = '3'.repeat(44)
  assert.equal(nomes.cte(CH), `${CH}-cte.xml`)
  assert.equal(
    caminhoDa({ cliente, modelo: 'cte', direcao: 'outro', competencia: '2026-10', nomeArquivo: nomes.cte(CH) }),
    p('INOX', '2026', 'Outubro', 'CT-e', 'XML', 'Outros', `${CH}-cte.xml`),
  )
  assert.equal(pastaNoZip({ modelo: 'cte', tipo: 'outro', cancelada: 0 }), 'CT-e/Outros')
  assert.equal(pastaNoZip({ modelo: 'cte', tipo: 'entrada', cancelada: 1 }), 'CT-e/Entradas/Canceladas')
  assert.equal(pastaNoZip({ modelo: 'cte', tipo: 'saida', cancelada: 0 }), 'CT-e/Saidas')
  assert.equal(nomeNoZip({ modelo: 'cte', chave: CH }), `${CH}-cte.xml`)
})

test('caminhoDoPdf: troca XML por PDF; resumo e evento não têm PDF', () => {
  assert.equal(caminhoDoPdf(p('E', '2026', 'Maio', 'CT-e', 'XML', 'Outros', '1-cte.xml')), p('E', '2026', 'Maio', 'CT-e', 'PDF', 'Outros', '1-cte.pdf'))
  assert.equal(caminhoDoPdf(p('E', 'fora-da-carteira', 'sem-data', 'NF-e', 'XML', 'Saidas', '1-nfe.xml')), p('E', 'fora-da-carteira', 'sem-data', 'NF-e', 'PDF', 'Saidas', '1-nfe.pdf'))
  assert.equal(caminhoDoPdf(p('E', '2026', 'Maio', 'NF-e', 'XML', 'Entradas', 'Resumos', '1-resumo.xml')), null)
  assert.equal(caminhoDoPdf(p('E', '2026', 'Maio', 'NF-e', 'XML', 'Entradas', 'Eventos', '1-evento-1-1.xml')), null)
  assert.equal(caminhoDoPdf(p('E', '2026', 'Maio', 'NF-e', 'Entradas', '1-nfe.xml')), null, 'caminho sem XML/ não tem PDF')
})

test('pastaDoGrupo: empresa, ano, mês e tipo; sem competência vai para sem-data', () => {
  assert.equal(pastaDoGrupo({ cliente, competencia: '2026-11', modelo: 'nfse' }), p('INOX', '2026', 'Novembro', 'NFS-e'))
  assert.equal(pastaDoGrupo({ cliente, competencia: null, modelo: 'nfe' }), p('INOX', 'sem-data', 'NF-e'))
  const outrosClientes = [cliente, { cnpj: '44555666000199', apelido: 'inox' }]
  assert.equal(pastaDoGrupo({ cliente, outrosClientes, competencia: '2026-01', modelo: 'cte' }), p('INOX 12138481000185', '2026', 'Janeiro', 'CT-e'))
})
