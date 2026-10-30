'use strict'

// Pacote por cliente + competência para importar no Domínio e no Fortes:
//   exports/<CNPJ>_<apelido>_<AAAA-MM>.zip
//   ├─ NF-e/Entradas/<chave>-nfe.xml               notas recebidas, completas e não canceladas
//   ├─ NF-e/Entradas/Canceladas/<chave>-nfe.xml    notas recebidas, completas e canceladas
//   ├─ NF-e/Saidas/...                             notas emitidas pelo cliente (autXML), idem
//   ├─ NFS-e/Entradas/<chave>-nfse.xml             serviços tomados (e Canceladas/)
//   ├─ NFS-e/Saidas/<chave>-nfse.xml               serviços prestados (e Canceladas/)
//   └─ notas.xlsx                                  abas NF-e, NFS-e e Retenções com todas as notas da competência,
//                                                  inclusive as sem XML completo
//                                                  (pastas só existem quando têm notas)
// Com `modelo` ("Exportar mês" da NF-e ou da NFS-e) o pacote leva só aquele modelo, o nome ganha
// _NF-e ou _NFS-e e a planilha vem com as abas Entradas e Saídas.
// `incluir` escolhe o que vai no ZIP: 'xml' (XMLs e, na NFS-e, o DANFSe), 'excel' (notas.xlsx) e 'pdf' (relatorio.pdf).
// Padrão: os três com `modelo`; XMLs e planilha sem ele (pacote da tela Exportar).
//
// O layout de importação do Domínio e do Fortes ainda precisa ser confirmado com o escritório:
// toda a montagem do pacote fica neste arquivo, para ajustar sem mexer no resto.

const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')
const { criarArmazenamento, pastaDoCliente, pastaNoZip, nomeNoZip } = require('./armazenamento')
const { somenteDigitos } = require('./clientes')
const { montarPlanilhaDoMes } = require('./planilhaMes')
const { montarRelatorioPdf } = require('./relatorioPdf')
const { gerarDanfse, situacaoDanfse } = require('./danfse/gerar')

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
    tiposEvento: db.prepare('SELECT tp_evento FROM eventos WHERE chave = ?'),
    iniciarExecucao: db.prepare(`INSERT INTO execucoes (cliente_id, tipo, inicio) VALUES (?, 'exportacao', ?)`),
    fecharExecucao: db.prepare(`UPDATE execucoes SET fim = @fim, docs_recebidos = @docs, erro = @erro, x_motivo = @x_motivo WHERE id = @id`),
  }

  /**
   * Gera o ZIP do cliente na competência ('AAAA-MM'); com `modelo` ('nfe' | 'nfse'), só daquele modelo.
   * `incluir`: subconjunto de ['xml', 'excel', 'pdf'] (ver o topo do arquivo).
   * @returns {Promise<{ arquivo, nome, bytes, xmls, canceladas, semXml, totalNotas, avisos, porTipo }>}
   */
  async function exportar({ cnpj, competencia, modelo, incluir }) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || '')) throw new Error(`Competência inválida: ${competencia}. Use AAAA-MM.`)
    if (modelo && modelo !== 'nfe' && modelo !== 'nfse') throw new Error(`Modelo inválido: ${modelo}. Use nfe ou nfse.`)
    const partes = new Set(incluir ?? (modelo ? ['xml', 'excel', 'pdf'] : ['xml', 'excel']))
    if (!partes.size || [...partes].some((p) => !['xml', 'excel', 'pdf'].includes(p))) throw new Error('Conteúdo inválido: escolha xml, excel e/ou pdf.')
    const cliente = sql.cliente.get(somenteDigitos(cnpj))
    if (!cliente) throw new Error(`CNPJ ${somenteDigitos(cnpj)} não cadastrado.`)
    if (cliente.papel === 'escritorio' && !cliente.tambem_cliente) throw new Error(`CNPJ ${cliente.cnpj} é do escritório: exporte pelo CNPJ do cliente.`)

    const execId = sql.iniciarExecucao.run(cliente.id, iso()).lastInsertRowid
    try {
      const notas = sql.notas.all(cliente.id, competencia).filter((n) => !modelo || (n.modelo === 'nfse') === (modelo === 'nfse'))
      const arquivos = []
      const incluidas = []
      const avisos = []
      const porTipo = { entrada: { xmls: 0, canceladas: 0, semXml: 0 }, saida: { xmls: 0, canceladas: 0, semXml: 0 } }

      for (const n of notas) {
        const tipo = n.tipo === 'saida' ? 'saida' : 'entrada'
        if (n.status !== 'completa' && !n.cancelada) porTipo[tipo].semXml++
        if (!partes.has('xml') || n.status !== 'completa' || !n.caminho_xml) continue
        const caminho = armazenamento.absoluto(n.caminho_xml)
        if (!fs.existsSync(caminho)) {
          avisos.push(`XML da nota ${n.chave} não encontrado em ${caminho}.`)
          continue
        }
        porTipo[tipo][n.cancelada ? 'canceladas' : 'xmls']++
        const xml = fs.readFileSync(caminho)
        arquivos.push({ nome: `${pastaNoZip(n)}/${nomeNoZip(n)}`, conteudo: xml, data: agora() })
        // NFS-e: o DANFSe (PDF) vai junto, gerado do XML (a API oficial de geração foi desligada em 2026).
        if (n.modelo === 'nfse') {
          try {
            const pdf = await gerarDanfse(xml.toString('utf8'), { situacao: situacaoDanfse(n, sql.tiposEvento.all(n.chave).map((e) => e.tp_evento)) })
            arquivos.push({ nome: `${pastaNoZip(n)}/${nomeNoZip(n).replace(/.xml$/, '.pdf')}`, conteudo: pdf, data: agora() })
          } catch (e) {
            avisos.push(`PDF da NFS-e ${n.chave} não gerado: ${e.message}`)
          }
        }
        incluidas.push(n)
      }
      const lerXml = (n) => (n.caminho_xml && fs.existsSync(armazenamento.absoluto(n.caminho_xml)) ? fs.readFileSync(armazenamento.absoluto(n.caminho_xml), 'utf8') : null)
      if (partes.has('excel')) arquivos.push({ nome: 'notas.xlsx', conteudo: await montarPlanilhaDoMes({ notas, lerXml, modelo }), data: agora() })
      if (partes.has('pdf')) {
        const doCliente = { cnpj: cliente.cnpj, nome: cliente.apelido || cliente.razao_social }
        arquivos.push({ nome: 'relatorio.pdf', conteudo: await montarRelatorioPdf({ cliente: doCliente, competencia, notas, lerXml, modelo }), data: agora() })
      }

      fs.mkdirSync(config.pastaExports, { recursive: true })
      const sufixo = modelo ? `_${modelo === 'nfse' ? 'NFS-e' : 'NF-e'}` : ''
      const nome = `${pastaDoCliente(cliente)}_${competencia}${sufixo}.zip`
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
        // Mesma regra do `status`: nota cancelada não precisa de XML (mas aparece na planilha).
        semXml: soma('semXml'),
        totalNotas: notas.length,
        avisos,
        porTipo,
      }
      for (const a of avisos) logger.warn(a, { cnpj: cliente.cnpj })
      sql.fecharExecucao.run({ id: execId, fim: iso(), docs: incluidas.length, erro: null, x_motivo: `${nome} (${notas.length} notas na planilha)` })
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

module.exports = { criarServicoExportacao }
