'use strict'

// CF-e (SAT/MFE): leitura, importação (XML solto e ZIP), conferência do mês, exportação e as rotas do
// painel. Base: os XMLs reais da documentação da SATCFe (test/apoio/cfe), com variações montadas aqui.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const AdmZip = require('adm-zip')
const { lerCupom, criarServicoCupons } = require('../src/services/cupons')
const { criarServicoExportacao } = require('../src/services/exportacao')
const { criarApp } = require('../src/web/server')
const { criarContexto } = require('../src/contexto')
const { carregarConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { criarAgendador } = require('../src/scheduler')
const { montarAmbiente, silencioso } = require('./apoio/ambiente')
const { lerZip } = require('./apoio/zip')

const VENDA = fs.readFileSync(path.join(__dirname, 'apoio', 'cfe', 'venda.xml'), 'utf8')
const CANC = fs.readFileSync(path.join(__dirname, 'apoio', 'cfe', 'cancelamento.xml'), 'utf8')
const DIMEP = '61099008000141' // emitente dos XMLs de exemplo
const LOJA = '11222333000181'

function chaveCfe({ cnpj, data, equipamento, numero, cNF = '123456' }) {
  // cUF (2) + AAMM (4) + CNPJ (14) + modelo (2) + série do equipamento (9) + nCFe (6) + cNF (6) + DV (1) = 44
  return `23${data.slice(2, 4)}${data.slice(4, 6)}${cnpj}59${equipamento}${String(numero).padStart(6, '0')}${cNF}0`
}

/** Um CF-e de venda a partir do XML real, com outro emitente, número, data, valor e equipamento. */
function venda({ cnpj = LOJA, numero = 1, data = '20261005', hora = '101500', valor = '10.00', equipamento = '900111222', tpAmb = '1' } = {}) {
  const chave = chaveCfe({ cnpj, data, equipamento, numero })
  const xml = VENDA
    .replace(/Id="CFe\d{44}"/, `Id="CFe${chave}"`)
    .replace(/<nCFe>\d+<\/nCFe>/, `<nCFe>${String(numero).padStart(6, '0')}</nCFe>`)
    .replace(/<dEmi>\d+<\/dEmi>/, `<dEmi>${data}</dEmi>`)
    .replace(/<hEmi>\d+<\/hEmi>/, `<hEmi>${hora}</hEmi>`)
    .replace(/<nserieSAT>\d+<\/nserieSAT>/, `<nserieSAT>${equipamento}</nserieSAT>`)
    .replace(/<tpAmb>\d<\/tpAmb>/, `<tpAmb>${tpAmb}</tpAmb>`)
    .replace(/<vCFe>[\d.]+<\/vCFe>/, `<vCFe>${valor}</vCFe>`)
    .replace(`<CNPJ>${DIMEP}</CNPJ>`, `<CNPJ>${cnpj}</CNPJ>`)
  return { chave, xml }
}

/** Cancelamento do cupom `chaveVenda`, com o próprio número na sequência do equipamento. */
function cancelamento({ chaveVenda, cnpj = LOJA, numero = 2, data = '20261005', equipamento = '900111222' }) {
  const chave = chaveCfe({ cnpj, data, equipamento, numero, cNF: '654321' })
  return CANC
    .replace(/Id="CFe\d{44}"/, `Id="CFe${chave}"`)
    .replace(/chCanc="CFe\d{44}"/, `chCanc="CFe${chaveVenda}"`)
    .replace(/<nCFe>\d+<\/nCFe>/, `<nCFe>${String(numero).padStart(6, '0')}</nCFe>`)
    .replace(/<nserieSAT>\d+<\/nserieSAT>/, `<nserieSAT>${equipamento}</nserieSAT>`)
    .replace(`<CNPJ>${DIMEP}</CNPJ>`, `<CNPJ>${cnpj}</CNPJ>`)
}

const arquivo = (nome, xml) => ({ nome, conteudo: Buffer.from(xml, 'utf8') })

function zip(arquivos) {
  const z = new AdmZip()
  for (const [nome, xml] of arquivos) z.addFile(nome, Buffer.from(xml, 'utf8'))
  return z.toBuffer()
}

function montar(t, clientes = [LOJA, DIMEP]) {
  const amb = montarAmbiente({ clientes })
  amb.deps.config.pastaExports = path.join(amb.pastaXmls, 'exports')
  t.after(() => {
    amb.db.close()
    amb.limpar()
  })
  return { ...amb, cupons: criarServicoCupons(amb.deps) }
}

test('lê o CF-e real de venda e o cancelamento dele', () => {
  const v = lerCupom(VENDA)
  assert.equal(v.tipo, 'venda')
  assert.equal(v.chave, '35161261099008000141599000026310003024947916')
  assert.deepEqual([v.cnpj, v.numero, v.equipamento, v.caixa, v.dataHora, v.valor, v.ambiente],
    [DIMEP, '000302', '900002631', '001', '2016-12-20T09:51:11', 4, '2'])
  const c = lerCupom(CANC)
  assert.equal(c.tipo, 'cancelamento')
  assert.equal(c.chaveVenda, v.chave)
  assert.equal(c.numero, '000303')
})

test('recusa o que não é CF-e autorizado, com o motivo', () => {
  assert.throws(() => lerCupom('<nfeProc/>'), /não é um CF-e/)
  assert.throws(() => lerCupom('isto não é xml <'), /XML inválido|não é um CF-e/)
  // CF-e de venda antes de passar pelo SAT/MFE (sem chave)
  assert.throws(() => lerCupom(VENDA.replace(/Id="CFe\d{44}"/, 'Id=""')), /sem a chave de acesso/)
})

test('importa os XMLs reais: venda e cancelamento ficam juntos no cliente certo', (t) => {
  const { cupons, pastaXmls } = montar(t)
  const r = cupons.importar([arquivo('venda.xml', VENDA), arquivo('canc.xml', CANC)])
  assert.deepEqual([r.lidos, r.importados, r.cancelamentos, r.repetidos, r.invalidos.length], [2, 1, 1, 0, 0])
  assert.deepEqual(r.porCliente.map((c) => [c.cnpj, c.competencias]), [[DIMEP, ['2016-12']]])
  const mes = cupons.mes(DIMEP, '2016-12')
  assert.equal(mes.cupons.length, 1)
  assert.equal(mes.cupons[0].cancelado, true)
  assert.deepEqual([mes.conferencia.validos, mes.conferencia.cancelados, mes.conferencia.valorCancelado], [0, 1, 4])
  assert.deepEqual(mes.conferencia.faltando, []) // venda 302 e cancelamento 303: sequência completa
  assert.ok(mes.conferencia.avisos.some((a) => /teste \(homologação/.test(a)))
  const pasta = fs.readdirSync(path.join(pastaXmls, `${DIMEP}_Cliente_2`, 'cfe', '2016-12')).sort()
  assert.deepEqual(pasta, ['35161261099008000141599000026310003024947916-cfe-canc.xml', '35161261099008000141599000026310003024947916-cfe.xml'])
  // Importar de novo não duplica
  const r2 = cupons.importar([arquivo('venda.xml', VENDA), arquivo('canc.xml', CANC)])
  assert.deepEqual([r2.importados, r2.cancelamentos, r2.repetidos], [0, 0, 2])
})

test('ZIP do mês: separa outros CNPJs, arquivos inválidos e mostra os números faltando', (t) => {
  const { cupons } = montar(t)
  const v1 = venda({ numero: 1, valor: '10.00' })
  const v2 = venda({ numero: 2, valor: '25.50', data: '20261006' })
  const v5 = venda({ numero: 5, valor: '4.50', data: '20261006' })
  const outro = venda({ cnpj: '99888777000100', numero: 1 })
  const conteudo = zip([
    ['cfe/v1.xml', v1.xml], ['cfe/v2.xml', v2.xml], ['cfe/v5.xml', v5.xml], ['cfe/v1-copia.xml', v1.xml],
    ['outra-loja/x.xml', outro.xml], ['leia-me.xml', '<texto>oi</texto>'], ['foto.jpg', 'x'],
  ])
  const r = cupons.importar([{ nome: 'outubro.zip', conteudo }])
  assert.deepEqual([r.lidos, r.importados, r.repetidos], [6, 3, 1])
  assert.deepEqual(r.foraDaCarteira, [{ cnpj: '99888777000100', nome: 'DIMAS DE MELO PIMENTA SISTEMAS DE PONTO E ACESSO LTDA', cupons: 1 }])
  assert.equal(r.invalidos.length, 1)
  assert.match(r.invalidos[0].arquivo, /outubro\.zip › leia-me\.xml/)
  const c = cupons.mes(LOJA, '2026-10').conferencia
  assert.deepEqual([c.validos, c.valor, c.cancelados], [3, 40, 0])
  assert.deepEqual(c.porDia, [{ dia: '2026-10-05', cupons: 1, valor: 10 }, { dia: '2026-10-06', cupons: 2, valor: 30 }])
  assert.deepEqual(c.faltando, [{ equipamento: '900111222', primeiro: 1, ultimo: 5, numeros: [3, 4] }])
  assert.ok(c.avisos.some((a) => /MFE 900111222: 2 número\(s\) faltando entre 1 e 5 \(ex\.: 3, 4\)/.test(a)))
  assert.deepEqual(cupons.competencias(LOJA), [{ competencia: '2026-10', cupons: 3 }])
})

test('cancelamento sem a venda importada vira aviso; quando a venda chega, o cupom aparece cancelado', (t) => {
  const { cupons } = montar(t)
  const v = venda({ numero: 7 })
  cupons.importar([arquivo('canc.xml', cancelamento({ chaveVenda: v.chave, numero: 8 }))])
  assert.ok(cupons.mes(LOJA, '2026-10').conferencia.avisos.some((a) => /1 cancelamento\(s\) sem o cupom de venda/.test(a)))
  cupons.importar([arquivo('venda.xml', v.xml)])
  const mes = cupons.mes(LOJA, '2026-10')
  assert.equal(mes.cupons[0].cancelado, true)
  assert.ok(!mes.conferencia.avisos.some((a) => /sem o cupom de venda/.test(a)))
})

test('cupom de quem não é cliente não entra; CNPJ não cadastrado na consulta dá erro claro', (t) => {
  const { cupons } = montar(t, [LOJA])
  const r = cupons.importar([arquivo('venda.xml', VENDA)])
  assert.equal(r.importados, 0)
  assert.equal(r.foraDaCarteira[0].cnpj, DIMEP)
  assert.throws(() => cupons.mes(DIMEP, '2016-12'), /não é um cliente cadastrado/)
})

test('exportação do mês leva os cupons (válidos e cancelados) e o cupons.csv', async (t) => {
  const amb = montar(t)
  const v1 = venda({ numero: 1, valor: '10.00' })
  const v2 = venda({ numero: 2, valor: '20.00' })
  amb.cupons.importar([arquivo('a.xml', v1.xml), arquivo('b.xml', v2.xml), arquivo('c.xml', cancelamento({ chaveVenda: v2.chave, numero: 3 }))])
  const r = await criarServicoExportacao(amb.deps).exportar({ cnpj: LOJA, competencia: '2026-10' })
  assert.deepEqual(r.cupons, { validos: 1, cancelados: 1 })
  const zipado = lerZip(fs.readFileSync(r.arquivo))
  const nomes = [...zipado.keys()].sort()
  assert.deepEqual(nomes, [
    'cupons.csv',
    `cupons/cancelados/${v2.chave}-cfe-canc.xml`,
    `cupons/cancelados/${v2.chave}-cfe.xml`,
    `cupons/xml/${v1.chave}-cfe.xml`,
    'resumo.csv',
  ])
  const csv = zipado.get('cupons.csv').toString('utf8')
  assert.match(csv, /^﻿chave;numero;equipamento;caixa;data_emissao;hora;valor_total;destinatario_doc;destinatario_nome;cancelado\r\n/)
  assert.match(csv, new RegExp(`="${v1.chave}";000001;="900111222";001;05/10/2026;10:15:00;10,00;;;não`))
  assert.match(csv, /;20,00;;;sim\r\n$/)
})

test('painel: importa pelo envio do arquivo, lista o mês e baixa o XML', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cupons-'))
  const pastaPainel = path.join(base, 'painel')
  fs.mkdirSync(pastaPainel)
  fs.writeFileSync(path.join(pastaPainel, 'index.html'), '<!doctype html><title>Smart Fiscal</title>')
  const env = { MASTER_KEY: crypto.randomBytes(32).toString('hex'), SEFAZ_MOCK: '1', PASTA_XMLS: path.join(base, 'xmls'),
    PASTA_CERTS: path.join(base, 'certs'), PASTA_EXPORTS: path.join(base, 'exports') }
  const ctx = criarContexto({ config: carregarConfig(env), logger: silencioso, db: abrirBanco(':memory:') })
  ctx.db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, 'Loja Ltda', 'Loja', 'CE', 'x.pfx', 'a:b:c')`).run(LOJA)
  const agendador = criarAgendador({ ciclo: ctx.ciclo, config: ctx.config, logger: silencioso, automacao: ctx.automacao, atrasoInicialMs: false })
  const servidor = criarApp({ ctx, agendador, pastaPainel }).listen(0, '127.0.0.1')
  await new Promise((r) => servidor.once('listening', r))
  const url = `http://127.0.0.1:${servidor.address().port}`
  t.after(async () => {
    await new Promise((r) => servidor.close(r))
    ctx.fechar()
    fs.rmSync(base, { recursive: true, force: true })
  })

  const v = venda({ numero: 1, valor: '12.34' })
  const conteudo = zip([['v.xml', v.xml]])
  const semPainel = await fetch(`${url}/api/cupons/importar?nome=outubro.zip`, { method: 'POST', body: conteudo })
  assert.equal(semPainel.status, 403)
  const r = await (await fetch(`${url}/api/cupons/importar?nome=outubro.zip`, { method: 'POST', body: conteudo, headers: { 'X-Painel': '1', 'Content-Type': 'application/zip' } })).json()
  assert.equal(r.importados, 1)
  assert.deepEqual(await (await fetch(`${url}/api/cupons/competencias?cnpj=${LOJA}`)).json(), [{ competencia: '2026-10', cupons: 1 }])
  const mes = await (await fetch(`${url}/api/cupons?cnpj=${LOJA}&competencia=2026-10`)).json()
  assert.equal(mes.conferencia.valor, 12.34)
  const xml = await fetch(`${url}/api/cupons/${mes.cupons[0].id}/xml`)
  assert.equal(xml.status, 200)
  assert.match(xml.headers.get('content-disposition'), new RegExp(`${v.chave}-cfe\\.xml`))
  assert.match(await xml.text(), /<vCFe>12\.34<\/vCFe>/)
  assert.equal((await fetch(`${url}/api/cupons?cnpj=99999999000199&competencia=2026-10`)).status, 404)
  assert.equal((await fetch(`${url}/api/cupons/999/xml`)).status, 404)
})
