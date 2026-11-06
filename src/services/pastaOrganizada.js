'use strict'

// Pasta organizada: mantém em disco o relatório e o Excel de cada grupo (empresa, mês, tipo).
// Os grupos guardam a assinatura da última geração; só os que mudaram desde então ficam pendentes.

const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')
const { criarArmazenamento, pastaDoClienteNoDisco, pastasDoClienteNoBanco, pastasPendentesDoCliente, pastaDoGrupo, caminhoDoPdf, nomeDoCliente, MESES, PASTAS } = require('./armazenamento')
const { migrarLayouts, VERSAO_XML } = require('./migracaoPastas')
const { pdfsDasNotas } = require('./pdfNota')
const { montarPlanilhaDoMes } = require('./planilhaMes')
const { montarRelatorioPdf } = require('./relatorioPdf')

// Notas da carteira com competência. Fora da carteira: o caminho do XML passa por `fora-da-carteira` (com / ou \).
// Resumos ainda sem XML (caminho nulo) entram.
const DO_GRUPO = `n.competencia IS NOT NULL
  AND (c.papel = 'cliente' OR c.tambem_cliente = 1)
  AND (n.caminho_xml IS NULL OR instr(replace(n.caminho_xml, char(92), '/'), 'fora-da-carteira') = 0)`

const chaveDe = (clienteId, competencia, modelo) => `${clienteId}|${competencia}|${modelo}`

function criarGrupos({ db, agora = () => new Date() }) {
  const clientes = db.prepare('SELECT id, cnpj, papel, apelido, razao_social FROM clientes')
  const notas = db.prepare(`SELECT n.cliente_id clienteId, n.competencia, n.modelo, COUNT(*) total, MAX(n.atualizado_em) atualizado, SUM(n.cancelada) canceladas
    FROM notas n JOIN clientes c ON c.id = n.cliente_id
    WHERE ${DO_GRUPO}
    GROUP BY n.cliente_id, n.competencia, n.modelo`)
  // Uma consulta para todos os grupos: eventos achados pela chave (índice de eventos) e somados por grupo.
  const eventos = db.prepare(`SELECT n.cliente_id clienteId, n.competencia, n.modelo, COUNT(*) total
    FROM notas n JOIN clientes c ON c.id = n.cliente_id JOIN eventos e ON e.chave = n.chave
    WHERE ${DO_GRUPO}
    GROUP BY n.cliente_id, n.competencia, n.modelo`)
  const gravados = db.prepare('SELECT cliente_id clienteId, competencia, modelo, assinatura, eventos FROM pasta_grupos')
  const gravar = db.prepare(`INSERT INTO pasta_grupos (cliente_id, competencia, modelo, assinatura, eventos, gerado_em)
    VALUES (@clienteId, @competencia, @modelo, @assinatura, @eventos, @geradoEm)
    ON CONFLICT (cliente_id, competencia, modelo) DO UPDATE SET assinatura = excluded.assinatura, eventos = excluded.eventos, gerado_em = excluded.gerado_em`)

  /**
   * Grupos novos ou mudados desde a última geração, do mês mais recente para o mais antigo.
   * `eventos`: eventos do grupo agora; `eventosAntes`: na última geração (null se nunca gerado).
   * @returns {Array<{ clienteId: number, competencia: string, modelo: string, assinatura: string, eventos: number, eventosAntes: number | null }>}
   */
  function pendentes() {
    const todos = clientes.all()
    const porId = new Map(todos.map((c) => [c.id, c]))
    const nomes = new Map()
    const pasta = (id) => {
      if (!nomes.has(id)) nomes.set(id, pastaDoClienteNoDisco(porId.get(id), todos))
      return nomes.get(id)
    }
    const qtdEventos = new Map(eventos.all().map((l) => [chaveDe(l.clienteId, l.competencia, l.modelo), l.total]))
    const antes = new Map(gravados.all().map((l) => [chaveDe(l.clienteId, l.competencia, l.modelo), l]))

    const lista = []
    for (const l of notas.all()) {
      const k = chaveDe(l.clienteId, l.competencia, l.modelo)
      const qtd = qtdEventos.get(k) || 0
      const assinatura = [pasta(l.clienteId), l.total, l.atualizado ?? '', l.canceladas ?? 0, qtd].join('|')
      const anterior = antes.get(k)
      if (anterior && anterior.assinatura === assinatura) continue
      lista.push({ clienteId: l.clienteId, competencia: l.competencia, modelo: l.modelo, assinatura, eventos: qtd, eventosAntes: anterior ? anterior.eventos : null })
    }
    return lista.sort((a, b) => b.competencia.localeCompare(a.competencia) || a.clienteId - b.clienteId || a.modelo.localeCompare(b.modelo))
  }

  /** Grava a assinatura do grupo como gerada. */
  function marcarPronto({ clienteId, competencia, modelo, assinatura, eventos }) {
    if (eventos === undefined) throw new Error('marcarPronto precisa de eventos.')
    gravar.run({ clienteId, competencia, modelo, assinatura, eventos, geradoEm: agora().toISOString() })
  }

  return { pendentes, marcarPronto }
}

