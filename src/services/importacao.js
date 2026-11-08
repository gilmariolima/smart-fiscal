'use strict'

// Importação de XMLs de NFS-e obtidos fora do app (Emissor Nacional, cliente, outro sistema).
// Grava como a captura de NFS-e grava, sem ADN e sem NSU: o dono é achado pelo CNPJ do XML.

const { unzipSync } = require('fflate')
const { XMLParser, XMLValidator } = require('fast-xml-parser')
const { criarArmazenamento, nomes } = require('./armazenamento')
const { decodificarXml, dadosNfse } = require('./extracaoNfse')

const CANCELAMENTOS = ['101101', '105102']
// Uma NFS-e tem poucos KB: o limite por arquivo barra o que não é nota, e o total segura ZIP que explode na memória.
const LIMITE_ARQUIVO = 5 * 1024 * 1024
const LIMITE_TOTAL = 300 * 1024 * 1024
const CHAVE_NFSE = /^\d{50}$/
const raiz = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true })
const termina = (nome, ext) => nome.toLowerCase().endsWith(ext)

function criarServicoImportacao({ db, config, logger, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ config, db })
  const limiteArquivo = config.importacaoLimiteArquivo || LIMITE_ARQUIVO
  const limiteTotal = config.importacaoLimiteTotal || LIMITE_TOTAL
  const sql = {
    // Só a carteira: o escritório entra quando também é cliente, como na captura e nas telas de notas.
    clientes: db.prepare("SELECT * FROM clientes WHERE papel = 'cliente' OR tambem_cliente = 1"),
    existe: db.prepare('SELECT 1 FROM notas WHERE cliente_id = ? AND chave = ?'),
    cancelada: db.prepare(`SELECT 1 FROM eventos WHERE chave = ? AND tp_evento IN (${CANCELAMENTOS.map((c) => `'${c}'`).join(',')}) LIMIT 1`),
    inserir: db.prepare(`INSERT INTO notas (cliente_id, chave, nsu, tipo, modelo, emitente_cnpj, emitente_nome, destinatario_cnpj, destinatario_nome,
        numero, data_emissao, valor_total, status, cancelada, caminho_xml, competencia, origem, atualizado_em, criado_em)
      VALUES (@cliente_id, @chave, NULL, @tipo, 'nfse', @emitente_cnpj, @emitente_nome, @destinatario_cnpj, @destinatario_nome,
        @numero, @data_emissao, @valor_total, 'completa', @cancelada, @caminho_xml, @competencia, 'importada', @agora, @agora)`),
  }

  // ZIPs viram a lista dos arquivos de dentro (sem as pastas); o nome mostra de qual ZIP veio.
  // Arquivo grande demais nem é descompactado; passando do total, o resto do ZIP fica de fora.
  function expandir(arquivos, ignoradas) {
    const lista = []
    let total = 0
    for (const { nome, bytes } of arquivos) {
      if (!termina(nome, '.zip')) {
        if (bytes.length > limiteArquivo) ignoradas.push({ nome, motivo: 'arquivo-grande' })
        else lista.push({ nome, bytes })
        continue
      }
      const recusados = []
      let conteudo
      try {
        conteudo = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), {
          filter: (f) => {
            if (f.name.endsWith('/')) return false
            if (f.originalSize > limiteArquivo) return recusados.push({ nome: `${nome}/${f.name}`, motivo: 'arquivo-grande' }) && false
            if (total + f.originalSize > limiteTotal) return recusados.push({ nome: `${nome}/${f.name}`, motivo: 'zip-grande-demais' }) && false
            total += f.originalSize
            return true
          },
        })
      } catch {
        ignoradas.push({ nome, motivo: 'zip-invalido' })
        continue
      }
      ignoradas.push(...recusados)
      for (const [dentro, dados] of Object.entries(conteudo)) {
        lista.push({ nome: `${nome}/${dentro}`, bytes: Buffer.from(dados.buffer, dados.byteOffset, dados.length) })
      }
    }
    return lista
  }

  // Lê o XML e devolve os dados da NFS-e ou o motivo de não servir.
  function ler({ nome, bytes }) {
    if (!termina(nome, '.xml')) return { motivo: 'nao-xml' }
    const texto = decodificarXml(bytes).replace(/^﻿/, '')
    if (XMLValidator.validate(texto) !== true) return { motivo: 'invalido' }
    if (!raiz.parse(texto)?.NFSe) return { motivo: 'nao-nfse' }
    const d = dadosNfse(texto)
    // A chave vira nome de arquivo e decide modelo e direção: só a de 50 dígitos do padrão nacional.
    return CHAVE_NFSE.test(d.chave || '') ? { d, xml: texto } : { motivo: 'invalido' }
  }

  // Quem fica com a nota: prestador (saída) e tomador (entrada); sem nenhum dos dois, o intermediário como entrada.
  function donos(d, porCnpj) {
    const lista = [
      [porCnpj.get(d.prestadorCnpj), 'saida'],
      [porCnpj.get(d.tomadorCnpj), 'entrada'],
    ].filter(([c]) => c)
    if (lista.length) return lista
    const intermediario = porCnpj.get(d.intermediarioCnpj)
    if (!intermediario) return []
    logger.warn('NFS-e em que o cliente é só intermediário: gravada como entrada', { cnpj: intermediario.cnpj, chave: d.chave })
    return [[intermediario, 'entrada']]
  }

  function importar(arquivos) {
    const r = { importadas: { entrada: 0, saida: 0 }, jaExistiam: 0, ignoradas: [], clientesAfetados: [] }
    const lista = expandir(arquivos, r.ignoradas)
    const porCnpj = new Map(sql.clientes.all().map((c) => [c.cnpj, c]))
    const afetados = new Set()
    const agoraIso = agora().toISOString()

    // Cada nota no seu ponto de salvamento: erro de disco numa não desfaz as outras.
    const gravarNota = db.transaction((cliente, tipo, d, xml) => {
      const caminho = armazenamento.salvar({ cliente, modelo: 'nfse', direcao: tipo, competencia: d.competencia, nomeArquivo: nomes.nfse(d.chave), xml })
      sql.inserir.run({
        cliente_id: cliente.id, chave: d.chave, tipo, emitente_cnpj: d.prestadorCnpj, emitente_nome: d.prestadorNome,
        destinatario_cnpj: d.tomadorCnpj, destinatario_nome: d.tomadorNome, numero: d.numero, data_emissao: d.dataEmissao,
        valor_total: d.valor, cancelada: sql.cancelada.get(d.chave) ? 1 : 0, caminho_xml: caminho, competencia: d.competencia, agora: agoraIso,
      })
    })

    const gravar = db.transaction(() => {
      for (const arquivo of lista) {
        const { d, xml, motivo } = ler(arquivo)
        if (motivo) {
          r.ignoradas.push({ nome: arquivo.nome, motivo })
          continue
        }
        const deQuem = donos(d, porCnpj)
        if (!deQuem.length) {
          r.ignoradas.push({ nome: arquivo.nome, motivo: 'cnpj-nao-cadastrado' })
          continue
        }
        for (const [cliente, tipo] of deQuem) {
          if (sql.existe.get(cliente.id, d.chave)) {
            r.jaExistiam++
            continue
          }
          try {
            gravarNota(cliente, tipo, d, xml)
          } catch (e) {
            logger.error('XML importado não gravado', { arquivo: arquivo.nome, chave: d.chave, erro: e.message })
            r.ignoradas.push({ nome: arquivo.nome, motivo: 'erro-gravacao' })
            continue
          }
          r.importadas[tipo]++
          afetados.add(cliente.id)
        }
      }
    })
    gravar()
    r.clientesAfetados = [...afetados]
    logger.info('Importação de XMLs', { importadas: r.importadas, jaExistiam: r.jaExistiam, ignoradas: r.ignoradas.length })
    return r
  }

  return { importar }
}

module.exports = { criarServicoImportacao }
