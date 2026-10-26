'use strict'

// Pacote por cliente + competência para importar no Domínio e no Fortes:
//   exports/<CNPJ>_<apelido>_<AAAA-MM>.zip
//   ├─ entradas/xml/<chave>-nfe.xml         notas recebidas, completas e não canceladas
//   ├─ entradas/canceladas/<chave>-nfe.xml  notas recebidas, completas e canceladas
//   ├─ saidas/xml/<chave>-nfe.xml           notas emitidas pelo cliente (autXML), não canceladas
//   ├─ saidas/canceladas/<chave>-nfe.xml    notas emitidas pelo cliente, canceladas
//   └─ resumo.csv                           todas as notas da competência, inclusive as sem XML completo
//                                           (pastas só existem quando têm notas)
//
// O layout de importação do Domínio e do Fortes ainda precisa ser confirmado com o escritório:
// toda a montagem do pacote fica neste arquivo, para ajustar sem mexer no resto.

const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')
const { criarArmazenamento, pastaDoCliente, nomes } = require('./armazenamento')
const { somenteDigitos } = require('./clientes')

const COLUNAS_CSV = ['chave', 'tipo', 'numero', 'serie', 'data_emissao', 'emitente_cnpj', 'emitente_nome', 'destinatario_cnpj', 'destinatario_nome', 'valor_total', 'status', 'cancelada']

// ---------- CSV (Excel brasileiro: ';', vírgula decimal, UTF-8 com BOM) ----------

function celula(valor) {
  let s = valor === null || valor === undefined ? '' : String(valor)
  // Texto vindo de terceiros (nome do emitente) não pode virar fórmula no Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Números longos (chave, CNPJ) como texto: sem isso o Excel mostra 2,33E+43 e perde zeros à esquerda.
// Só dígitos entram na fórmula ="...": o valor vem do XML de terceiros.
const comoTexto = (s) => {
  const d = String(s ?? '').replace(/\D/g, '')
  return d ? `="${d}"` : ''
}

function dataBr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

const valorBr = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2).replace('.', ','))

function linhaCsv(n) {
  return [
    comoTexto(n.chave),
    celula(n.tipo),
    celula(n.numero),
    celula(n.serie),
    dataBr(n.data_emissao),
    comoTexto(n.emitente_cnpj),
    celula(n.emitente_nome),
    comoTexto(n.destinatario_cnpj),
    celula(n.destinatario_nome),
    valorBr(n.valor_total),
    celula(n.status),
    n.cancelada ? 'sim' : 'não',
  ].join(';')
}

function montarCsv(notas) {
  return '﻿' + [COLUNAS_CSV.join(';'), ...notas.map(linhaCsv)].join('\r\n') + '\r\n'
}

// ---------- ZIP ----------

function gravarZip(destino, arquivos) {
  return new Promise((resolve, reject) => {
    const tmp = `${destino}.${process.pid}.tmp`
    const saida = fs.createWriteStream(tmp)
    const zip = archiver('zip', { zlib: { level: 9 } })
    const falhar = (e) => {
      saida.destroy()
      fs.rmSync(tmp, { force: true })
      reject(e)
    }
    saida.on('close', () => {
      try {
        fs.renameSync(tmp, destino)
        resolve(zip.pointer())
      } catch (e) {
        falhar(e)
      }
    })
    saida.on('error', falhar)
    zip.on('error', falhar)
    zip.on('warning', falhar)
    zip.pipe(saida)
    for (const a of arquivos) zip.append(a.conteudo, { name: a.nome, date: a.data })
    zip.finalize()
  })
}

// ---------- serviço ----------

