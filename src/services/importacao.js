'use strict'

// Importação de XMLs de NF-e, CT-e e NFS-e (e dos eventos) obtidos fora do app: emissor do cliente,
// e-mail de fornecedor, outro sistema, portal. Grava como a captura grava, sem NSU: o dono é achado pelo CNPJ.

const fs = require('node:fs')
const { unzipSync } = require('fflate')
const { criarArmazenamento, nomes, direcaoPelaChave } = require('./armazenamento')
const { competenciaDe } = require('./extracao')
const { lerDocumento, donos, nomeArquivo, CANCELAMENTOS } = require('./importacaoTipos')

// Uma nota tem poucos KB: o limite por arquivo barra o que não é nota, e o total segura ZIP que explode na memória.
const LIMITE_ARQUIVO = 5 * 1024 * 1024
const LIMITE_TOTAL = 300 * 1024 * 1024
const termina = (nome, ext) => nome.toLowerCase().endsWith(ext)
const lista = (v) => v.map((c) => `'${c}'`).join(',')

function criarServicoImportacao({ db, config, logger, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ config, db })
  const limiteArquivo = config.importacaoLimiteArquivo || LIMITE_ARQUIVO
  const limiteTotal = config.importacaoLimiteTotal || LIMITE_TOTAL
  const sql = {
    // Só a carteira: o escritório entra quando também é cliente, como na captura e nas telas de notas.
    clientes: db.prepare("SELECT * FROM clientes WHERE papel = 'cliente' OR tambem_cliente = 1"),
    escritorio: db.prepare("SELECT * FROM clientes WHERE papel = 'escritorio'"),
    nota: db.prepare('SELECT * FROM notas WHERE cliente_id = ? AND chave = ?'),
    primeiroDono: db.prepare('SELECT * FROM notas WHERE chave = ? ORDER BY id LIMIT 1'),
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
    cancelada: Object.fromEntries(Object.entries(CANCELAMENTOS).map(([m, c]) => [m, db.prepare(`SELECT 1 FROM eventos WHERE chave = ? AND tp_evento IN (${lista(c)}) LIMIT 1`)])),
    inserir: db.prepare(`INSERT INTO notas (cliente_id, chave, nsu, tipo, modelo, emitente_cnpj, emitente_nome, emitente_ie, destinatario_cnpj, destinatario_nome,
        numero, serie, data_emissao, valor_total, tipo_nf, status, cancelada, caminho_xml, competencia, origem, atualizado_em, criado_em)
      VALUES (@cliente_id, @chave, NULL, @tipo, @modelo, @emitente_cnpj, @emitente_nome, @emitente_ie, @destinatario_cnpj, @destinatario_nome,
        @numero, @serie, @data_emissao, @valor_total, @tipo_nf, 'completa', @cancelada, @caminho_xml, @competencia, 'importada', @agora, @agora)`),
    // Completa o resumo que já estava no banco; a origem fica a da linha (a captura).
    completar: db.prepare(`UPDATE notas SET tipo = @tipo, emitente_cnpj = @emitente_cnpj, emitente_nome = @emitente_nome, emitente_ie = @emitente_ie,
        destinatario_cnpj = @destinatario_cnpj, destinatario_nome = @destinatario_nome, numero = @numero, serie = @serie, data_emissao = @data_emissao,
        valor_total = @valor_total, tipo_nf = @tipo_nf, status = 'completa', cancelada = MAX(cancelada, @cancelada), caminho_xml = @caminho_xml,
        competencia = @competencia, atualizado_em = @agora
      WHERE cliente_id = @cliente_id AND chave = @chave`),
    evento: db.prepare('SELECT * FROM eventos WHERE chave = ? AND tp_evento = ? AND n_seq = ?'),
    atualizarEvento: db.prepare(`UPDATE eventos SET descricao = COALESCE(@descricao, descricao), data_evento = COALESCE(@data_evento, data_evento),
        protocolo = COALESCE(@protocolo, protocolo), caminho_xml = @caminho_xml WHERE id = @id`),
    inserirEvento: db.prepare(`INSERT INTO eventos (chave, tp_evento, n_seq, descricao, data_evento, protocolo, caminho_xml)
      VALUES (@chave, @tp_evento, @n_seq, @descricao, @data_evento, @protocolo, @caminho_xml)`),
    marcarCancelada: db.prepare('UPDATE notas SET cancelada = 1, atualizado_em = ? WHERE chave = ?'),
  }

  // ZIPs viram a lista dos arquivos de dentro (sem as pastas); o nome mostra de qual ZIP veio.
  // Arquivo grande demais nem é descompactado; passando do total, o resto do ZIP fica de fora.
  function expandir(arquivos, ignoradas) {
    const saida = []
    let total = 0
    for (const { nome, bytes } of arquivos) {
      if (!termina(nome, '.zip')) {
        if (bytes.length > limiteArquivo) ignoradas.push({ nome, motivo: 'arquivo-grande' })
        else saida.push({ nome, bytes })
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
        saida.push({ nome: `${nome}/${dentro}`, bytes: Buffer.from(dados.buffer, dados.byteOffset, dados.length) })
      }
    }
    return saida
  }

  /**
   * @param {{ nome: string, bytes: Buffer }[]} arquivos
   * @param {{ soDaCarteira?: boolean }} [opcoes] com soDaCarteira, nota sem dono não vai para Sem cliente cadastrado
   */
  function importar(arquivos, { soDaCarteira = false } = {}) {
    const r = {
      importadas: { nfe: { entrada: 0, saida: 0 }, cte: { entrada: 0, saida: 0, outro: 0 }, nfse: { entrada: 0, saida: 0 } },
      eventos: 0,
      semCliente: 0,
      jaExistiam: 0,
      ignoradas: [],
      clientesAfetados: [],
    }
    const arquivosLidos = expandir(arquivos, r.ignoradas)
    const porCnpj = new Map(sql.clientes.all().map((c) => [c.cnpj, c]))
    const escritorio = sql.escritorio.get()
    const afetados = new Set()
    const agoraIso = agora().toISOString()

    // Cada nota no seu ponto de salvamento: erro de disco numa não desfaz as outras.
    const gravarNota = db.transaction((cliente, direcao, modelo, d, xml, existente) => {
      const competencia = d.competencia || existente?.competencia
      const caminho = armazenamento.salvar({ cliente, modelo, direcao, competencia, nomeArquivo: nomeArquivo(modelo, d.chave), xml })
      const { partes, ...campos } = d
      const linha = { ...campos, competencia, cliente_id: cliente.id, tipo: direcao, modelo, caminho_xml: caminho, agora: agoraIso, cancelada: sql.cancelada[modelo].get(d.chave) ? 1 : 0 }
      if (existente) {
        sql.completar.run(linha)
        try {
          armazenamento.tirarResumo(caminho)
        } catch (e) {
          logger.warn('Resumo da nota importada não saiu da pasta', { chave: d.chave, erro: e.code || e.message })
        }
      } else {
        sql.inserir.run(linha)
      }
    })

    const gravarEvento = db.transaction((dono, modelo, e, xml) => {
      const nota = sql.nota.get(dono.id, e.chave)
      const caminho = armazenamento.salvar({
        cliente: dono,
        modelo,
        direcao: nota?.tipo || direcaoPelaChave(e.chave, dono.cnpj),
        competencia: nota?.competencia || competenciaDe(e.data_evento),
        categoria: 'evento',
        nomeArquivo: nomes.evento(e.chave, e.tp_evento, e.n_seq),
        xml,
      })
      // Evento já no banco sem o XML (ciência feita pelo app, resumo): ganha o arquivo.
      const existente = sql.evento.get(e.chave, e.tp_evento, e.n_seq)
      if (existente) sql.atualizarEvento.run({ ...e, caminho_xml: caminho, id: existente.id })
      else sql.inserirEvento.run({ ...e, caminho_xml: caminho })
      if (CANCELAMENTOS[modelo].includes(e.tp_evento)) sql.marcarCancelada.run(agoraIso, e.chave)
    })

    function temArquivo(relativo) {
      try {
        return !!relativo && fs.statSync(armazenamento.absoluto(relativo)).size > 0
      } catch {
        return false
      }
    }

    // Dono do evento: o primeiro cliente que tem a nota; sem ela, o emitente da chave (NF-e e CT-e).
    function donoDoEvento(modelo, chave) {
      const nota = sql.primeiroDono.get(chave)
      if (nota) return sql.cliente.get(nota.cliente_id)
      return modelo === 'nfse' ? null : porCnpj.get(chave.slice(6, 20)) || null
    }

    function processarNota(arquivo, modelo, d, xml) {
      const deQuem = donos(modelo, d, porCnpj)
      if (!deQuem.length) {
        if (!escritorio || soDaCarteira) return r.ignoradas.push({ nome: arquivo.nome, motivo: 'cnpj-nao-cadastrado' })
        try {
          armazenamento.salvar({ cliente: escritorio, foraDaCarteira: true, modelo, direcao: 'entrada', competencia: d.competencia, nomeArquivo: nomeArquivo(modelo, d.chave), xml })
          r.semCliente++
        } catch (e) {
          logger.error('XML importado sem cliente não gravado', { arquivo: arquivo.nome, chave: d.chave, erro: e.message })
          r.ignoradas.push({ nome: arquivo.nome, motivo: 'erro-gravacao' })
        }
        return
      }
      for (const [cliente, direcao] of deQuem) {
        const existente = sql.nota.get(cliente.id, d.chave)
        // Já existia só se o XML está mesmo no disco; linha completa sem o arquivo é regravada.
        if (existente?.status === 'completa' && temArquivo(existente.caminho_xml)) {
          r.jaExistiam++
          continue
        }
        try {
          gravarNota(cliente, direcao, modelo, d, xml, existente)
        } catch (e) {
          logger.error('XML importado não gravado', { arquivo: arquivo.nome, chave: d.chave, erro: e.message })
          r.ignoradas.push({ nome: arquivo.nome, motivo: 'erro-gravacao' })
          continue
        }
        r.importadas[modelo][direcao]++
        afetados.add(cliente.id)
      }
    }

    function processarEvento(arquivo, modelo, e, xml) {
      if (sql.evento.get(e.chave, e.tp_evento, e.n_seq)?.caminho_xml) return r.jaExistiam++
      const dono = donoDoEvento(modelo, e.chave)
      if (!dono) return r.ignoradas.push({ nome: arquivo.nome, motivo: 'cnpj-nao-cadastrado' })
      try {
        gravarEvento(dono, modelo, e, xml)
      } catch (err) {
        logger.error('Evento importado não gravado', { arquivo: arquivo.nome, chave: e.chave, erro: err.message })
        return r.ignoradas.push({ nome: arquivo.nome, motivo: 'erro-gravacao' })
      }
      r.eventos++
      afetados.add(dono.id)
    }

    const gravar = db.transaction(() => {
      for (const arquivo of arquivosLidos) {
        if (!termina(arquivo.nome, '.xml')) {
          r.ignoradas.push({ nome: arquivo.nome, motivo: 'nao-xml' })
          continue
        }
        const doc = lerDocumento(arquivo.bytes)
        if (doc.motivo) r.ignoradas.push({ nome: arquivo.nome, motivo: doc.motivo })
        else if (doc.tipo === 'nota') processarNota(arquivo, doc.modelo, doc.d, doc.xml)
        else processarEvento(arquivo, doc.modelo, doc.e, doc.xml)
      }
    })
    gravar()
    r.clientesAfetados = [...afetados]
    logger.info('Importação de XMLs', { importadas: r.importadas, eventos: r.eventos, semCliente: r.semCliente, jaExistiam: r.jaExistiam, ignoradas: r.ignoradas.length })
    return r
  }

  return { importar }
}

module.exports = { criarServicoImportacao }
