'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Grava os XMLs em <PASTA_XMLS>/<CNPJ>_<apelido>/[fora-da-carteira/]<AAAA>/<MM>/<NF-e|NFS-e>/<Entradas|Saidas>/[Eventos|Resumos/].
// O banco guarda o caminho relativo à PASTA_XMLS, para a pasta poder mudar de lugar.
// Só este módulo monta caminho de XML.

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
  resumo: (chave) => `${digitos(chave, 'sem-chave')}-resumo.xml`,
  evento: (chave, tpEvento, nSeq) => `${digitos(chave, 'sem-chave')}-evento-${digitos(tpEvento, '0')}-${digitos(nSeq, '1')}.xml`,
}

const PASTAS = {
  modelo: { nfe: 'NF-e', nfse: 'NFS-e' },
  direcao: { entrada: 'Entradas', saida: 'Saidas' },
  evento: 'Eventos',
  resumo: 'Resumos',
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

/** Caminho relativo do XML. categoria: 'nota' | 'evento' | 'resumo'; competencia: 'AAAA-MM' ou vazia. */
function caminhoDa({ cliente, modelo = 'nfe', direcao = 'entrada', competencia, categoria = 'nota', nomeArquivo, foraDaCarteira = false }) {
  const m = /^(\d{4})-(\d{2})$/.exec(competencia || '')
  const partes = [pastaDoCliente(cliente)]
  if (foraDaCarteira) partes.push(PASTAS.foraDaCarteira)
  partes.push(...(m ? [m[1], m[2]] : [PASTAS.semData]))
  partes.push(PASTAS.modelo[modelo] || PASTAS.modelo.nfe, PASTAS.direcao[direcao] || PASTAS.direcao.entrada)
  if (categoria === 'evento') partes.push(PASTAS.evento)
  if (categoria === 'resumo') partes.push(PASTAS.resumo)
  return path.join(...partes, nomeArquivo)
}

/** Pasta da nota dentro dos ZIPs (exportação e seleção): NF-e/Entradas, NFS-e/Saidas/Canceladas... */
function pastaNoZip(nota) {
  const modelo = PASTAS.modelo[nota.modelo] || PASTAS.modelo.nfe
  const direcao = nota.tipo === 'saida' ? PASTAS.direcao.saida : PASTAS.direcao.entrada
  return `${modelo}/${direcao}${nota.cancelada ? '/Canceladas' : ''}`
}

/** Nome do XML da nota dentro dos ZIPs. */
const nomeNoZip = (nota) => (nota.modelo === 'nfse' ? nomes.nfse(nota.chave) : nomes.nfe(nota.chave))

function comDeclaracao(xml) {
  const s = String(xml).replace(/^﻿/, '').trimStart()
  // O arquivo sempre sai em UTF-8: a declaração não pode dizer outra coisa (ex.: ISO-8859-1 vindo do ADN).
  if (s.startsWith('<?xml')) return s.replace(/^(<\?xml[^?]*?)encoding\s*=\s*["'][^"']*["']/, '$1encoding="UTF-8"')
  return `<?xml version="1.0" encoding="UTF-8"?>${s}`
}

function criarArmazenamento({ pastaXmls }) {
  /**
   * Grava o XML e devolve o caminho relativo à pasta de XMLs.
   * Escreve num temporário e renomeia, para nunca deixar arquivo pela metade.
   * Se o arquivo já existe com o mesmo conteúdo, não reescreve.
   */
  function salvar({ xml, ...onde }) {
    const relativo = caminhoDa(onde)
    const destino = path.join(pastaXmls, relativo)
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
    return path.join(pastaXmls, relativo)
  }

  return { salvar, absoluto }
}

module.exports = { criarArmazenamento, pastaDoCliente, nomes, slug, PASTAS, caminhoDa, direcaoPelaChave, modeloPelaChave, pastaNoZip, nomeNoZip }