const cederAVez = () => new Promise((resolve) => setImmediate(resolve))
const ESPERA_SEM_AVANCO_MS = 3600e3
// Caminho para comparar: sem diferenciar maiúsculas, como o Windows, e com uma barra só.
const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
const EM_EVENTOS_OU_RESUMOS = new RegExp(`[\\\\/](${PASTAS.evento}|${PASTAS.resumo})[\\\\/]`)
const NOME_DE_RESUMO = /^(\d+)-resumo\.xml$/i
const ehTmp = (nome) => nome.toLowerCase().endsWith('.tmp')
const apagar = (arquivo) => fs.promises.rm(arquivo, { force: true })

/** Arquivos (caminhos absolutos) de uma pasta e das subpastas; pasta que não existe não tem arquivos. */
function arquivosDe(pasta, { pular = [] } = {}) {
  let itens
  try {
    itens = fs.readdirSync(pasta, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  return itens.flatMap((i) => {
    const caminho = path.join(pasta, i.name)
    if (i.isDirectory()) return pular.includes(i.name) ? [] : arquivosDe(caminho, { pular })
    return [caminho]
  })
}

/** Pasta do grupo (relativa à raiz) e nomes dos relatórios e do ZIP: um só lugar para quem gera e quem confere. */
function nomesDoGrupo({ cliente, todos, competencia, modelo }) {
  const [ano, mes] = competencia.split('-')
  const sufixo = `${PASTAS.modelo[modelo]} ${MESES[Number(mes) - 1]} ${ano}`
  const relativa = pastaDoGrupo({ cliente, outrosClientes: todos, competencia, modelo })
  const empresa = relativa.split(path.sep)[0]
  return { relativa, empresa, relatorios: [`Relatorio ${sufixo}.xlsx`, `Relatorio ${sufixo}.pdf`], zip: `${empresa} ${sufixo}.zip` }
}

// `atualizado_em` do SQLite é UTC, sem fuso.
const emMs = (data) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(data) ? data : `${data.replace(' ', 'T')}Z`)

/**
 * Gera em disco os arquivos de um grupo: PDFs, relatórios (xlsx e pdf) e ZIP.
 * `gravar(destino, Buffer)` e `renomear(de, para)` podem ser trocados nos testes para simular arquivo travado.
 */
function criarGerador({ db, config, logger, renomear = fs.promises.rename, gravar, reconciliarPasta }) {
  const armazenamento = criarArmazenamento({ config, db })
  const clientes = db.prepare('SELECT id, cnpj, papel, apelido, razao_social FROM clientes')
  const notasDoGrupo = db.prepare(`SELECT * FROM notas WHERE cliente_id = ? AND competencia = ? AND modelo = ? AND status = 'completa' AND caminho_xml IS NOT NULL
    AND instr(replace(caminho_xml, char(92), '/'), 'fora-da-carteira') = 0 ORDER BY data_emissao, chave`)
  const notasDoCliente = db.prepare('SELECT caminho_xml FROM notas WHERE cliente_id = ? AND caminho_xml IS NOT NULL').pluck()
  const eventosDoCliente = db.prepare('SELECT DISTINCT e.caminho_xml FROM eventos e JOIN notas n ON n.chave = e.chave WHERE n.cliente_id = ? AND e.caminho_xml IS NOT NULL').pluck()
  const chavesDoCliente = db.prepare('SELECT chave FROM notas WHERE cliente_id = ?').pluck()
  const tiposEvento = db.prepare('SELECT tp_evento FROM eventos WHERE chave = ?')
  const pdfs = pdfsDasNotas((c) => tiposEvento.all(c).map((e) => e.tp_evento))

  // Temporário na mesma pasta e rename: ninguém lê um arquivo pela metade.
  const gravarPadrao = async (destino, conteudo) => {
    const tmp = `${destino}.${process.pid}.tmp`
    try {
      await fs.promises.writeFile(tmp, conteudo)
      await renomear(tmp, destino)
    } catch (e) {
      await apagar(tmp).catch(() => {})
      throw e
    }
  }
  const gravarArquivo = gravar || gravarPadrao

  // XML ausente vira null. Os relatórios engolem qualquer erro do leitor (XML malformado vira linha em branco);
  // por isso o erro de E/S é guardado e relançado depois de montar.
  let falhaDeLeitura = null
  const lerXml = (n) => {
    try {
      return fs.readFileSync(armazenamento.absoluto(n.caminho_xml), 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') falhaDeLeitura ??= e
      return null
    }
  }

  // ZIP por stream: pode ter milhares de arquivos. Qualquer erro ou aviso do archiver (arquivo sumido ou ilegível) rejeita.
  async function gravarZip(destino, arquivos, avisos) {
    const tmp = `${destino}.${process.pid}.tmp`
    const saida = fs.createWriteStream(tmp)
    const fechou = new Promise((resolve) => saida.once('close', resolve))
    const zip = archiver('zip', { zlib: { level: 6 } })
    try {
      await new Promise((resolve, reject) => {
        saida.on('error', reject)
        zip.on('error', reject)
        zip.on('warning', reject)
        saida.on('close', resolve)
        zip.pipe(saida)
        for (const a of arquivos) zip.file(a.caminho, { name: a.nome })
        if (avisos.length) zip.append(Buffer.from(avisos.join('\r\n') + '\r\n', 'utf8'), { name: 'avisos.txt' })
        zip.finalize()
      })
      await renomear(tmp, destino)
    } catch (e) {
      zip.abort()
      saida.destroy()
      await fechou
      await apagar(tmp).catch(() => {})
      throw e
    }
  }

  // Pasta das notas diferente da calculada, ou XML que ficou na pasta antiga, daria ZIP sem XML e PDF: tenta mover de novo; se não der, o grupo fica pendente.
  function exigirPastaDaEmpresa(cliente, empresa) {
    const foraDoLugar = () => [...pastasDoClienteNoBanco(db, cliente.id).filter((p) => p.toLowerCase() !== empresa.toLowerCase()), ...pastasPendentesDoCliente(db, cliente.id)]
    const problemas = foraDoLugar().length && reconciliarPasta ? reconciliarPasta(cliente) || [] : []
    if (problemas.length) throw new Error(problemas.join(' '))
    const fora = foraDoLugar()
    const outra = fora.find((p) => p.toLowerCase() !== empresa.toLowerCase())
    if (outra) throw new Error(`A pasta da empresa está como "${outra}" e deveria ser "${empresa}". Feche os arquivos abertos dessa pasta; o Smart Fiscal tenta de novo na próxima captura.`)
    if (fora.length) throw new Error(pendenciaNaPropriaPasta(cliente, empresa))
  }

  // A pendência da própria pasta só é resolvida com as pastas no formato atual: antes disso, ela espera a organização.
  function pendenciaNaPropriaPasta(cliente, empresa) {
    const conhecidos = new Set([...notasDoCliente.all(cliente.id), ...eventosDoCliente.all(cliente.id)].map(norm))
    const xmls = arquivosDe(path.join(config.pastaXmls, empresa))
      .filter((a) => a.toLowerCase().endsWith('.xml'))
      .map((a) => path.relative(config.pastaXmls, a))
    const pendente = xmls.find((rel) => !conhecidos.has(norm(rel))) ?? xmls[0]
    const arquivo = pendente ? `, com o arquivo "${path.basename(pendente)}"` : ''
    return `A pasta da empresa "${empresa}" tem uma pendência${arquivo}: a organização das pastas ainda não terminou. O Smart Fiscal tenta de novo na próxima captura.`
  }

  /**
   * Refaz os arquivos do grupo. Rejeita se um arquivo não puder ser trocado ou a pasta estiver indisponível: o grupo segue pendente.
   * @returns {Promise<{ parou: boolean, avisos: string[] }>}
   */
  async function gerarGrupo(grupo, { eventosMudaram = false, deveParar = () => false } = {}) {
    const raiz = config.pastaXmls
    // Sem isto, o mkdir recursivo recriaria uma pasta base que sumiu (disco ou rede fora do ar).
    await fs.promises.stat(raiz)

    const todos = clientes.all()
    const cliente = todos.find((c) => c.id === grupo.clienteId)
    if (!cliente) throw new Error(`Cliente ${grupo.clienteId} não encontrado.`)
    const { relativa, empresa, relatorios: [nomeXlsx, nomePdf], zip: nomeZip } = nomesDoGrupo({ cliente, todos, competencia: grupo.competencia, modelo: grupo.modelo })
    exigirPastaDaEmpresa(cliente, empresa)
    const pasta = path.join(raiz, relativa)
    const pastaPdf = path.join(pasta, PASTAS.pdf)
    const avisos = []
    falhaDeLeitura = null

    // Restos de uma geração interrompida. O XML nunca é tocado.
    for (const a of arquivosDe(pasta, { pular: [PASTAS.xml] })) if (ehTmp(a)) await apagar(a)

    const notas = notasDoGrupo.all(grupo.clienteId, grupo.competencia, grupo.modelo)
    // Sem isto, o grupo ficaria pronto sem os PDFs.
    const antiga = notas.find((n) => !caminhoDoPdf(n.caminho_xml) && !EM_EVENTOS_OU_RESUMOS.test(n.caminho_xml))
    if (antiga) throw new Error(`A nota ${antiga.chave} ainda está no formato antigo de pastas (${antiga.caminho_xml}). O mês fica pendente até a organização terminar.`)

    // 1. PDFs
    for (const n of notas) {
      if (deveParar()) return { parou: true, avisos }
      await cederAVez()
      const relativoPdf = caminhoDoPdf(n.caminho_xml)
      if (!relativoPdf) continue
      const destino = armazenamento.absoluto(relativoPdf)
      let existente = null
      try {
        existente = fs.statSync(destino)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      const maisAntigo = existente && n.atualizado_em && emMs(n.atualizado_em) > existente.mtimeMs
      const comEvento = eventosMudaram && tiposEvento.get(n.chave)
      if (existente && !maisAntigo && !comEvento) continue
      const xml = lerXml(n)
      if (falhaDeLeitura) throw falhaDeLeitura
      if (xml === null) {
        avisos.push(`Nota ${n.chave}: XML não encontrado no disco.`)
        continue
      }
      const pdf = pdfs.find((p) => p.doModelo(n))
      let conteudo
      try {
        conteudo = await pdf.gerar(xml, n)
      } catch (e) {
        avisos.push(`${pdf.rotulo} da nota ${n.chave} não gerado: ${e.message}`)
        logger?.warn?.('PDF da nota não gerado', { chave: n.chave, erro: e.message })
        continue
      }
      await fs.promises.mkdir(path.dirname(destino), { recursive: true })
      await gravarArquivo(destino, conteudo)
    }

    // 2. PDFs órfãos: só é órfão o PDF que nenhuma nota do cliente justifica (inclui notas de outra competência) e sem XML ao lado.
    const relativoAoGrupo = (a) => norm(path.relative(raiz, a))
    const caminhosDasNotas = notasDoCliente.all(grupo.clienteId)
    const justificados = new Set()
    for (const c of caminhosDasNotas) {
      const pdf = caminhoDoPdf(c)
      if (pdf) justificados.add(norm(pdf))
    }
    const xmlAoLado = (pdf) => path.join(pasta, PASTAS.xml, path.relative(pastaPdf, pdf)).replace(/\.pdf$/i, '.xml')
    for (const a of arquivosDe(pastaPdf)) {
      if (a.toLowerCase().endsWith('.pdf') && !justificados.has(relativoAoGrupo(a)) && !fs.existsSync(xmlAoLado(a))) await apagar(a)
    }

    // 3. Relatórios
    if (deveParar()) return { parou: true, avisos }
    const esperados = []
    if (notas.length) {
      const relatorios = [
        [nomeXlsx, () => montarPlanilhaDoMes({ notas, lerXml, modelo: grupo.modelo })],
        [nomePdf, () => montarRelatorioPdf({ cliente: { cnpj: cliente.cnpj, nome: nomeDoCliente(cliente) }, competencia: grupo.competencia, notas, lerXml, modelo: grupo.modelo })],
      ]
      for (const [nome, montar] of relatorios) {
        // Qualquer falha rejeita o grupo: os arquivos antigos ficam como estão e o grupo segue pendente.
        const conteudo = await montar()
        if (falhaDeLeitura) throw falhaDeLeitura
        await fs.promises.mkdir(pasta, { recursive: true })
        await gravarArquivo(path.join(pasta, nome), conteudo)
        esperados.push(nome)
      }
    }
    if (deveParar()) return { parou: true, avisos }

    // 4. ZIP: só o que é do cliente, com caminhos relativos à pasta do grupo. A pasta pode ter arquivos de uma empresa excluída de mesmo nome.
    const conhecidos = new Set([...caminhosDasNotas, ...eventosDoCliente.all(grupo.clienteId)].map(norm))
    const chaves = new Set(chavesDoCliente.all(grupo.clienteId))
    const xmlDoCliente = (a) => conhecidos.has(relativoAoGrupo(a)) || chaves.has(NOME_DE_RESUMO.exec(path.basename(a))?.[1])
    const candidatos = [...arquivosDe(path.join(pasta, PASTAS.xml)), ...arquivosDe(pastaPdf)].filter((a) => !ehTmp(a))
    const desconhecidos = []
    const doCliente = candidatos.filter((a) => {
      const ok = a.startsWith(pastaPdf + path.sep) ? justificados.has(relativoAoGrupo(a)) : xmlDoCliente(a)
      if (!ok) desconhecidos.push(path.relative(raiz, a))
      return ok
    })
    if (desconhecidos.length) logger?.warn?.('Arquivos fora do ZIP: não são de nenhuma nota do cliente', { pasta: relativa, arquivos: desconhecidos })
    const noZip = [...doCliente, ...esperados.map((nome) => path.join(pasta, nome))]
      .sort()
      .map((a) => ({ caminho: a, nome: path.relative(pasta, a).split(path.sep).join('/') }))
    if (noZip.length) {
      await gravarZip(path.join(pasta, nomeZip), noZip, avisos)
      esperados.push(nomeZip)
    }

    // 5. Nomes antigos (empresa renomeada), só depois de gravar os novos.
    let itens = []
    try {
      itens = fs.readdirSync(pasta, { withFileTypes: true })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const i of itens) {
      if (!i.isFile() || esperados.includes(i.name)) continue
      if (/^Relatorio .*\.(xlsx|pdf)$/i.test(i.name) || /\.zip$/i.test(i.name)) await apagar(path.join(pasta, i.name))
    }
    return { parou: false, avisos }
  }

  return { gerarGrupo }
}

/**
 * Passadas em segundo plano: gera os grupos pendentes, uma passada por vez.
 * `pastas.temPasta()` falso: não faz nada. Nunca lança: erros vão para o log.
 */
function criarOrganizador({ db, config, logger, pastas, gravar, renomear, reconciliarPasta, fsOpsMigracao, capturaEmAndamento = () => null, agora = () => Date.now() }) {
  const grupos = criarGrupos({ db })
  const gerador = criarGerador({ db, config, logger, reconciliarPasta, ...(gravar && { gravar }), ...(renomear && { renomear }) })
  const versaoDoLayout = db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck()
  const clientes = db.prepare('SELECT id, cnpj, papel, apelido, razao_social FROM clientes')
  const gravados = db.prepare('SELECT cliente_id clienteId, competencia, modelo FROM pasta_grupos')
  const apagarGrupo = db.prepare('DELETE FROM pasta_grupos WHERE cliente_id = ? AND competencia = ? AND modelo = ?')
  const apagarDoCliente = db.prepare('DELETE FROM pasta_grupos WHERE cliente_id = ?')
  const contagens = db.prepare(`SELECT n.cliente_id clienteId, n.competencia, n.modelo, SUM(n.status = 'completa') completas, SUM(n.caminho_xml IS NOT NULL) comXml
    FROM notas n JOIN clientes c ON c.id = n.cliente_id
    WHERE ${DO_GRUPO}
    GROUP BY n.cliente_id, n.competencia, n.modelo`)

  let emCurso = null
  let pedido = false
  let conferirPedido = false
  let parado = false
  let pausas = 0
  let fila = Promise.resolve() // uma `fn` de pausarDurante por vez
  let avisouIndisponivel = false
  let ultimaMigracao = null // { pasta, pendentes, resultado, proximaEm }: em memória, abrir o app tenta de novo
  let estado = { situacao: 'parada', feitos: 0, total: 0, atual: null, falhas: 0, ultimoErro: null }

  const deveParar = () => parado || pausas > 0
  const existe = (caminho) => fs.promises.stat(caminho).then(() => true, () => false)

  /** Grupos gravados cujo relatório ou ZIP sumiu da pasta voltam a ficar pendentes. */
  async function conferir() {
    if (!(await existe(config.pastaXmls))) return
    const todos = clientes.all()
    const contados = new Map(contagens.all().map((l) => [chaveDe(l.clienteId, l.competencia, l.modelo), l]))
    const lista = gravados.all()
    estado = { situacao: 'conferindo', feitos: 0, total: lista.length, atual: null, falhas: 0, ultimoErro: null }
    try {
      await conferirGrupos(lista, todos, contados)
    } finally {
      estado.situacao = 'parada'
    }
  }

  async function conferirGrupos(lista, todos, contados) {
    for (const g of lista) {
      if (deveParar()) return
      await cederAVez()
      estado.feitos++
      const cliente = todos.find((c) => c.id === g.clienteId)
      const c = contados.get(chaveDe(g.clienteId, g.competencia, g.modelo))
      if (!cliente || !c) continue
      const { relativa, relatorios, zip } = nomesDoGrupo({ cliente, todos, competencia: g.competencia, modelo: g.modelo })
      let nomes
      try {
        nomes = new Set(await fs.promises.readdir(path.join(config.pastaXmls, relativa)))
      } catch (e) {
        if (e.code !== 'ENOENT') continue
        nomes = new Set()
      }
      const esperados = []
      if (c.completas) esperados.push(...relatorios)
      if (c.completas || c.comXml) esperados.push(zip)
      if (esperados.some((nome) => !nomes.has(nome))) {
        // Raiz fora do ar também faz faltar tudo: sem ela, nada volta a ficar pendente.
        if (!(await existe(config.pastaXmls))) return
        apagarGrupo.run(g.clienteId, g.competencia, g.modelo)
      }
    }
  }

  function ficouIndisponivel() {
    if (!avisouIndisponivel) logger.warn('Pasta indisponível: a organização para até a próxima captura', { pasta: config.pastaXmls })
    avisouIndisponivel = true
    estado.situacao = 'indisponivel'
    estado.atual = null
    return { mudou: false }
  }

  // Migração que não terminou ao abrir (pasta fora do ar, XML travado): tenta de novo, nunca durante uma captura.
  // Roda síncrona e trava o painel: tentativa que não avançou não se repete por 1 hora.
  async function retomarMigracao() {
    if (versaoDoLayout.get() === VERSAO_XML) return true
    if (!(await existe(config.pastaXmls))) return false
    if (capturaEmAndamento()) return true
    // A tentativa anterior só vale para a mesma pasta: outra pasta tenta na hora.
    const anterior = ultimaMigracao?.pasta === config.pastaXmls ? ultimaMigracao : null
    if (anterior && agora() < anterior.proximaEm) return true
    const r = migrarLayouts({ db, pastaXmls: config.pastaXmls, logger, fsOps: fsOpsMigracao })
    const resultado = JSON.stringify([r.movidos, r.pendentes, r.erros])
    const semAvanco = anterior && !r.movidos && r.pendentes === anterior.pendentes
    if (resultado !== anterior?.resultado) {
      const nivel = r.pendentes || r.erros.length ? 'warn' : 'info'
      logger[nivel]('Migração retomada', { movidos: r.movidos, pendentes: r.pendentes, erros: r.erros })
    }
    ultimaMigracao = { pasta: config.pastaXmls, pendentes: r.pendentes, resultado, proximaEm: semAvanco ? agora() + ESPERA_SEM_AVANCO_MS : 0 }
    return true
  }

  async function passada() {
    // Raiz de volta: o próximo apagão volta a avisar, mesmo sem grupos pendentes.
    if (avisouIndisponivel && (await existe(config.pastaXmls))) avisouIndisponivel = false
    if (!(await retomarMigracao())) {
      estado = { situacao: 'indisponivel', feitos: 0, total: 0, atual: null, falhas: 0, ultimoErro: null }
      return ficouIndisponivel()
    }
    const lista = grupos.pendentes()
    estado = { situacao: 'organizando', feitos: 0, total: lista.length, atual: null, falhas: 0, ultimoErro: null }
    const todos = clientes.all()
    const falhos = new Set()
    for (const grupo of lista) {
      if (deveParar()) break
      await cederAVez()
      if (deveParar()) break
      const cliente = todos.find((c) => c.id === grupo.clienteId)
      estado.atual = cliente ? nomeDoCliente(cliente) : null
      try {
        const r = await gerador.gerarGrupo(grupo, { eventosMudaram: grupo.eventos !== (grupo.eventosAntes ?? 0), deveParar })
        if (r.parou) break
        for (const aviso of r.avisos) logger.warn('Aviso na pasta organizada', { aviso })
        // Raiz fora do ar neste ponto: os arquivos podem não ter ficado lá.
        if (!(await existe(config.pastaXmls))) throw new Error('Pasta indisponível.')
        grupos.marcarPronto(grupo)
        avisouIndisponivel = false
      } catch (e) {
        falhos.add(chaveDe(grupo.clienteId, grupo.competencia, grupo.modelo))
        estado.falhas++
        estado.ultimoErro = e.message
        logger.warn('Grupo da pasta organizada não gerado', { clienteId: grupo.clienteId, competencia: grupo.competencia, modelo: grupo.modelo, erro: e.message })
        if (!(await existe(config.pastaXmls))) return ficouIndisponivel()
      }
      estado.feitos++
    }
    estado.situacao = 'parada'
    estado.atual = null
    // Nota nova durante a geração: o grupo ficou com outra assinatura.
    const mudou = !deveParar() && grupos.pendentes().some((g) => !falhos.has(chaveDe(g.clienteId, g.competencia, g.modelo)))
    return { mudou }
  }

  async function laco() {
    let passadas = 0
    for (;;) {
      pedido = false
      const conferirAgora = conferirPedido
      conferirPedido = false
      if (conferirAgora) await conferir()
      const { mudou } = deveParar() ? { mudou: false } : await passada()
      passadas++
      if (deveParar() || estado.situacao === 'indisponivel') return
      if (!pedido && !(mudou && passadas < 2)) return
    }
  }

  function iniciar() {
    emCurso = laco()
      .catch((e) => {
        estado.situacao = 'parada'
        estado.atual = null
        logger.error('Erro na organização da pasta', { erro: e.message })
      })
      .finally(() => {
        emCurso = null
        if (!deveParar() && pedido) iniciar()
      })
  }

  /** Pede uma passada; se uma estiver rodando, faz mais uma ao terminar. */
  function agendar({ conferirArquivos = false } = {}) {
    try {
      if (parado || !pastas.temPasta()) return
      pedido = true
      if (conferirArquivos) conferirPedido = true
      if (!emCurso && pausas === 0) iniciar()
    } catch (e) {
      logger.error('Erro ao agendar a organização da pasta', { erro: e.message })
    }
  }

  /** Pausa entre arquivos, espera o grupo atual parar, executa `fn` e retoma com outra passada. */
  async function pausarDurante(fn) {
    pausas++
    const vez = fila
    let liberar
    fila = new Promise((r) => (liberar = r))
    try {
      await vez
      await emCurso
      return await fn()
    } finally {
      liberar()
      pausas--
      if (pausas === 0) agendar()
    }
  }

  /** Para e espera a passada terminar; depois, nenhuma começa. */
  async function parar() {
    parado = true
    await emCurso
  }

  const removerCliente = (clienteId) => apagarDoCliente.run(clienteId)

  /** Resolve quando não há passada rodando nem pedida. */
  async function aguardar() {
    while (emCurso) await emCurso
  }

  return { agendar, parar, pausarDurante, removerCliente, aguardar, estado: () => ({ ...estado }) }
}

module.exports = { criarGrupos, criarGerador, criarOrganizador }
