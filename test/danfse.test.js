'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { dadosDanfse } = require('../src/services/danfse/dados')
const { gerarDanfse } = require('../src/services/danfse/gerar')

// Textos do PDF (sem compressão): cada TJ junta os pedaços em hexadecimal, separados por ajustes de espaçamento.
const textos = (pdf) => [...pdf.toString('latin1').matchAll(/\[(.*?)\] TJ/g)].map(([, tj]) => [...tj.matchAll(/<([0-9a-f]+)>/g)].map(([, h]) => Buffer.from(h, 'hex').toString('latin1')).join(''))
const fixture = (nome) => fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', nome), 'utf8')

test('identificação: chave, datas DD/MM/AAAA hh:mm:ss, descrições por extenso e QR Code', () => {
  const d = dadosDanfse(fixture('fortaleza.xml'))
  assert.equal(d.chave, '23044001299888777000166000000001776326010683819470')
  assert.equal(d.urlQr, 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=23044001299888777000166000000001776326010683819470')
  assert.equal(d.numero, '17763')
  assert.equal(d.competencia, '01/01/2026')
  assert.equal(d.emissaoNfse, '19/01/2026 15:19:22', 'hora local do ISS Fortaleza, sem conversão')
  assert.equal(d.emissaoDps, '19/01/2026 15:19:22')
  assert.deepEqual([d.numeroDps, d.serieDps], ['17763', '1'])
  assert.equal(d.emitente, 'Prestador')
  assert.equal(d.situacao, 'NFS-e Gerada')
  assert.equal(d.finalidade, '-', 'campo ausente no XML vira traço')
  assert.equal(d.municipioEmissao, 'Município: Fortaleza / CE')
  assert.equal(d.ambienteGerador, 'Ambiente Gerador: Sistema próprio do município')
  assert.equal(d.tipoAmbiente, 'Tipo de Ambiente: Produção')
  assert.equal(d.homologacao, false)
})

test('prestador e tomador com documento formatado, município pelo código IBGE e CEP', () => {
  const d = dadosDanfse(fixture('fortaleza.xml'))
  assert.equal(d.prestador.documento, '99.888.777/0001-66')
  assert.equal(d.prestador.municipio, 'Fortaleza / CE')
  assert.equal(d.prestador.ibgeCep, '2304400 / 60.000-000')
  assert.equal(d.prestador.simples, 'Não Optante')
  assert.equal(d.prestador.regimeSn, '-')
  assert.equal(d.tomador.documento, '11.222.333/0001-81')
  assert.equal(d.tomador.municipio, 'Pacatuba / CE')
  assert.equal(d.destinatario, null, 'sem grupo de destinatário: é o próprio tomador')
  assert.equal(d.intermediario, null)
})

test('serviço, ISSQN, tributação federal e totais formatados', () => {
  const d = dadosDanfse(fixture('fortaleza.xml'))
  assert.equal(d.servico.codigo, '14.01.01 / 060')
  assert.equal(d.servico.nbs, '1.2001.20.00')
  assert.equal(d.servico.local, 'Fortaleza / CE / BR')
  assert.match(d.servico.descricaoCodigo, /^REPARAÇÃO E MANUTENÇÃO DE COMPUTADORES/)
  assert.equal(d.issqn.tipo, 'Operação tributável')
  assert.equal(d.issqn.incidencia, 'Fortaleza / CE / BR')
  assert.equal(d.issqn.regimeEspecial, 'Nenhum')
  assert.equal(d.issqn.bc, 'R$ 150,00')
  assert.equal(d.issqn.aliquota, '5,00%')
  assert.equal(d.issqn.retencao, 'Não Retido')
  assert.equal(d.issqn.apurado, 'R$ 7,50')
  assert.equal(d.federal.irrf, '-')
  assert.equal(d.federal.pis, 'R$ 0,00')
  assert.equal(d.federal.imprimirPisCofins, true, 'competência até 2026')
  assert.equal(d.totais.servico, 'R$ 150,00')
  assert.equal(d.totais.retencoes, 'R$ 0,00')
  assert.equal(d.totais.liquido, 'R$ 150,00')
  assert.match(d.informacoes, /Totais Aproximados dos Tributos cfe\. Lei nº 12\.741\/2012: Federais: R\$ 0,00; Estaduais: R\$ 0,00; Municipais: R\$ 7,50/)
})

test('contribuições sociais retidas somam PIS e COFINS quando tpRetPisCofins = 1', () => {
  const xml = fixture('fortaleza.xml').replace(
    /<vPis>0\.00<\/vPis>\s*<vCofins>0\.00<\/vCofins>/,
    '<vPis>1.00</vPis><vCofins>4.00</vCofins><tpRetPisCofins>1</tpRetPisCofins>',
  ).replace(/<\/piscofins>/, '</piscofins><vRetCSLL>2.00</vRetCSLL>')
  const d = dadosDanfse(xml)
  assert.equal(d.federal.contribuicoesRetidas, 'R$ 7,00')
  assert.equal(d.federal.pis, 'R$ 0,00')
  assert.equal(d.federal.cofins, 'R$ 0,00')
  assert.equal(d.federal.descricaoRetidas, 'PIS/COFINS Retido')
})

test('PDF de uma página A4, com marca d’água quando cancelada', async () => {
  const pdf = await gerarDanfse(fixture('fortaleza.xml'), { comprimir: false })
  const texto = pdf.toString('latin1')
  assert.ok(texto.startsWith('%PDF-'))
  assert.equal((texto.match(/\/Type \/Page\b/g) || []).length, 1, 'uma página só')
  assert.match(texto, /\/MediaBox \[0 0 595\.28 841\.89\]/)
  assert.ok(textos(pdf).includes('DANFSe v2.0'))
  assert.ok(textos(pdf).includes('R$ 150,00'))
  assert.ok(!textos(pdf).includes('CANCELADA'))
  assert.ok(textos(await gerarDanfse(fixture('fortaleza.xml'), { situacao: 'cancelada', comprimir: false })).includes('CANCELADA'))
  assert.ok(textos(await gerarDanfse(fixture('nacional-sp.xml'), { situacao: 'substituida', comprimir: false })).includes('SUBSTITUÍDA'))
})

test('XML que não é NFS-e: erro claro', async () => {
  await assert.rejects(gerarDanfse('<nada/>'), /não é uma NFS-e/)
})
