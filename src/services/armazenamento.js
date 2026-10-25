'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Grava os XMLs em <PASTA_XMLS>/<CNPJ>_<apelido>/[<subpasta>/]<AAAA-MM>/.
// O banco guarda o caminho relativo à PASTA_XMLS, para a pasta poder mudar de lugar.

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
  resumo: (chave) => `${digitos(chave, 'sem-chave')}-resumo.xml`,
  evento: (chave, tpEvento, nSeq) => `${digitos(chave, 'sem-chave')}-evento-${digitos(tpEvento, '0')}-${digitos(nSeq, '1')}.xml`,
  // Subpasta do escritório para notas sem cliente cadastrado (nem emitente nem destinatário).
  foraDaCarteira: 'fora-da-carteira',
}

function comDeclaracao(xml) {
  const s = String(xml).replace(/^﻿/, '').trimStart()
  return s.startsWith('<?xml') ? s : `<?xml version="1.0" encoding="UTF-8"?>${s}`
}

function criarArmazenamento({ pastaXmls }) {
  /**
   * Grava o XML e devolve o caminho relativo à pasta de XMLs.
   * Escreve num temporário e renomeia, para nunca deixar arquivo pela metade.
   * Se o arquivo já existe com o mesmo conteúdo, não reescreve.
   */
  function salvar({ cliente, competencia, nomeArquivo, xml, subpasta }) {
    const relativo = path.join(pastaDoCliente(cliente), subpasta || '', competencia || 'sem-data', nomeArquivo)
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

module.exports = { criarArmazenamento, pastaDoCliente, nomes, slug }
