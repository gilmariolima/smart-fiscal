'use strict'

// Ciclo por cliente: consulta por NSU → download por chave das notas com ciência enviada antes.
// O escritório não dá ciência: o dono da empresa dá, e o XML completo chega numa consulta seguinte.
// Um cliente por vez; erro em um cliente não interrompe os outros.
// Trava: em memória (mesmo processo) + no banco (CLI e servidor ao mesmo tempo).
// Fechar o app para entre um lote e outro: o NSU já gravado faz a próxima captura continuar dali.

const { criarServicoCaptura } = require('./captura')
const { criarServicoManifestacao } = require('./manifestacao')
const { criarServicoDownload } = require('./download')
const { criarServicoCapturaNfse } = require('./capturaNfse')
const { criarServicoCapturaCte } = require('./capturaCte')

const JANELA_TRAVA_MS = 30 * 60e3 // execução sem fim há mais de 30 min = processo que caiu

function criarServicoCiclo(deps) {
  const { db, logger, agora = () => new Date() } = deps
  let rodando = false
  let parada = false
  let emCurso = null // resolve quando o ciclo atual termina
  let andamento = null
  const depsCaptura = { ...deps, deveParar: () => parada }
  const captura = criarServicoCaptura(depsCaptura)
  const manifestacao = criarServicoManifestacao(deps)
  const download = criarServicoDownload({ ...depsCaptura, captura })
  const capturaNfse = criarServicoCapturaNfse(depsCaptura)
  const capturaCte = criarServicoCapturaCte(depsCaptura)

  const sql = {
    emAndamento: db.prepare(`SELECT id, tipo, inicio FROM execucoes WHERE fim IS NULL AND tipo IN ('captura', 'captura_nfse', 'captura_cte', 'ciencia', 'download')
      AND inicio > ? LIMIT 1`),
    fecharOrfas: db.prepare(`UPDATE execucoes SET fim = inicio, erro = ?,
      notas_recebidas = (SELECT COUNT(*) FROM notas WHERE notas.captura_id = execucoes.id) WHERE fim IS NULL`),
    // Sem certificado não há como consultar: quem não tem fica de fora (cert_arquivo vazio).
    ativos: db.prepare("SELECT * FROM clientes WHERE ativo = 1 AND papel = 'cliente' AND cert_arquivo <> '' ORDER BY id"),
    // Com procurador cadastrado, os sem certificado entram só para a NFS-e (via procuração no ADN).
    ativosSemCert: db.prepare("SELECT * FROM clientes WHERE ativo = 1 AND papel = 'cliente' AND cert_arquivo = '' ORDER BY id"),
    temProcurador: db.prepare("SELECT 1 FROM sistema WHERE chave = 'procurador_senha_enc'").pluck(),
    escritorio: db.prepare("SELECT * FROM clientes WHERE papel = 'escritorio' AND ativo = 1 LIMIT 1"),
    porCnpj: db.prepare('SELECT * FROM clientes WHERE cnpj = ?'),
  }

  function cicloEmAndamento() {
    if (rodando) return 'Já existe um ciclo rodando neste processo.'
    const limite = new Date(agora().getTime() - JANELA_TRAVA_MS).toISOString()
    const exec = sql.emAndamento.get(limite)
    return exec ? `Já existe uma execução (${exec.tipo}) em andamento desde ${exec.inicio}.` : null
  }

  // Ao abrir: linha sem fim é de um processo que morreu no meio. Sem isso ela segura a trava e fica "Em andamento" para sempre.
  // O fim fica igual ao início porque não se sabe a que horas parou.
  function encerrarOrfas() {
    if (rodando) return 0
    const { changes } = sql.fecharOrfas.run('Interrompida: o app foi fechado antes de terminar. A próxima captura continua de onde parou.')
    if (changes) logger.warn('Execuções interrompidas encerradas ao abrir', { execucoes: changes })
    return changes
  }

  /** Para no próximo intervalo entre lotes e espera; nada mais começa depois disso. */
  function parar() {
    parada = true
    return emCurso || Promise.resolve()
  }

  // `escritorioComoCliente`: o escritório entra também como cliente (NFS-e e CT-e dele), quando ele é cliente e foi escolhido.
  const temProcurador = () => !!sql.temProcurador.get()

  function clientesAlvo({ cnpj, cnpjs }) {
    if (cnpjs) {
      const achados = []
      let escritorioComoCliente = false
      for (const x of cnpjs) {
        const c = sql.porCnpj.get(x)
        if (!c) return { erro: `CNPJ ${x} não cadastrado.` }
        if (c.papel === 'escritorio') {
          if (!c.tambem_cliente) return { erro: `CNPJ ${x} é do escritório.` }
          escritorioComoCliente = true
          continue
        }
        achados.push(c)
      }
      const comProcurador = temProcurador()
      return { clientes: achados.filter((c) => c.ativo === 1 && (c.cert_arquivo || comProcurador)).sort((a, b) => a.id - b.id), escritorioComoCliente }
    }
    if (!cnpj) {
      const lista = temProcurador() ? [...sql.ativos.all(), ...sql.ativosSemCert.all()].sort((a, b) => a.id - b.id) : sql.ativos.all()
      return { clientes: lista, escritorioComoCliente: true }
    }
    const c = sql.porCnpj.get(cnpj)
    if (!c) return { erro: `CNPJ ${cnpj} não cadastrado.` }
    if (c.papel === 'escritorio') return { clientes: [], escritorio: c.ativo ? c : null, escritorioComoCliente: true }
    if (!c.cert_arquivo && !temProcurador()) return { erro: `CNPJ ${cnpj} está sem certificado: cadastre o A1 para capturar.` }
    return { clientes: [c] }
  }

  function avisar(aoIniciarCliente, cnpj) {
    try {
      aoIniciarCliente?.(cnpj)
    } catch (e) {
      logger.error('Erro no aviso de cliente iniciado', { cnpj, erro: e.message })
    }
  }

  // Executa `passo` para cada cliente sob a trava.
  // O escritório (se existir e estiver ativo) roda antes: `passoEscritorio(escritorio, comoCliente)` devolve
  // a função a rodar, ou null quando não há nada a fazer com ele.
  async function comTrava({ cnpj, cnpjs } = {}, passo, passoEscritorio, aoIniciarCliente) {
    const ocupado = cicloEmAndamento()
    if (ocupado) return { ok: false, erro: ocupado, clientes: [] }
    const { clientes, erro, escritorio: alvoEscritorio, escritorioComoCliente } = clientesAlvo({ cnpj, cnpjs })
    if (erro) return { ok: false, erro, clientes: [] }
    const escritorio = passoEscritorio ? (cnpj && !cnpjs ? alvoEscritorio : sql.escritorio.get()) : null
    const tarefaEscritorio = escritorio ? passoEscritorio(escritorio, !!(escritorioComoCliente && escritorio.tambem_cliente)) : null
    rodando = true
    let liberar
    emCurso = new Promise((r) => (liberar = r))
    const total = clientes.length + (tarefaEscritorio ? 1 : 0)
    let posicao = 0
    const comecar = (c) => {
      andamento = { cnpj: c.cnpj, nome: c.apelido || c.razao_social, posicao: ++posicao, total }
      avisar(aoIniciarCliente, c.cnpj)
    }
    try {
      let resultadoEscritorio
      if (tarefaEscritorio) {
        comecar(escritorio)
        try {
          resultadoEscritorio = { cnpj: escritorio.cnpj, ...(await tarefaEscritorio()) }
        } catch (e) {
          logger.error('Erro inesperado no ciclo do escritório', { cnpj: escritorio.cnpj, erro: e.message })
          resultadoEscritorio = { cnpj: escritorio.cnpj, erro: e.message }
        }
      }
      const resultados = []
      for (const cliente of clientes) {
        if (parada) {
          logger.info('Ciclo interrompido: app fechando', { clientesFaltando: total - posicao })
          break
        }
        comecar(cliente)
        try {
          resultados.push({ cnpj: cliente.cnpj, ...(await passo(cliente)) })
        } catch (e) {
          logger.error('Erro inesperado no ciclo do cliente', { cnpj: cliente.cnpj, erro: e.message })
          resultados.push({ cnpj: cliente.cnpj, erro: e.message })
        }
      }
      return resultadoEscritorio ? { ok: true, escritorio: resultadoEscritorio, clientes: resultados } : { ok: true, clientes: resultados }
    } finally {
      rodando = false
      andamento = null
      emCurso = null
      liberar()
      try {
        deps.aoTerminarCiclo?.()
      } catch (e) {
        logger.error('Erro ao avisar o fim do ciclo', { erro: e.message })
      }
    }
  }

  /** Ciclo completo. `forcar` ignora a espera de 1 h da consulta por NSU (nunca o bloqueio do 656). */
  /** `modelos`: ['nfe', 'nfse', 'cte'] (padrão) ou só alguns. NFS-e e CT-e do escritório só rodam quando ele também é cliente. */
  /** `automatica`: busca dos horários — cada cliente só roda os tipos ligados nele (auto_nfe / auto_nfse / auto_cte). */
  function executarCiclo({ cnpj, cnpjs, forcar = false, aoIniciarCliente, modelos = ['nfe', 'nfse', 'cte'], automatica = false } = {}) {
    const liga = (c, m) => modelos.includes(m) && (!automatica || c[`auto_${m}`] !== 0)
    return comTrava({ cnpj, cnpjs }, async (cliente) => {
      // Sem A1 próprio: só NFS-e, e só se houver procurador. NF-e e CT-e exigem o certificado do cliente.
      const comA1 = !!cliente.cert_arquivo
      const comNfe = liga(cliente, 'nfe') && comA1
      const comNfse = liga(cliente, 'nfse') && (comA1 || temProcurador())
      const comCte = liga(cliente, 'cte') && comA1
      if (!comNfe && !comNfse && !comCte) return { pulado: 'fora da busca automática' }
      // NF-e, NFS-e e CT-e são serviços separados: a falha de um não impede o outro.
      const resultado = {}
      if (comNfe) {
        const nfe = await semExcecao(async () => ({
          captura: await captura.capturarCliente(cliente.id, { forcar }),
          download: await download.baixarPendentes(cliente.id),
        }), cliente, 'NF-e')
        Object.assign(resultado, nfe.ok === false && nfe.erro ? { captura: nfe } : nfe)
      }
      if (comNfse) resultado.nfse = await semExcecao(() => capturaNfse.capturarCliente(cliente.id, { forcar }), cliente, 'NFS-e')
      if (comCte) resultado.cte = await semExcecao(() => capturaCte.capturarCliente(cliente.id, { forcar }), cliente, 'CT-e')
      return resultado
    }, (escritorio, comoCliente) => {
      const nfe = liga(escritorio, 'nfe')
      const nfse = liga(escritorio, 'nfse') && comoCliente
      const cte = liga(escritorio, 'cte') && comoCliente
      if (!nfe && !nfse && !cte) return null
      return async () => ({
        ...(nfe && { captura: await captura.capturarCliente(escritorio.id, { forcar }) }),
        ...(nfse && { nfse: await semExcecao(() => capturaNfse.capturarCliente(escritorio.id, { forcar }), escritorio, 'NFS-e') }),
        ...(cte && { cte: await semExcecao(() => capturaCte.capturarCliente(escritorio.id, { forcar }), escritorio, 'CT-e') }),
      })
    }, aoIniciarCliente)
  }

  async function semExcecao(fn, cliente, servico) {
    try {
      return await fn()
    } catch (e) {
      logger.error(`Erro inesperado na captura de ${servico}`, { cnpj: cliente.cnpj, erro: e.message })
      return { ok: false, erro: e.message }
    }
  }

  const somenteDownload = ({ cnpj } = {}) => comTrava({ cnpj }, async (c) => ({ download: await download.baixarPendentes(c.id) }))

  return {
    corrigirNotasDoEscritorio: captura.corrigirNotasDoEscritorio,
    executarCiclo,
    somenteDownload,
    manifestar: (args) => manifestacao.manifestar(args),
    cicloEmAndamento,
    encerrarOrfas,
    parar,
    progresso: () => andamento,
  }
}

module.exports = { criarServicoCiclo }
