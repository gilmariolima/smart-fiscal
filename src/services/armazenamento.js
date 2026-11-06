'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Grava os XMLs em <PASTA_XMLS>/<Empresa>/[fora-da-carteira/]<AAAA>/<Mês>/<NF-e|NFS-e|CT-e>/XML/<Entradas|Saidas|Outros>/[Eventos|Resumos/]:
// a mesma ordem das telas e da exportação (empresa, ano, mês, tipo); o PDF fica ao lado, em PDF/ no lugar de XML/.
// O banco guarda o caminho relativo à PASTA_XMLS, para a pasta poder mudar de lugar.
// Só este módulo monta caminho de XML.

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const MAX_NOME_PASTA = 40

// Tira o que o Windows não aceita em nome de pasta; mantém acentos e espaços.
// Curto e cortado em palavra inteira: o Windows não extrai caminho com mais de 260 caracteres.
function nomeDePasta(texto) {
  const limpo = String(texto ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const curto = limpo.length > MAX_NOME_PASTA ? limpo.slice(0, MAX_NOME_PASTA + 1).replace(/\s+\S*$/, '').slice(0, MAX_NOME_PASTA) : limpo
  return curto.replace(/[. ]+$/, '')
}

// O apelido do escritório é interno: nele vale a razão social.
const nomeDoCliente = (c) => (c.papel === 'escritorio' ? c.razao_social : c.apelido || c.razao_social)

/** Pasta do cliente no disco. `outros`: os demais clientes; com o mesmo nome (o Windows não diferencia maiúscula), leva o CNPJ. */
function pastaDoClienteNoDisco(cliente, outros = []) {
  const nome = nomeDePasta(nomeDoCliente(cliente))
  if (!nome) return cliente.cnpj
  const repetido = outros.some((o) => o.cnpj !== cliente.cnpj && nomeDePasta(nomeDoCliente(o)).toLowerCase() === nome.toLowerCase())
  return repetido ? `${nome} ${cliente.cnpj}` : nome
}

/** Nome seguro para pasta: sem acento, só letras, números, '-' e '_'. */
function slug(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function pastaDoCliente(cliente) {
  const nome = slug(cliente.apelido || cliente.razao_social)
  return nome ? `${cliente.cnpj}_${nome}` : cliente.cnpj
}

// Só dígitos nos nomes: os valores vêm do XML e não podem virar caminho ('../').
const digitos = (v, padrao) => String(v ?? '').replace(/\D/g, '') || padrao

const nomes = {
  nfe: (chave) => `${digitos(chave, 'sem-chave')}-nfe.xml`,
  nfse: (chave) => `${digitos(chave, 'sem-chave')}-nfse.xml`,
  cte: (chave) => `${digitos(chave, 'sem-chave')}-cte.xml`,
  resumo: (chave) => `${digitos(chave, 'sem-chave')}-resumo.xml`,
  evento: (chave, tpEvento, nSeq) => `${digitos(chave, 'sem-chave')}-evento-${digitos(tpEvento, '0')}-${digitos(nSeq, '1')}.xml`,
}

const PASTAS = {
  modelo: { nfe: 'NF-e', nfse: 'NFS-e', cte: 'CT-e' },
  direcao: { entrada: 'Entradas', saida: 'Saidas', outro: 'Outros' },
  evento: 'Eventos',
  resumo: 'Resumos',
  xml: 'XML',
  pdf: 'PDF',
  // Subpasta do escritório para notas sem cliente cadastrado (nem emitente nem destinatário).
  foraDaCarteira: 'fora-da-carteira',
  semData: 'sem-data',
}

/** NFS-e tem chave de 50 dígitos; NF-e, de 44. */
const modeloPelaChave = (chave) => (String(chave || '').length === 50 ? 'nfse' : 'nfe')

/** Saída quando o CNPJ do emitente (NF-e) ou do prestador (NFS-e) na chave é o do cliente. */
function direcaoPelaChave(chave, cnpjCliente) {
  const c = String(chave || '')
  const emitente = modeloPelaChave(c) === 'nfse' ? c.slice(9, 23) : c.slice(6, 20)
  return emitente === cnpjCliente ? 'saida' : 'entrada'
}

/** Pasta do grupo (empresa, ano, mês e tipo): <Empresa>/[fora-da-carteira/]<AAAA>/<Mês>/<Tipo>; sem competência, sem-data. */
function pastaDoGrupo({ cliente, outrosClientes, competencia, modelo = 'nfe', foraDaCarteira = false }) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(competencia || '')
  const partes = [pastaDoClienteNoDisco(cliente, outrosClientes)]
  if (foraDaCarteira) partes.push(PASTAS.foraDaCarteira)
  partes.push(...(m ? [m[1], MESES[Number(m[2]) - 1]] : [PASTAS.semData]))
  partes.push(PASTAS.modelo[modelo] || PASTAS.modelo.nfe)
  return path.join(...partes)
}

/** Caminho do PDF que acompanha o XML da nota (PDF no lugar de XML). Resumo e evento não têm PDF. */
function caminhoDoPdf(caminhoXml) {
  const partes = String(caminhoXml).split(/[\\/]/)
  const i = partes.findIndex((p, k) => p === PASTAS.xml && Object.values(PASTAS.modelo).includes(partes[k - 1]))
  if (i < 0 || partes.slice(i + 1, -1).some((p) => p === PASTAS.evento || p === PASTAS.resumo)) return null
  partes[i] = PASTAS.pdf
  partes[partes.length - 1] = partes[partes.length - 1].replace(/\.xml$/i, '.pdf')
  return path.join(...partes)
}

/**
 * Caminho relativo do XML. categoria: 'nota' | 'evento' | 'resumo'; competencia: 'AAAA-MM' ou vazia.
 * `outrosClientes`: para dois clientes com o mesmo nome não caírem na mesma pasta.
 */
function caminhoDa({ cliente, outrosClientes, modelo = 'nfe', direcao = 'entrada', competencia, categoria = 'nota', nomeArquivo, foraDaCarteira = false }) {
  const partes = [pastaDoGrupo({ cliente, outrosClientes, competencia, modelo, foraDaCarteira })]
  partes.push(PASTAS.xml, PASTAS.direcao[direcao] || PASTAS.direcao.entrada)
  if (categoria === 'evento') partes.push(PASTAS.evento)
  if (categoria === 'resumo') partes.push(PASTAS.resumo)
  return path.join(...partes, nomeArquivo)
}

/** Pasta da nota dentro dos ZIPs (exportação e seleção): NF-e/Entradas, NFS-e/Saidas/Canceladas... */
function pastaNoZip(nota) {
  const modelo = PASTAS.modelo[nota.modelo] || PASTAS.modelo.nfe
  const direcao = PASTAS.direcao[nota.tipo] || PASTAS.direcao.entrada
  return `${modelo}/${direcao}${nota.cancelada ? '/Canceladas' : ''}`
}

/** Nome do XML da nota dentro dos ZIPs. */
const nomeNoZip = (nota) => (nomes[nota.modelo] || nomes.nfe)(nota.chave)

function comDeclaracao(xml) {
  const s = String(xml).replace(/^﻿/, '').trimStart()
  // O arquivo sempre sai em UTF-8: a declaração não pode dizer outra coisa (ex.: ISO-8859-1 vindo do ADN).
  if (s.startsWith('<?xml')) return s.replace(/^(<\?xml[^?]*?)encoding\s*=\s*["'][^"']*["']/, '$1encoding="UTF-8"')
  return `<?xml version="1.0" encoding="UTF-8"?>${s}`
}

/** Primeiro segmento do caminho_xml das notas do cliente: as pastas de empresa que o banco conhece para ele. */
function pastasDoClienteNoBanco(db, clienteId) {
  return db
    .prepare(`SELECT DISTINCT substr(r, 1, instr(r, '/') - 1) FROM (
        SELECT replace(caminho_xml, char(92), '/') r FROM notas WHERE cliente_id = ? AND caminho_xml IS NOT NULL
      ) WHERE instr(r, '/') > 0`)
    .pluck()
    .all(clienteId)
}

const chavePastaPendente = (clienteId) => `pasta_pendente:${clienteId}`

/** Pastas antigas do cliente onde ainda ficou XML (em `sistema`, uma por linha). */
function pastasPendentesDoCliente(db, clienteId) {
  const valor = db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(chavePastaPendente(clienteId))
  return valor ? valor.split('\n') : []
}

/**
 * @param {object} p
 * @param {object} [p.config] lê config.pastaXmls a cada uso: a troca pela tela Pastas vale na hora
 * @param {string} [p.pastaXmls] pasta fixa, sem config
 * @param {object} [p.db] com o banco, clientes de mesmo nome não caem na mesma pasta
 */
function criarArmazenamento({ config, pastaXmls, db }) {
  const pasta = () => (config ? config.pastaXmls : pastaXmls)
  const clientes = db?.prepare('SELECT cnpj, papel, apelido, razao_social FROM clientes')

  /**
   * Grava o XML e devolve o caminho relativo à pasta de XMLs.
   * Escreve num temporário e renomeia, para nunca deixar arquivo pela metade.
   * Se o arquivo já existe com o mesmo conteúdo, não reescreve.
   */
  function salvar({ xml, ...onde }) {
    const relativo = caminhoDa({ ...onde, outrosClientes: clientes?.all() })
    const destino = path.join(pasta(), relativo)
    const conteudo = comDeclaracao(xml)
    if (fs.existsSync(destino) && fs.readFileSync(destino, 'utf8') === conteudo) return relativo
    fs.mkdirSync(path.dirname(destino), { recursive: true })
    const tmp = `${destino}.${process.pid}.tmp`
    fs.writeFileSync(tmp, conteudo, 'utf8')
    fs.renameSync(tmp, destino)
    return relativo
  }

  /** Caminho absoluto a partir do relativo guardado no banco. */
  function absoluto(relativo) {
    return path.join(pasta(), relativo)
  }

  return { salvar, absoluto }
}

module.exports = { criarArmazenamento, pastaDoCliente, pastaDoClienteNoDisco, pastasDoClienteNoBanco, chavePastaPendente, pastasPendentesDoCliente, nomeDePasta, nomeDoCliente, MESES, nomes, slug, PASTAS, caminhoDa, pastaDoGrupo, caminhoDoPdf, direcaoPelaChave, modeloPelaChave, pastaNoZip, nomeNoZip }
