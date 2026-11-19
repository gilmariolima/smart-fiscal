'use strict'

// NF-e de saída por período: descobre as chaves das NF-e de saída do cliente pelo número, na consulta de protocolo
// da SEFAZ (a chave montada com um código qualquer volta com 613 e a chave verdadeira), e põe na fila da Busca por chave,
// que baixa o XML pela SVRS com o certificado do próprio cliente. Alcança só os últimos 6 meses (cStat 526).

const { montarChave } = require('../sefaz/consultaProtocolo')
const { UFS } = require('../sefaz/uf')
const { classificar, acharUltimo, acharPeriodo, comMemoria, ErroDeConsulta } = require('./numeracaoSaidas')

// A pausa (da empresa ou da fila) ou o fechamento do app chegou no meio de uma consulta.
class Interrompido extends Error {}

const INTERVALO_MS = 2000
const MARGEM_DO_TRECHO = 20
const SEFAZ_PROPRIA = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP']
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))
const p2 = (n) => String(n).padStart(2, '0')

function criarSaidas({ db, config, logger, buscaAntiga, fabricaConsulta, dormir = dormirPadrao, agora = () => new Date() }) {
  const intervalo = () => (config.sefazMock && config.saidasIntervaloMs != null ? config.saidasIntervaloMs : Math.max(INTERVALO_MS, config.saidasIntervaloMs || INTERVALO_MS))
  const sql = {
    clientes: db.prepare(`SELECT * FROM clientes WHERE cert_arquivo <> '' AND (papel = 'cliente' OR tambem_cliente = 1) ORDER BY COALESCE(NULLIF(apelido, ''), razao_social)`),
    seriesDaTabela: db.prepare('SELECT serie, ultimo_numero FROM saidas_series WHERE cliente_id = ?'),
    seriesDasNotas: db.prepare(`SELECT serie, MAX(CAST(numero AS INTEGER)) AS ultimo FROM notas
      WHERE cliente_id = ? AND modelo = 'nfe' AND emitente_cnpj = ? AND serie IS NOT NULL AND numero IS NOT NULL GROUP BY serie`),
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
  }
  const noPrazo = (c) => !c.cert_validade || new Date(c.cert_validade) >= agora()
  const atendido = (c) => !!UFS[String(c.uf || '').toUpperCase()] && !SEFAZ_PROPRIA.includes(String(c.uf).toUpperCase())

  // Maior número conhecido da série (das notas em que o cliente é emitente, ou de buscas antigas): ponto de partida da busca.
  function partidaDe(cliente, serie) {
    let maior = 0
    for (const s of sql.seriesDaTabela.all(cliente.id)) if (String(Number(s.serie)) === serie) maior = Math.max(maior, s.ultimo_numero)
    for (const n of sql.seriesDasNotas.all(cliente.id, cliente.cnpj)) if (String(Number(n.serie)) === serie) maior = Math.max(maior, n.ultimo)
    return maior
  }

  let emCurso = null
  let parando = false
  let jaConsultou = false
  let clienteProcurado = null

  /** Clientes que podem usar: carteira com A1 no prazo e UF atendida pela SVRS. */
  function listar() {
    return sql.clientes
      .all()
      .filter((c) => noPrazo(c) && atendido(c))
      .map((c) => ({ cnpj: c.cnpj, nome: c.apelido || c.razao_social, pausada: !!c.busca_pausada, procurando: clienteProcurado === c.id }))
  }

  // Para no meio quando o app fecha, quando a empresa é pausada ou quando a fila inteira é pausada.
  const interromper = (cliente) => parando || !!buscaAntiga.pausadaGeral?.() || !!sql.cliente.get(cliente.id)?.busca_pausada
  // 2 s entre quaisquer duas consultas da mesma procura.
  async function esperarVez() {
    if (jaConsultou) await dormir(intervalo())
    jaConsultou = true
  }

  const aammDe = (d) => `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}`

  // Consulta do número `n` da série, já classificada; respeita os 2 s e a pausa (Interrompido).
  function consultorDe(cliente, consulta, serie) {
    const cUF = UFS[cliente.uf.toUpperCase()].codigo
    const aamm = aammDe(agora())
    return async (n) => {
      clienteProcurado = cliente.id
      if (interromper(cliente)) throw new Interrompido()
      await esperarVez()
      if (interromper(cliente)) throw new Interrompido()
      return classificar(await consulta.consultar(montarChave({ cUF, aamm, cnpj: cliente.cnpj, serie, numero: n })))
    }
  }

  function abrirConsulta(cliente) {
    try {
      return fabricaConsulta(cliente)
    } catch (e) {
      logger.warn('Saídas por período: certificado indisponível', { cnpj: cliente.cnpj, erro: e.message })
      return null
    }
  }

  const pedidosSql = {
    ativos: db.prepare("SELECT * FROM saidas_periodos WHERE situacao IN ('na-espera', 'procurando') ORDER BY id"),
    um: db.prepare('SELECT * FROM saidas_periodos WHERE id = ?'),
    criar: db.prepare(`INSERT INTO saidas_periodos (cliente_id, serie, de_aamm, ate_aamm, primeiro, ultimo, proximo, situacao, criado_em, atualizado_em)
      VALUES (@cliente_id, @serie, @de, @ate, @primeiro, @ultimo, @primeiro, @situacao, @agora, @agora)`),
    trecho: db.prepare("UPDATE saidas_periodos SET primeiro = ?, ultimo = ?, proximo = ?, situacao = 'procurando', atualizado_em = ? WHERE id = ?"),
    andou: db.prepare('UPDATE saidas_periodos SET proximo = ?, achadas = achadas + ?, erro = NULL, atualizado_em = ? WHERE id = ?'),
    fim: db.prepare('UPDATE saidas_periodos SET situacao = ?, erro = ?, atualizado_em = ? WHERE id = ?'),
    erro: db.prepare('UPDATE saidas_periodos SET erro = ?, atualizado_em = ? WHERE id = ?'),
    excluir: db.prepare('DELETE FROM saidas_periodos WHERE id = ?'),
    noApp: db.prepare('SELECT 1 FROM notas WHERE cliente_id = ? AND chave = ?'),
    ativoIgual: db.prepare("SELECT 1 FROM saidas_periodos WHERE cliente_id = ? AND serie = ? AND de_aamm = ? AND ate_aamm = ? AND situacao IN ('na-espera', 'procurando')"),
    listar: db.prepare(`SELECT p.*, c.cnpj, COALESCE(NULLIF(c.apelido, ''), c.razao_social) AS nome FROM saidas_periodos p JOIN clientes c ON c.id = p.cliente_id
      WHERE p.situacao <> 'concluido' OR p.atualizado_em >= ? ORDER BY p.id DESC`),
  }

  /** Meses que a consulta alcança: do mês atual menos 5 até o atual (AAMM). */
  function janela() {
    const d = agora()
    return { de: aammDe(new Date(d.getFullYear(), d.getMonth() - 5, 1)), ate: aammDe(d) }
  }

  function validarPedido({ clienteId, de, ate, serie }) {
    const j = janela()
    if (!/^\d{4}$/.test(String(de)) || !/^\d{4}$/.test(String(ate)) || de < j.de || ate > j.ate) throw new Error('Escolha meses dos últimos 6 meses: antes disso, só pelo SPED.')
    if (ate < de) throw new Error('O mês de Até precisa ser igual ou depois do mês de De.')
    if (!/^\d{1,3}$/.test(String(serie ?? '').trim())) throw new Error('Série: use um número de 0 a 999.')
    const cliente = sql.cliente.get(clienteId)
    if (!cliente || !cliente.cert_arquivo || !noPrazo(cliente) || !atendido(cliente)) throw new Error('Esta empresa não pode usar: precisa de A1 no prazo e de estado atendido pela SVRS.')
    return { cliente, serie: String(Number(serie)) }
  }

  async function trechoDoPeriodo(cliente, consulta, serie, de, ate) {
    const consultar = comMemoria(consultorDe(cliente, consulta, serie))
    const ultimo = await acharUltimo(consultar, { partida: partidaDe(cliente, serie) })
    return ultimo ? acharPeriodo(consultar, { de, ate, ultimo }) : null
  }

  // Uma tarefa dentro da procura única do app. Quem chegou enquanto ela rodava (pedido na espera, o horário da
  // captura) ganha uma procura logo depois, sem esperar o próximo ciclo.
  let procuraPendente = false
  let tipoEmCurso = null
  function naVez(tarefa, tipo) {
    jaConsultou = false
    tipoEmCurso = tipo
    emCurso = (async () => tarefa())().finally(() => {
      emCurso = null
      tipoEmCurso = null
      clienteProcurado = null
      if (procuraPendente && !parando) {
        procuraPendente = false
        setImmediate(() => procurar().catch((e) => logger.warn('Saídas por período falharam', { erro: e.message })))
      }
    })
    return emCurso
  }

  // Nota com data fora de ordem (retroativa, contingência) pode cair na fronteira da busca binária: o pedido consulta
  // também 20 números antes e depois do trecho; o filtro por mês deixa só as do período.
  const comMargem = (t) => ({ primeiro: Math.max(1, t.primeiro - MARGEM_DO_TRECHO), ultimo: t.ultimo + MARGEM_DO_TRECHO })

  // Pedido com o trecho achado (mais a margem): roda na procura logo depois da tarefa atual.
  function criarPedido(clienteId, serie, de, ate, trecho) {
    const m = comMargem(trecho)
    const id = Number(pedidosSql.criar.run({ cliente_id: clienteId, serie, de, ate, primeiro: m.primeiro, ultimo: m.ultimo, situacao: 'procurando', agora: agora().toISOString() }).lastInsertRowid)
    procuraPendente = true
    return id
  }

  /** Buscar o período: acha o trecho e já põe o pedido em andamento. Com outra procura rodando, entra na espera. */
  async function pedirPeriodo({ clienteId, de, ate, serie }) {
    const v = validarPedido({ clienteId, de, ate, serie })
    if (parando) throw new Error('O app está fechando.')
    if (pedidosSql.ativoIgual.get(v.cliente.id, v.serie, de, ate)) throw new Error('Já existe um pedido igual em andamento.')
    if (emCurso) {
      const id = Number(pedidosSql.criar.run({ cliente_id: v.cliente.id, serie: v.serie, de, ate, primeiro: null, ultimo: null, situacao: 'na-espera', agora: agora().toISOString() }).lastInsertRowid)
      procuraPendente = true
      return { naEspera: true, id }
    }
    const consulta = abrirConsulta(v.cliente)
    if (!consulta) throw new Error('O certificado desta empresa não abriu.')
    return naVez(async () => {
      try {
        const t = await trechoDoPeriodo(v.cliente, consulta, v.serie, de, ate)
        if (!t) return { nenhuma: true, motivo: 'nenhuma nota no período' }
        const id = criarPedido(v.cliente.id, v.serie, de, ate, t)
        return { id, serie: v.serie, primeiro: t.primeiro, ultimo: t.ultimo, estimadas: t.ultimo - t.primeiro + 1, foraDaJanela: t.foraDaJanela }
      } catch (e) {
        if (e instanceof Interrompido) throw new Error('A busca foi pausada.')
        throw e
      }
    }, 'pedido')
  }

  const excluirPeriodo = (id) => pedidosSql.excluir.run(id).changes > 0

  function listarPeriodos() {
    const semana = new Date(agora().getTime() - 7 * 864e5).toISOString()
    return pedidosSql.listar.all(semana).map((p) => ({
      id: p.id, cnpj: p.cnpj, nome: p.nome, serie: p.serie, de_aamm: p.de_aamm, ate_aamm: p.ate_aamm,
      primeiro: p.primeiro, ultimo: p.ultimo, proximo: p.proximo, achadas: p.achadas, situacao: p.situacao, erro: p.erro, atualizado_em: p.atualizado_em,
    }))
  }

  // Um pedido: acha o trecho se ainda não tem e consulta de `proximo` até `ultimo`, gravando a cada número.
  // Devolve true quando a procura inteira precisa parar (656, app fechando, fila pausada).
  async function rodarPedido(p) {
    const cliente = sql.cliente.get(p.cliente_id)
    const iso = () => agora().toISOString()
    if (!cliente || !noPrazo(cliente) || !atendido(cliente)) {
      pedidosSql.fim.run('erro', 'Esta empresa não pode usar: precisa de A1 no prazo e de estado atendido pela SVRS.', iso(), p.id)
      return false
    }
    if (cliente.busca_pausada) return false
    const consulta = abrirConsulta(cliente)
    if (!consulta) {
      pedidosSql.erro.run('O certificado desta empresa não abriu.', iso(), p.id)
      return false
    }
    try {
      if (p.primeiro == null) {
        const t = await trechoDoPeriodo(cliente, consulta, p.serie, p.de_aamm, p.ate_aamm)
        if (!t) {
          pedidosSql.fim.run('concluido', 'nenhuma nota no período', iso(), p.id)
          return false
        }
        const m = comMargem(t)
        pedidosSql.trecho.run(m.primeiro, m.ultimo, m.primeiro, iso(), p.id)
        p = pedidosSql.um.get(p.id)
      }
      const consultar = consultorDe(cliente, consulta, p.serie)
      for (let n = p.proximo; n <= p.ultimo; n++) {
        // Pedido excluído no meio: para de consultar.
        if (!pedidosSql.um.get(p.id)) return false
        const r = await consultar(n)
        if (r.tipo === 'parar') throw new ErroDeConsulta(`${r.mensagem} — continua no próximo horário`, true)
        if (r.tipo === 'erro') throw new ErroDeConsulta(r.mensagem)
        const noPeriodo = r.tipo === 'existe' && r.aamm >= p.de_aamm && r.aamm <= p.ate_aamm
        // A nota que já está no app não entra na fila (não gasta a vez de 1 minuto da SVRS).
        if (noPeriodo && !pedidosSql.noApp.get(cliente.id, r.chave)) buscaAntiga.adicionarChaves(cliente.id, [{ chave: r.chave, direcao: 'saida' }], { origem: 'periodo' })
        if (!pedidosSql.andou.run(n + 1, noPeriodo ? 1 : 0, iso(), p.id).changes) return false
      }
      pedidosSql.fim.run('concluido', null, iso(), p.id)
      return false
    } catch (e) {
      if (e instanceof Interrompido) return parando || !!buscaAntiga.pausadaGeral?.()
      if (!(e instanceof ErroDeConsulta)) throw e
      if (e.parar) {
        pedidosSql.erro.run(e.message, iso(), p.id)
        return true
      }
      pedidosSql.fim.run('erro', e.message, iso(), p.id)
      return false
    }
  }

  /** Roda os pedidos por período em andamento (depois de um Buscar e depois de cada captura). Uma procura por vez. */
  function procurar() {
    if (emCurso) {
      // Chegou durante um Buscar: roda logo que ele terminar (senão só no próximo ciclo).
      if (tipoEmCurso !== 'procura') procuraPendente = true
      return emCurso
    }
    if (parando) return Promise.resolve({ pedidos: 0 })
    return naVez(async () => {
      const resumo = { pedidos: 0 }
      // Inclusive os que entraram na espera durante esta procura.
      for (let p = pedidosSql.ativos.get(); p; ) {
        if (parando || buscaAntiga.pausadaGeral?.()) break
        resumo.pedidos++
        if (await rodarPedido(p)) break
        p = pedidosSql.ativos.all().find((q) => q.id > p.id)
      }
      return resumo
    }, 'procura')
  }

  /** Ao fechar o app: nenhuma consulta nova; devolve a procura em curso para esperar a gravação do pedido. */
  function parar() {
    parando = true
    return emCurso || Promise.resolve()
  }

  return { listar, procurar, parar, rodando: () => !!emCurso, janela, pedirPeriodo, excluirPeriodo, listarPeriodos }
}

module.exports = { criarSaidas }
