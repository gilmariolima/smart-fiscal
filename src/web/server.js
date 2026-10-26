'use strict'

// Painel local: API JSON + o painel React já compilado (pasta dist, gerada no npm install).
// A API só lê, exceto: disparar captura, gerar exportação, reprocessar uma nota e, só no
// próprio computador, cadastrar clientes (certificado e senha nunca passam pela rede).

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const archiver = require('archiver')
const express = require('express')
const { COLUNAS_PUBLICAS } = require('../services/clientes')
const { diasParaVencer } = require('../certificado')
const { detalharNfe } = require('../services/detalheNota')

const POR_PAGINA = 50
const HOSTS_LOCAIS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const ENDERECOS_LOCAIS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const ROTA_CERTIFICADO = /^\/(clientes(\/\d{14}\/certificado)?|escritorio(\/certificado)?)$/
const LIMITE_PFX = '300kb' // o .pfx chega em base64 dentro do JSON
const PADRAO_ZIP = /^\d{14}(_[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)?_\d{4}-\d{2}\.zip$/

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem)
    this.status = status
  }
}

function iguaisSemVazarTempo(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * @param {object} deps
 * @param {object} deps.ctx        criarContexto(...)
 * @param {object} deps.agendador  criarAgendador(...)
 * @param {Function} [deps.ehLocal] (req) => o pedido veio do próprio computador (troca nos testes)
 * @param {Function} [deps.estoque] () => motor do SPED ({ porta, token } ou { erro }), para onde vai /estoque
 */
function criarApp({ ctx, agendador, estoque, atualizacao, ehLocal = (req) => ENDERECOS_LOCAIS.has(req.socket.remoteAddress), pastaPainel = path.join(__dirname, 'dist') }) {
  const { db, config, logger } = ctx
  const app = express()
  app.disable('x-powered-by')
  app.set('etag', false)

  // Cabeçalhos de segurança: nada de fora entra na página.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    next()
  })

  // Painel local: só aceita o próprio PC como Host (barra DNS rebinding).
  const exposto = !HOSTS_LOCAIS.has(config.painelHost)
  app.use((req, res, next) => {
    if (exposto) return next()
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!HOSTS_LOCAIS.has(host)) return res.status(403).json({ erro: 'Acesso permitido só pelo próprio computador (127.0.0.1).' })
    next()
  })

  // Senha (obrigatória quando o painel está exposto na rede).
  if (config.painelSenha) {
    app.use((req, res, next) => {
      const [tipo, valor] = String(req.headers.authorization || '').split(' ')
      const senha = tipo === 'Basic' && valor ? Buffer.from(valor, 'base64').toString('utf8').replace(/^[^:]*:/, '') : ''
      if (senha && iguaisSemVazarTempo(senha, config.painelSenha)) return next()
      res.set('WWW-Authenticate', 'Basic realm="Smart Fiscal", charset="UTF-8"')
      res.status(401).json({ erro: 'Senha do painel necessária.' })
    })
  }

  // SPED (motor em Python): tudo de /estoque vai para ele, com o token desta execução. Vem antes
  // dos leitores de JSON: o arquivo do cliente passa direto, sem ser lido aqui.
  app.use('/estoque', (req, res) => {
    const motor = estoque?.()
    if (!motor?.porta) return res.status(503).json({ erro: motor?.erro || 'O motor do SPED não está ligado.' })
    if (req.method !== 'GET' && req.get('X-Painel') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' })
    const cabecalhos = { host: `127.0.0.1:${motor.porta}`, 'x-estoque-token': motor.token }
    for (const k of ['content-type', 'content-length']) if (req.headers[k]) cabecalhos[k] = req.headers[k]
    const pedido = http.request({ host: '127.0.0.1', port: motor.porta, method: req.method, path: req.url, headers: cabecalhos }, (r) => {
      res.status(r.statusCode)
      for (const k of ['content-type', 'content-length', 'content-disposition']) if (r.headers[k]) res.set(k, r.headers[k])
      r.pipe(res)
    })
    pedido.on('error', (e) => {
      logger.error('Motor do SPED não respondeu', { rota: req.path, erro: e.message })
      if (!res.headersSent) res.status(502).json({ erro: 'O motor do SPED não respondeu. Feche e abra o Smart Fiscal.' })
    })
    req.pipe(pedido)
  })

  // Cadastro e troca de certificado: recusa quem não está no próprio PC antes de ler o corpo.
  const jsonCertificado = express.json({ limit: LIMITE_PFX })
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST' || !ROTA_CERTIFICADO.test(req.path)) return next()
    if (!ehLocal(req)) return res.status(403).json({ erro: 'O cadastro de clientes só pode ser feito no próprio computador do sistema.' })
    jsonCertificado(req, res, next)
  })
  // ZIP das selecionadas: até 2.000 ids cabem em 64 KB; o limite maior vale só nesta rota.
  const jsonZip = express.json({ limit: '64kb' })
  app.use('/api', (req, res, next) => (req.method === 'POST' && req.path === '/notas/zip' ? jsonZip(req, res, next) : next()))
  app.use('/api', express.json({ limit: '10kb' }))

  // Ações (POST) só pelo próprio painel: exige cabeçalho que um formulário de outro site não envia.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Painel') !== '1') return res.status(403).json({ erro: 'Requisição recusada.' })
    next()
  })

  // ---------- consultas ----------

  const sql = {
    clientes: db.prepare(`SELECT ${COLUNAS_PUBLICAS} FROM clientes WHERE papel = 'cliente' ORDER BY razao_social`),
    contagemPorCliente: db.prepare(`SELECT cliente_id,
        SUM(CASE WHEN status = 'resumo' AND cancelada = 0 THEN 1 ELSE 0 END) resumo,
        SUM(CASE WHEN status = 'ciencia_enviada' AND cancelada = 0 THEN 1 ELSE 0 END) ciencia,
        SUM(CASE WHEN status = 'ciencia_erro' AND cancelada = 0 THEN 1 ELSE 0 END) ciencia_erro,
        SUM(CASE WHEN status = 'completa' THEN 1 ELSE 0 END) completa,
        SUM(CASE WHEN status = 'ciencia_enviada' AND cancelada = 0 AND tentativas_download >= @maxTentativas THEN 1 ELSE 0 END) esgotadas,
        SUM(CASE WHEN competencia = @competencia THEN 1 ELSE 0 END) no_mes,
        SUM(CASE WHEN competencia = @competencia AND tipo = 'entrada' THEN 1 ELSE 0 END) entradas_no_mes,
        SUM(CASE WHEN competencia = @competencia AND tipo = 'saida' THEN 1 ELSE 0 END) saidas_no_mes
      FROM notas GROUP BY cliente_id`),
    competencias: db.prepare('SELECT DISTINCT competencia FROM notas WHERE competencia IS NOT NULL ORDER BY competencia DESC'),
    mesesDoCliente: db.prepare(`SELECT competencia,
        SUM(tipo = 'entrada') entradas, SUM(tipo = 'saida') saidas
      FROM notas WHERE cliente_id = ? AND competencia IS NOT NULL GROUP BY competencia ORDER BY competencia DESC`),
    saidasDoMes: db.prepare("SELECT COUNT(*) n FROM notas WHERE tipo = 'saida' AND competencia = ?"),
    nota: db.prepare('SELECT * FROM notas WHERE id = ?'),
    eventosComArquivo: db.prepare('SELECT caminho_xml FROM eventos WHERE chave = ? AND caminho_xml IS NOT NULL ORDER BY tp_evento, n_seq'),
    notaComCliente: db.prepare(`SELECT n.id, n.tipo, n.chave, n.numero, n.serie, n.data_emissao, n.emitente_cnpj, n.emitente_nome, n.emitente_ie,
        n.destinatario_cnpj, n.destinatario_nome, n.valor_total, n.status, n.cancelada, n.situacao_sefaz, n.competencia, n.ciencia_em,
        n.caminho_xml IS NOT NULL tem_xml, c.cnpj cliente_cnpj, COALESCE(c.apelido, c.razao_social) cliente_nome
      FROM notas n JOIN clientes c ON c.id = n.cliente_id WHERE n.id = ?`),
    eventosDaNota: db.prepare('SELECT tp_evento, n_seq, descricao, data_evento, protocolo FROM eventos WHERE chave = ? ORDER BY data_evento, id'),
    ultimaCaptura: db.prepare("SELECT fim FROM execucoes WHERE tipo = 'captura' AND fim IS NOT NULL ORDER BY fim DESC, id DESC LIMIT 1"),
    clientePorCnpj: db.prepare('SELECT id, cnpj, papel FROM clientes WHERE cnpj = ?'),
    ativosNaOrdem: db.prepare("SELECT cnpj FROM clientes WHERE ativo = 1 AND papel = 'cliente' ORDER BY id"),
    execucoes: db.prepare(`SELECT e.*, c.cnpj, COALESCE(c.apelido, c.razao_social) cliente_nome FROM execucoes e
      LEFT JOIN clientes c ON c.id = e.cliente_id ORDER BY e.id DESC LIMIT 200`),
    zerarTentativas: db.prepare("UPDATE notas SET tentativas_download = 0, atualizado_em = ? WHERE id = ? AND tipo = 'entrada'"),
    reenviarCiencia: db.prepare("UPDATE notas SET status = 'resumo', ciencia_erro = NULL, atualizado_em = ? WHERE id = ? AND tipo = 'entrada'"),
  }

  const agora = () => (ctx.deps.agora ? ctx.deps.agora() : new Date())
  const competenciaAtual = () => new Date(agora().getTime() - 3 * 3600e3).toISOString().slice(0, 7)

  // Captura disparada pelo painel (fora do horário do agendador).
  let capturaManual = null
  // Quem a captura do painel está processando e quem espera (para o painel mostrar o andamento).
  const andamento = { atual: null, fila: [] }
  function capturaOcupada() {
    return !!(capturaManual || agendador.estado().rodandoAgora || ctx.ciclo.cicloEmAndamento())
  }

  app.get('/api/resumo', (req, res) => {
    res.json({
      ...ctx.resumo.resumo(),
      ambiente: { producao: config.tpAmb === '1', sefazSimulada: config.sefazMock },
      versao: process.env.SMART_FISCAL_VERSAO || '',
      cadastroLiberado: ehLocal(req),
      automacao: ctx.automacao.obter(),
      backup: ctx.backup.estado(),
      agendador: agendador.estado(),
      ultimaCaptura: sql.ultimaCaptura.get()?.fim ?? null,
      capturaEmAndamento: capturaOcupada(),
      limites: { consultasChavePorCiclo: config.maxConsultasChavePorCiclo, tentativasDownload: config.maxTentativasDownload },
    })
  })

  const futuro = (iso) => (iso && new Date(iso).getTime() > agora().getTime() ? iso : null)

  app.get('/api/clientes', (req, res) => {
    const contagens = new Map(sql.contagemPorCliente.all({ maxTentativas: config.maxTentativasDownload, competencia: competenciaAtual() }).map((c) => [c.cliente_id, c]))
    const clientes =
      sql.clientes.all().map((c) => {
        const n = contagens.get(c.id) || {}
        return {
          cnpj: c.cnpj,
          razaoSocial: c.razao_social,
          apelido: c.apelido,
          uf: c.uf,
          ativo: !!c.ativo,
          ultNsu: c.ult_nsu,
          maxNsu: c.max_nsu,
          ultimaConsulta: c.ultima_consulta,
          ultimoErro: c.ultimo_erro,
          proximaConsulta: futuro(c.proxima_consulta),
          bloqueadoAte: futuro(c.bloqueado_ate),
          certValidade: c.cert_validade,
          certDias: c.cert_validade ? diasParaVencer(c.cert_validade, agora()) : null,
          notas: {
            resumo: n.resumo || 0,
            ciencia: n.ciencia || 0,
            cienciaErro: n.ciencia_erro || 0,
            completa: n.completa || 0,
            esgotadas: n.esgotadas || 0,
            noMes: n.no_mes || 0,
            entradasNoMes: n.entradas_no_mes || 0,
            saidasNoMes: n.saidas_no_mes || 0,
          },
        }
      })
    res.json({ clientes, capturandoAgora: andamento.atual, filaCaptura: [...andamento.fila] })
  })

  app.get('/api/clientes/:cnpj/meses', (req, res) => {
    const cliente = sql.clientePorCnpj.get(req.params.cnpj)
    if (!cliente || cliente.papel !== 'cliente') throw new ErroHttp(404, 'Cliente não cadastrado.')
    const anos = []
    for (const m of sql.mesesDoCliente.all(cliente.id)) {
      const ano = Number(m.competencia.slice(0, 4))
      let grupo = anos[anos.length - 1]
      if (!grupo || grupo.ano !== ano) anos.push((grupo = { ano, entradas: 0, saidas: 0, meses: [] }))
      grupo.entradas += m.entradas
      grupo.saidas += m.saidas
      grupo.meses.push({ mes: Number(m.competencia.slice(5, 7)), entradas: m.entradas, saidas: m.saidas })
    }
    res.json(anos)
  })

  app.get('/api/competencias', (req, res) => {
    res.json(sql.competencias.all().map((c) => c.competencia))
  })

  const FILTROS_STATUS = {
    resumo: "n.status = 'resumo' AND n.cancelada = 0",
    ciencia_enviada: "n.status = 'ciencia_enviada' AND n.cancelada = 0",
    ciencia_erro: "n.status = 'ciencia_erro' AND n.cancelada = 0",
    completa: "n.status = 'completa' AND n.cancelada = 0",
    sem_xml: "n.status <> 'completa' AND n.cancelada = 0",
    aguardando_xml: "n.status = 'ciencia_enviada' AND n.cancelada = 0 AND n.tentativas_download < @maxTentativas",
    esgotada: "n.status = 'ciencia_enviada' AND n.cancelada = 0 AND n.tentativas_download >= @maxTentativas",
    cancelada: 'n.cancelada = 1',
  }

  const COLUNAS_ORDEM = {
    tipo: 'n.tipo',
    numero: 'CAST(n.numero AS INTEGER)',
    emissao: 'n.data_emissao',
    emitente_cnpj: 'n.emitente_cnpj',
    emitente_nome: 'n.emitente_nome',
    destinatario_cnpj: 'n.destinatario_cnpj',
    valor: 'n.valor_total',
  }
  const ORDENS = { 'emissao-desc': 'n.data_emissao DESC, n.id DESC' }
  const MAX_IDS = 2001

  // LIKE com escape no nome e, com 3+ dígitos, no CNPJ de emitente ou destinatário
  function filtroContraparte(valor, p) {
    const termo = String(valor).trim().slice(0, 100)
    const digitos = termo.replace(/\D/g, '')
    const k = Object.keys(p).length
    p[`ct${k}`] = `%${termo.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    let cnpj = ''
    if (digitos.length >= 3) {
      p[`ct${k}Cnpj`] = `%${digitos}%`
      cnpj = ` OR n.emitente_cnpj LIKE @ct${k}Cnpj OR n.destinatario_cnpj LIKE @ct${k}Cnpj`
    }
    return `(n.emitente_nome LIKE @ct${k} ESCAPE '\\' OR n.destinatario_nome LIKE @ct${k} ESCAPE '\\'${cnpj})`
  }

  app.get('/api/notas', (req, res) => {
    const q = req.query
    const where = []
    const p = { maxTentativas: config.maxTentativasDownload }
    if (q.cnpj) {
      where.push('c.cnpj = @cnpj')
      p.cnpj = String(q.cnpj).replace(/\D/g, '')
    }
    if (q.tipo && q.tipo !== 'entrada' && q.tipo !== 'saida') throw new ErroHttp(400, 'Tipo inválido.')
    if (q.competencia) {
      if (!/^\d{4}-\d{2}$/.test(q.competencia)) throw new ErroHttp(400, 'Competência inválida (use AAAA-MM).')
      where.push('n.competencia = @competencia')
      p.competencia = q.competencia
    }
    if (q.status) {
      if (!FILTROS_STATUS[q.status]) throw new ErroHttp(400, 'Filtro de estado inválido.')
      where.push(FILTROS_STATUS[q.status])
    }
    const contraparte = q.contraparte || q.emitente
    if (contraparte) where.push(filtroContraparte(contraparte, p))
    if (q.busca) {
      const termo = String(q.busca).trim().slice(0, 100)
      let clausula = filtroContraparte(termo, p)
      if (/^\d{1,9}$/.test(termo)) {
        clausula = `(${clausula} OR CAST(n.numero AS INTEGER) = @buscaNumero)`
        p.buscaNumero = Number(termo)
      }
      where.push(clausula)
    }
    for (const [campo, op] of [['valorMin', '>='], ['valorMax', '<=']]) {
      if (q[campo] === undefined || q[campo] === '') continue
      const v = Number(String(q[campo]).replace(/\./g, '').replace(',', '.'))
      if (!Number.isFinite(v)) throw new ErroHttp(400, 'Valor inválido.')
      where.push(`n.valor_total ${op} @${campo}`)
      p[campo] = v
    }
    const contagem = db.prepare(`SELECT n.tipo, COUNT(*) qtd FROM notas n JOIN clientes c ON c.id = n.cliente_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY n.tipo`).all(p)
    const contagemTipo = { entradas: 0, saidas: 0 }
    for (const l of contagem) {
      if (l.tipo === 'entrada') contagemTipo.entradas = l.qtd
      else if (l.tipo === 'saida') contagemTipo.saidas = l.qtd
    }
    if (q.tipo) {
      where.push('n.tipo = @tipo')
      p.tipo = q.tipo
    }
    const filtro = where.length ? `WHERE ${where.join(' AND ')}` : ''
    let ordem = ORDENS['emissao-desc']
    if (q.ordem !== undefined && q.ordem !== '') {
      const m = /^([a-z_]+)-(asc|desc)$/.exec(String(q.ordem))
      if (!m || !COLUNAS_ORDEM[m[1]]) throw new ErroHttp(400, 'Ordenação inválida.')
      ordem = `${COLUNAS_ORDEM[m[1]]} ${m[2].toUpperCase()}, n.id ${m[2].toUpperCase()}`
    }
    if (q.somenteIds === '1') {
      const ids = db.prepare(`SELECT n.id FROM notas n JOIN clientes c ON c.id = n.cliente_id ${filtro} ORDER BY ${ordem} LIMIT ${MAX_IDS}`).all(p)
      return res.json({ ids: ids.map((l) => l.id) })
    }
    const pagina = Math.max(1, Number.parseInt(q.pagina, 10) || 1)
    const base = `FROM notas n JOIN clientes c ON c.id = n.cliente_id ${filtro}`
    const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(n.valor_total), 0) valor ${base}`).get(p)
    const notas = db
      .prepare(`SELECT n.id, n.tipo, n.destinatario_cnpj, n.destinatario_nome, n.chave, n.numero, n.serie, n.data_emissao, n.emitente_cnpj, n.emitente_nome, n.valor_total, n.status,
          n.cancelada, n.competencia, n.ciencia_em, n.ciencia_erro, n.tentativas_download, n.exportada_em,
          n.caminho_xml IS NOT NULL tem_xml, c.cnpj cliente_cnpj, COALESCE(c.apelido, c.razao_social) cliente_nome
        ${base} ORDER BY ${ordem} LIMIT ${POR_PAGINA} OFFSET @offset`)
      .all({ ...p, offset: (pagina - 1) * POR_PAGINA })
    res.json({ total: total.n, valorTotal: total.valor, pagina, porPagina: POR_PAGINA, limiteTentativas: config.maxTentativasDownload, contagemTipo, notas })
  })

  function notaOu404(id) {
    const nota = /^\d{1,12}$/.test(id) ? sql.nota.get(Number(id)) : null
    if (!nota) throw new ErroHttp(404, 'Nota não encontrada.')
    return nota
  }

  // Arquivo dentro da pasta esperada (nunca segue caminho para fora dela).
  function dentroDe(pasta, relativo) {
    const base = path.resolve(pasta)
    const alvo = path.resolve(base, relativo)
    return alvo.startsWith(base + path.sep) ? alvo : null
  }

  app.get('/api/notas/:id/xml', (req, res) => {
    const nota = notaOu404(req.params.id)
    const arquivo = nota.caminho_xml && dentroDe(config.pastaXmls, nota.caminho_xml)
    if (!arquivo || !fs.existsSync(arquivo)) throw new ErroHttp(404, 'Esta nota ainda não tem o XML completo.')
    res.set('Content-Type', 'application/xml; charset=utf-8')
    res.attachment(`${nota.chave}-nfe.xml`)
    fs.createReadStream(arquivo).pipe(res)
  })

  // XML da nota + eventos da chave que têm arquivo (cancelamento, carta de correção), num ZIP.
  app.get('/api/notas/:id/xml-eventos', (req, res) => {
    const nota = notaOu404(req.params.id)
    const arquivo = nota.caminho_xml && dentroDe(config.pastaXmls, nota.caminho_xml)
    if (!arquivo || !fs.existsSync(arquivo)) throw new ErroHttp(404, 'Esta nota ainda não tem o XML completo.')
    const eventos = sql.eventosComArquivo
      .all(nota.chave)
      .map((e) => dentroDe(config.pastaXmls, e.caminho_xml))
      .filter((a) => a && fs.existsSync(a))
    res.set('Content-Type', 'application/zip')
    res.set('Content-Disposition', `attachment; filename="${nota.chave}-nfe-eventos.zip"`)
    const zip = archiver('zip', { zlib: { level: 9 } })
    zip.on('error', (e) => {
      logger.error('Falha ao montar o ZIP da nota com eventos', { erro: e.message })
      res.destroy(e)
    })
    zip.pipe(res)
    zip.append(fs.createReadStream(arquivo), { name: `${nota.chave}-nfe.xml` })
    for (const a of eventos) zip.append(fs.createReadStream(a), { name: path.basename(a) })
    zip.finalize()
  })

  // Tela "Ver nota": dados do banco, XML lido (se houver) e eventos da chave.
  app.get('/api/notas/:id/detalhe', (req, res) => {
    const nota = notaOu404(req.params.id)
    let nfe = null
    let erroXml = null
    if (nota.caminho_xml) {
      const arquivo = dentroDe(config.pastaXmls, nota.caminho_xml)
      if (!arquivo || !fs.existsSync(arquivo)) erroXml = 'O arquivo XML desta nota não foi encontrado na pasta de XMLs.'
      else {
        nfe = detalharNfe(fs.readFileSync(arquivo, 'utf8'))
        if (!nfe) erroXml = 'Não foi possível ler o XML desta nota.'
      }
    }
    res.json({ nota: sql.notaComCliente.get(nota.id), nfe, erroXml, eventos: sql.eventosDaNota.all(nota.chave) })
  })

  app.post('/api/notas/:id/reprocessar', (req, res) => {
    const nota = notaOu404(req.params.id)
    if (nota.tipo === 'saida') throw new ErroHttp(409, 'Nota de saída não passa por ciência nem download.')
    if (nota.cancelada) throw new ErroHttp(409, 'Nota cancelada: não há o que reprocessar.')
    if (nota.status === 'ciencia_enviada') {
      sql.zerarTentativas.run(agora().toISOString(), nota.id)
      logger.info('Download reprocessado pelo painel', { chave: nota.chave })
      return res.json({ ok: true, mensagem: 'O download será tentado de novo na próxima captura.' })
    }
    if (nota.status === 'ciencia_erro') {
      sql.reenviarCiencia.run(agora().toISOString(), nota.id)
      logger.info('Nota com erro na ciência volta a aguardar a ciência do cliente', { chave: nota.chave })
      return res.json({ ok: true, mensagem: 'A nota volta a aguardar a ciência do cliente.' })
    }
    throw new ErroHttp(409, 'Só dá para reprocessar notas com ciência enviada ou com erro na ciência.')
  })

  const MAX_CNPJS_CAPTURA = 500

  function capturaDeLista(cnpjsBrutos, res) {
    if (!Array.isArray(cnpjsBrutos) || cnpjsBrutos.length < 1 || cnpjsBrutos.length > MAX_CNPJS_CAPTURA) {
      throw new ErroHttp(400, `Informe de 1 a ${MAX_CNPJS_CAPTURA} CNPJs para capturar.`)
    }
    const cnpjs = [...new Set(cnpjsBrutos.map((c) => String(c).replace(/\D/g, '')))]
    for (const cnpj of cnpjs) {
      const cliente = sql.clientePorCnpj.get(cnpj)
      if (!cliente) throw new ErroHttp(404, `Cliente ${cnpj} não cadastrado.`)
      if (cliente.papel === 'escritorio') throw new ErroHttp(400, 'O escritório é capturado sempre junto; não o marque na lista.')
    }
    if (capturaOcupada()) throw new ErroHttp(409, 'Já existe uma captura em andamento. Aguarde terminar.')
    const escritorio = ctx.clientes.obterEscritorio()
    const marcados = new Set(cnpjs)
    andamento.fila = [
      ...(escritorio?.ativo ? [escritorio.cnpj] : []),
      ...sql.ativosNaOrdem.all().map((c) => c.cnpj).filter((c) => marcados.has(c)),
    ]
    const aoIniciarCliente = (cnpj) => {
      andamento.fila = andamento.fila.filter((c) => c !== cnpj)
      andamento.atual = cnpj
    }
    capturaManual = Promise.resolve(ctx.ciclo.executarCiclo({ cnpjs, aoIniciarCliente }))
      .then((r) => {
        if (r?.ok === false) logger.error('Captura pelo painel não rodou', { erro: r.erro })
        else logger.info('Captura pelo painel terminada', { clientes: r?.clientes?.length ?? 0, comErro: r?.clientes?.filter((c) => c.erro).length ?? 0 })
      })
      .catch((e) => logger.error('Erro na captura pelo painel', { erro: e.message }))
      .finally(() => {
        capturaManual = null
        andamento.atual = null
        andamento.fila = []
      })
    logger.info('Captura dos clientes marcados disparada pelo painel', { clientes: cnpjs.length })
    res.status(202).json({ ok: true, mensagem: `Captura de ${cnpjs.length} clientes iniciada.` })
  }

  app.post('/api/captura', (req, res) => {
    if (req.body && 'cnpjs' in req.body) return capturaDeLista(req.body.cnpjs, res)
    const cnpj = req.body?.cnpj ? String(req.body.cnpj).replace(/\D/g, '') : undefined
    if (cnpj && !sql.clientePorCnpj.get(cnpj)) throw new ErroHttp(404, 'Cliente não cadastrado.')
    if (capturaOcupada()) throw new ErroHttp(409, 'Já existe uma captura em andamento. Aguarde terminar.')
    const execucao = cnpj ? ctx.ciclo.executarCiclo({ cnpj }) : agendador.executarAgora('painel')
    capturaManual = Promise.resolve(execucao)
      .catch((e) => logger.error('Erro na captura pelo painel', { erro: e.message }))
      .finally(() => {
        capturaManual = null
      })
    logger.info('Captura disparada pelo painel', { cnpj: cnpj || 'todos' })
    res.status(202).json({ ok: true, mensagem: cnpj ? `Captura de ${cnpj} iniciada.` : 'Captura de todos os clientes iniciada.' })
  })

  app.post('/api/automacao', (req, res) => {
    const b = req.body || {}
    const mudancas = {}
    for (const nome of ['captura']) {
      if (b[nome] === undefined) continue
      if (typeof b[nome] !== 'boolean') throw new ErroHttp(400, 'Use ligado (true) ou desligado (false).')
      mudancas[nome] = b[nome]
    }
    if (!Object.keys(mudancas).length) throw new ErroHttp(400, 'Nada para mudar.')
    res.json({ ok: true, automacao: ctx.automacao.definir(mudancas), agendador: agendador.estado() })
  })

  app.post('/api/notas/zip', (req, res) => {
    let zip
    try {
      zip = ctx.selecao.montar((req.body || {}).ids)
    } catch (e) {
      if (e.status) throw new ErroHttp(e.status, e.message)
      throw e
    }
    res.set('Content-Type', 'application/zip')
    res.set('Content-Disposition', `attachment; filename="${zip.nome}"`)
    const arquivo = archiver('zip', { zlib: { level: 9 } })
    arquivo.on('error', (e) => {
      logger.error('Falha ao montar o ZIP das selecionadas', { erro: e.message })
      res.destroy(e)
    })
    arquivo.on('warning', (e) => logger.warn('Aviso ao montar o ZIP das selecionadas', { erro: e.message }))
    arquivo.pipe(res)
    for (const a of zip.arquivos) arquivo.append(a.caminho ? fs.createReadStream(a.caminho) : a.conteudo, { name: a.nome })
    arquivo.finalize()
  })

  app.post('/api/exportar', async (req, res) => {
    const { cnpj, competencia } = req.body || {}
    if (!cnpj || !competencia) throw new ErroHttp(400, 'Informe o cliente e a competência.')
    let r
    try {
      r = await ctx.exportacao.exportar({ cnpj: String(cnpj), competencia: String(competencia) })
    } catch (e) {
      throw new ErroHttp(/inválid|não cadastrado/.test(e.message) ? 400 : 500, e.message)
    }
    res.json({
      nome: r.nome,
      bytes: r.bytes,
      xmls: r.xmls,
      canceladas: r.canceladas,
      semXml: r.semXml,
      porTipo: r.porTipo,
      totalNotas: r.totalNotas,
      avisos: r.avisos,
      url: `/api/exportacoes/${encodeURIComponent(r.nome)}`,
    })
  })

  app.get('/api/exportacoes/:nome', (req, res) => {
    const nome = req.params.nome
    const arquivo = PADRAO_ZIP.test(nome) && dentroDe(config.pastaExports, nome)
    if (!arquivo || !fs.existsSync(arquivo)) throw new ErroHttp(404, 'Arquivo de exportação não encontrado.')
    res.set('Content-Type', 'application/zip')
    res.attachment(nome)
    fs.createReadStream(arquivo).pipe(res)
  })

  // ---------- cadastro de clientes (só no próprio computador) ----------

  function exigirLocal(req) {
    if (!ehLocal(req)) throw new ErroHttp(403, 'O cadastro de clientes só pode ser feito no próprio computador do sistema.')
  }

  function lerPfx(body) {
    const pfx = typeof body?.pfx === 'string' ? Buffer.from(body.pfx, 'base64') : Buffer.alloc(0)
    if (!pfx.length) throw new ErroHttp(400, 'Escolha o arquivo do certificado (.pfx ou .p12).')
    if (typeof body.senha !== 'string' || !body.senha) throw new ErroHttp(400, 'Informe a senha do certificado.')
    return pfx
  }

  // Erros do serviço já vêm com a mensagem para o usuário.
  function comoErroHttp(fn) {
    try {
      return fn()
    } catch (e) {
      if (e instanceof ErroHttp) throw e
      throw new ErroHttp(/já cadastrado|já existe/i.test(e.message) ? 409 : /não cadastrado/.test(e.message) ? 404 : 400, e.message)
    }
  }

  const recibo = ({ cliente, certificado, avisos }) => ({
    cnpj: cliente.cnpj,
    razaoSocial: cliente.razao_social,
    apelido: cliente.apelido,
    uf: cliente.uf,
    titular: certificado.titular,
    cnpjCertificado: certificado.cnpj,
    validade: certificado.validade,
    avisos,
  })

  app.post('/api/clientes', (req, res) => {
    exigirLocal(req)
    const b = req.body || {}
    const pfx = lerPfx(b)
    const r = comoErroHttp(() => ctx.clientes.cadastrar({ cnpj: String(b.cnpj || ''), razao: String(b.razao || ''), uf: String(b.uf || ''), apelido: String(b.apelido || ''), pfx, senha: b.senha }))
    res.status(201).json(recibo(r))
  })

  app.post('/api/clientes/:cnpj/certificado', (req, res) => {
    exigirLocal(req)
    const pfx = lerPfx(req.body)
    const r = comoErroHttp(() => ctx.clientes.trocarCertificado({ cnpj: req.params.cnpj, pfx, senha: req.body.senha }))
    res.json(recibo(r))
  })

  app.post('/api/clientes/:cnpj/ativo', (req, res) => {
    exigirLocal(req)
    if (typeof req.body?.ativo !== 'boolean') throw new ErroHttp(400, 'Informe se o cliente fica ativo.')
    const c = comoErroHttp(() => ctx.clientes.definirAtivo(req.params.cnpj, req.body.ativo))
    res.json({ ok: true, ativo: !!c.ativo, mensagem: c.ativo ? 'Cliente reativado.' : 'Cliente desativado: fica fora das próximas capturas.' })
  })

  // ---------- escritório (certificado próprio, notas de saída pelo autXML) ----------

  app.get('/api/escritorio', (req, res) => {
    const c = ctx.clientes.obterEscritorio()
    res.json(c ? {
      cnpj: c.cnpj,
      razaoSocial: c.razao_social,
      uf: c.uf,
      ativo: !!c.ativo,
      ultimaConsulta: c.ultima_consulta,
      ultimoErro: c.ultimo_erro,
      proximaConsulta: futuro(c.proxima_consulta),
      bloqueadoAte: futuro(c.bloqueado_ate),
      certValidade: c.cert_validade,
      certDias: c.cert_validade ? diasParaVencer(c.cert_validade, agora()) : null,
      saidasNoMes: sql.saidasDoMes.get(competenciaAtual()).n,
    } : null)
  })

  app.post('/api/escritorio', (req, res) => {
    exigirLocal(req)
    const b = req.body || {}
    const pfx = lerPfx(b)
    const r = comoErroHttp(() => ctx.clientes.cadastrarEscritorio({ cnpj: String(b.cnpj || ''), razao: String(b.razao || ''), uf: String(b.uf || ''), pfx, senha: b.senha }))
    res.status(201).json(recibo(r))
  })

  app.post('/api/escritorio/dados', (req, res) => {
    exigirLocal(req)
    const b = req.body || {}
    const c = comoErroHttp(() => ctx.clientes.editarEscritorio({ razao: String(b.razao || ''), uf: String(b.uf || '') }))
    res.json({ ok: true, mensagem: 'Dados do escritório salvos.', razaoSocial: c.razao_social, uf: c.uf })
  })

  app.post('/api/escritorio/excluir', (req, res) => {
    exigirLocal(req)
    if (capturaOcupada()) throw new ErroHttp(409, 'Há uma captura em andamento. Aguarde terminar para excluir o escritório.')
    const c = comoErroHttp(() => ctx.clientes.excluirEscritorio())
    res.json({ ok: true, mensagem: `Escritório ${c.razao_social} excluído.` })
  })

  app.post('/api/escritorio/certificado', (req, res) => {
    exigirLocal(req)
    const pfx = lerPfx(req.body)
    const esc = ctx.clientes.obterEscritorio()
    if (!esc) throw new ErroHttp(404, 'Escritório não cadastrado.')
    const r = comoErroHttp(() => ctx.clientes.trocarCertificado({ cnpj: esc.cnpj, pfx, senha: req.body.senha }))
    res.json(recibo(r))
  })

  // ---------- atualização do app ----------

  app.get('/api/atualizacao', (req, res) => {
    res.json(atualizacao ? atualizacao.estado() : { situacao: 'indisponivel' })
  })

  app.post('/api/atualizacao/verificar', async (req, res) => {
    res.json(atualizacao ? await atualizacao.verificar() : { situacao: 'indisponivel' })
  })

  // ---------- backup ----------

  app.get('/api/backup', (req, res) => {
    res.json(ctx.backup.estado())
  })

  app.post('/api/backup/pasta', (req, res) => {
    exigirLocal(req)
    const r = comoErroHttp(() => ctx.backup.definirPasta(String(req.body?.pasta ?? '')))
    if (r.pasta) ctx.backup.fazerBackup()
    res.json({ ok: true, mensagem: r.pasta ? 'Pasta do backup salva. O primeiro backup já começou.' : 'Backup automático desligado.', avisos: r.avisos, estado: ctx.backup.estado() })
  })

  app.post('/api/backup/agora', (req, res) => {
    if (!ctx.backup.ativo) throw new ErroHttp(409, 'Escolha a pasta do backup primeiro.')
    ctx.backup.fazerBackup({ forcar: true })
    res.status(202).json({ ok: true, mensagem: 'Backup iniciado.', estado: ctx.backup.estado() })
  })

  app.get('/api/execucoes', (req, res) => {
    res.json(sql.execucoes.all())
  })

  app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }))

  app.use(express.static(pastaPainel, { index: 'index.html', etag: false, lastModified: false }))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || fs.existsSync(path.join(pastaPainel, 'index.html'))) return next()
    res.status(503).type('text/plain; charset=utf-8').send('Painel não compilado: rode npm install')
  })

  // Erros: mensagem para o usuário; detalhe interno só no log.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err)
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ erro: 'Corpo da requisição inválido.' })
    if (err instanceof ErroHttp) return res.status(err.status).json({ erro: err.message })
    logger.error('Erro no painel', { rota: req.path, erro: err.message })
    res.status(500).json({ erro: 'Erro interno. Veja logs/app.log.' })
  })

  return app
}

/** Sobe o painel em PAINEL_HOST:PAINEL_PORTA. */
function iniciarPainel({ ctx, agendador, estoque, atualizacao }) {
  const { config, logger } = ctx
  const app = criarApp({ ctx, agendador, estoque, atualizacao })
  return new Promise((resolve, reject) => {
    const servidor = app.listen(config.painelPorta, config.painelHost)
    servidor.once('error', (e) => {
      reject(new Error(e.code === 'EADDRINUSE' ? `A porta ${config.painelPorta} já está em uso (o servidor já está rodando?).` : e.message))
    })
    servidor.once('listening', () => {
      const { port } = servidor.address()
      const url = `http://${config.painelHost.includes(':') ? `[${config.painelHost}]` : config.painelHost}:${port}`
      logger.info('Painel no ar', { url })
      resolve({
        url,
        porta: port,
        fechar: () => new Promise((r) => {
          servidor.close(() => r())
          servidor.closeAllConnections?.()
        }),
      })
    })
  })
}

module.exports = { criarApp, iniciarPainel }