function criarServicoExportacao({ db, config, logger, agora = () => new Date() }) {
  const armazenamento = criarArmazenamento({ pastaXmls: config.pastaXmls })
  const iso = () => agora().toISOString()

  const sql = {
    cliente: db.prepare('SELECT * FROM clientes WHERE cnpj = ?'),
    notas: db.prepare(`SELECT * FROM notas WHERE cliente_id = ? AND competencia = ?
      ORDER BY data_emissao, emitente_cnpj, CAST(numero AS INTEGER)`),
    marcar: db.prepare('UPDATE notas SET exportada_em = ? WHERE id = ?'),
    iniciarExecucao: db.prepare(`INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'exportacao', ?)`),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, docs_recebidos = @docs, erro = @erro, x_motivo = @x_motivo WHERE id = @id`),
  }

  /**
   * Gera o ZIP do cliente na competência ('AAAA-MM').
   * @returns {Promise<{ arquivo, nome, bytes, xmls, canceladas, semXml, totalNotas, avisos, porTipo }>}
   */
  async function exportar({ cnpj, competencia }) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || '')) throw new Error(`Competência inválida: ${competencia}. Use AAAA-MM.`)
    const cliente = sql.cliente.get(somenteDigitos(cnpj))
    if (!cliente) throw new Error(`CNPJ ${somenteDigitos(cnpj)} não cadastrado.`)
    if (cliente.papel === 'escritorio') throw new Error(`CNPJ ${cliente.cnpj} é do escritório: exporte pelo CNPJ do cliente.`)

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    try {
      const notas = sql.notas.all(cliente.id, competencia)
      const arquivos = []
      const incluidas = []
      const avisos = []
      const porTipo = { entrada: { xmls: 0, canceladas: 0, semXml: 0 }, saida: { xmls: 0, canceladas: 0, semXml: 0 } }

      for (const n of notas) {
        const tipo = n.tipo === 'saida' ? 'saida' : 'entrada'
        if (n.status !== 'completa' && !n.cancelada) porTipo[tipo].semXml++
        if (n.status !== 'completa' || !n.caminho_xml) continue
        const caminho = armazenamento.absoluto(n.caminho_xml)
        if (!fs.existsSync(caminho)) {
          avisos.push(`XML da nota ${n.chave} não encontrado em ${caminho}.`)
          continue
        }
        const pasta = `${tipo === 'saida' ? 'saidas' : 'entradas'}/${n.cancelada ? 'canceladas' : 'xml'}`
        porTipo[tipo][n.cancelada ? 'canceladas' : 'xmls']++
        arquivos.push({ nome: `${pasta}/${nomes.nfe(n.chave)}`, conteudo: fs.readFileSync(caminho), data: agora() })
        incluidas.push(n)
      }
      arquivos.push({ nome: 'resumo.csv', conteudo: Buffer.from(montarCsv(notas), 'utf8'), data: agora() })

      fs.mkdirSync(config.pastaExports, { recursive: true })
      const nome = `${pastaDoCliente(cliente)}_${competencia}.zip`
      const destino = path.join(config.pastaExports, nome)
      const bytes = await gravarZip(destino, arquivos)

      const marcarTodas = db.transaction((lista, quando) => {
        for (const n of lista) sql.marcar.run(quando, n.id)
      })
      marcarTodas(incluidas, iso())

      const soma = (campo) => porTipo.entrada[campo] + porTipo.saida[campo]
      const resultado = {
        arquivo: destino,
        nome,
        bytes,
        xmls: soma('xmls'),
        canceladas: soma('canceladas'),
        // Mesma regra do `status`: nota cancelada não precisa de XML (mas aparece no CSV).
        semXml: soma('semXml'),
        totalNotas: notas.length,
        avisos,
        porTipo,
      }
      for (const a of avisos) logger.warn(a, { cnpj: cliente.cnpj })
      sql.fecharExecucao.run({ id: execId, fim: iso(), docs: incluidas.length, erro: null, x_motivo: `${nome} (${notas.length} notas no CSV)` })
      logger.info('Exportação gerada', { cnpj: cliente.cnpj, competencia, arquivo: nome, xmls: resultado.xmls, canceladas: resultado.canceladas, semXml: resultado.semXml })
      return resultado
    } catch (e) {
      sql.fecharExecucao.run({ id: execId, fim: iso(), docs: 0, erro: e.message, x_motivo: null })
      logger.error('Falha na exportação', { cnpj: cliente.cnpj, competencia, erro: e.message })
      throw e
    }
  }

  return { exportar }
}

module.exports = { criarServicoExportacao, montarCsv, COLUNAS_CSV }
