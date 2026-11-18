'use strict'

// "Saídas pelo certificado": descobre as chaves das NF-e de saída do cliente pelo número, na consulta de protocolo
// da SEFAZ (a chave montada com um código qualquer volta com 613 e a chave verdadeira), e põe na fila da Busca por chave,
// que baixa o XML pela SVRS com o certificado do próprio cliente. Alcança só os últimos 6 meses (cStat 526).

const { montarChave } = require('../sefaz/consultaProtocolo')
const { UFS } = require('../sefaz/uf')
const { classificar, acharUltimo, acharPeriodo, comMemoria, ErroDeConsulta } = require('./numeracaoSaidas')

// A pausa (da empresa ou da fila) ou o fechamento do app chegou no meio de uma consulta.
class Interrompido extends Error {}

const INTERVALO_MS = 2000
// Números inutilizados ou rejeitados dão 217 no meio da sequência: só conclui "fim" depois de vários seguidos.
const INEXISTENTES_PARA_PARAR = 20
const MAXIMO_POR_SERIE = 1000
const SEFAZ_PROPRIA = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP']
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms))
const p2 = (n) => String(n).padStart(2, '0')

function criarSaidas({ db, config, logger, buscaAntiga, fabricaConsulta, dormir = dormirPadrao, agora = () => new Date() }) {
  const intervalo = () => (config.sefazMock && config.saidasIntervaloMs != null ? config.saidasIntervaloMs : Math.max(INTERVALO_MS, config.saidasIntervaloMs || INTERVALO_MS))
  const sql = {
    clientes: db.prepare(`SELECT * FROM clientes WHERE cert_arquivo <> '' AND (papel = 'cliente' OR tambem_cliente = 1) ORDER BY COALESCE(NULLIF(apelido, ''), razao_social)`),
    seriesDaTabela: db.prepare('SELECT * FROM saidas_series WHERE cliente_id = ?'),
    seriesDasNotas: db.prepare(`SELECT serie, MAX(CAST(numero AS INTEGER)) AS ultimo FROM notas
      WHERE cliente_id = ? AND modelo = 'nfe' AND emitente_cnpj = ? AND serie IS NOT NULL AND numero IS NOT NULL GROUP BY serie`),
    gravarSerie: db.prepare(`INSERT INTO saidas_series (cliente_id, serie, ultimo_numero, achadas, ultima_consulta, ultimo_erro) VALUES (@cliente_id, @serie, @ultimo_numero, @achadas, @ultima_consulta, @ultimo_erro)
      ON CONFLICT(cliente_id, serie) DO UPDATE SET ultimo_numero = MAX(saidas_series.ultimo_numero, excluded.ultimo_numero), achadas = saidas_series.achadas + excluded.achadas,
        ultima_consulta = excluded.ultima_consulta, ultimo_erro = excluded.ultimo_erro`),
    inicio: db.prepare(`INSERT INTO saidas_series (cliente_id, serie, ultimo_numero) VALUES (?, ?, ?)
      ON CONFLICT(cliente_id, serie) DO UPDATE SET ultimo_numero = MAX(saidas_series.ultimo_numero, excluded.ultimo_numero)`),
    ligar: db.prepare('UPDATE clientes SET saidas_auto = ? WHERE id = ?'),
    cliente: db.prepare('SELECT * FROM clientes WHERE id = ?'),
  }
  const noPrazo = (c) => !c.cert_validade || new Date(c.cert_validade) >= agora()
  const atendido = (c) => !!UFS[String(c.uf || '').toUpperCase()] && !SEFAZ_PROPRIA.includes(String(c.uf).toUpperCase())

  // Séries do cliente: as já consultadas e as que aparecem nas notas em que ele é emitente; fica o maior número.
  function series(cliente) {
    const porSerie = new Map()
    for (const s of sql.seriesDaTabela.all(cliente.id)) porSerie.set(String(Number(s.serie)), { ...s, serie: String(Number(s.serie)) })
    for (const n of sql.seriesDasNotas.all(cliente.id, cliente.cnpj)) {
      const serie = String(Number(n.serie))
      const atual = porSerie.get(serie)
      if (!atual) porSerie.set(serie, { serie, ultimo_numero: n.ultimo, achadas: 0, ultima_consulta: null, ultimo_erro: null })
      else if (n.ultimo > atual.ultimo_numero) atual.ultimo_numero = n.ultimo
    }
    return [...porSerie.values()].sort((a, b) => Number(a.serie) - Number(b.serie))
  }

  /** Clientes que podem usar: carteira com A1 no prazo e UF atendida pela SVRS. */
  function listar() {
    return sql.clientes
      .all()
      .filter((c) => noPrazo(c) && atendido(c))
      .map((c) => ({ cnpj: c.cnpj, nome: c.apelido || c.razao_social, ligado: !!c.saidas_auto, pausada: !!c.busca_pausada, series: series(c) }))
  }

  const ligar = (clienteId, ligado) => sql.ligar.run(ligado ? 1 : 0, clienteId)

  /** Chave de uma saída do cliente colada pela pessoa: dá o ponto de partida da série e entra na fila. */
  function definirInicio(clienteId, chave) {
    const cliente = sql.cliente.get(clienteId)
    const ch = String(chave || '').replace(/\D/g, '')
    if (!cliente || ch.length !== 44 || ch.slice(20, 22) !== '55') throw new Error('Cole a chave de uma NF-e (44 dígitos).')
    if (ch.slice(6, 20) !== cliente.cnpj) throw new Error('A chave precisa ser de uma NF-e emitida por este cliente.')
    sql.inicio.run(cliente.id, String(Number(ch.slice(22, 25))), Number(ch.slice(25, 34)))
    buscaAntiga.adicionarChaves(cliente.id, [{ chave: ch, direcao: 'saida' }], { origem: 'saidas' })
  }

  let emCurso = null
  let parando = false
  let jaConsultou = false
  // Para no meio quando o app fecha, quando a empresa é pausada ou quando a fila inteira é pausada.
  const interromper = (cliente) => parando || !!buscaAntiga.pausadaGeral?.() || !!sql.cliente.get(cliente.id)?.busca_pausada
  // 2 s entre quaisquer duas consultas da mesma procura (dentro da série, entre séries e entre clientes).
  async function esperarVez() {
    if (jaConsultou) await dormir(intervalo())
    jaConsultou = true
  }

  // Uma série: consulta do número seguinte ao último conhecido até 20 inexistentes seguidos.
  async function procurarSerie(cliente, consulta, s, aamm) {
    const cUF = UFS[cliente.uf.toUpperCase()].codigo
    const achadas = []
    let ultimo = s.ultimo_numero
    let numero = ultimo + 1
    let inexistentes = 0
    let erro = null
    let parar = false
    for (let i = 0; i < MAXIMO_POR_SERIE && inexistentes < INEXISTENTES_PARA_PARAR; i++, numero++) {
      if (interromper(cliente)) break
      await esperarVez()
      if (interromper(cliente)) break
      const r = await consulta.consultar(montarChave({ cUF, aamm, cnpj: cliente.cnpj, serie: s.serie, numero }))
      if (r.cStat === '613' && r.chaveVerdadeira) {
        achadas.push({ chave: r.chaveVerdadeira, direcao: 'saida' })
        ultimo = numero
        inexistentes = 0
      } else if (r.cStat === '217') inexistentes++
      else if (r.cStat === '526') {
        erro = 'A última saída conhecida tem mais de 6 meses: cole uma chave de saída recente'
        break
      } else if (r.cStat === '656') {
        erro = `SEFAZ: 656 ${r.xMotivo || 'consumo indevido'} — tenta de novo no próximo horário`
        parar = true
        break
      } else {
        erro = r.erro || `SEFAZ: ${r.cStat || '?'} ${r.xMotivo || ''}`.trim()
        break
      }
    }
    sql.gravarSerie.run({ cliente_id: cliente.id, serie: s.serie, ultimo_numero: ultimo, achadas: achadas.length, ultima_consulta: agora().toISOString(), ultimo_erro: erro })
    if (achadas.length) buscaAntiga.adicionarChaves(cliente.id, achadas, { origem: 'saidas' })
    return { achadas: achadas.length, parar }
  }

  const aammDe = (d) => `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}`

  // Consulta do número `n` da série, já classificada; respeita os 2 s e a pausa (Interrompido).
  function consultorDe(cliente, consulta, serie) {
    const cUF = UFS[cliente.uf.toUpperCase()].codigo
    const aamm = aammDe(agora())
    return async (n) => {
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
      logger.warn('Saídas pelo certificado: certificado indisponível', { cnpj: cliente.cnpj, erro: e.message })
      return null
    }
  }

  // Interruptor ligado sem nenhuma série conhecida: acha o último número da série 1 e segue dali nas próximas vezes.
  async function comecarSemPartida(cliente, consulta) {
    try {
      const ultimo = await acharUltimo(consultorDe(cliente, consulta, '1'))
      sql.gravarSerie.run({ cliente_id: cliente.id, serie: '1', ultimo_numero: ultimo, achadas: 0, ultima_consulta: agora().toISOString(), ultimo_erro: ultimo ? null : 'nenhuma nota nesta série' })
      return false
    } catch (e) {
      if (e instanceof Interrompido) return false
      if (!(e instanceof ErroDeConsulta)) throw e
      logger.warn('Saídas pelo certificado: último número não achado', { cnpj: cliente.cnpj, erro: e.message })
      return e.parar
    }
  }

  // ---------- pedidos por período ----------

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

  const partidaDe = (cliente, serie) => series(cliente).find((s) => s.serie === serie)?.ultimo_numero || 0

  async function trechoDoPeriodo(cliente, consulta, serie, de, ate) {
    const consultar = comMemoria(consultorDe(cliente, consulta, serie))
    const ultimo = await acharUltimo(consultar, { partida: partidaDe(cliente, serie) })
    return ultimo ? acharPeriodo(consultar, { de, ate, ultimo }) : null
  }

  // Uma tarefa dentro da procura única do app.
  function naVez(tarefa) {
    jaConsultou = false
    emCurso = (async () => tarefa())().finally(() => {
      emCurso = null
    })
    return emCurso
  }

  /** Acha o trecho do período (antes de confirmar). Com outra procura rodando, o pedido entra na espera e roda depois. */
  async function pedirPeriodo({ clienteId, de, ate, serie }) {
    const v = validarPedido({ clienteId, de, ate, serie })
    if (parando) throw new Error('O app está fechando.')
    if (emCurso) {
      const id = Number(pedidosSql.criar.run({ cliente_id: v.cliente.id, serie: v.serie, de, ate, primeiro: null, ultimo: null, situacao: 'na-espera', agora: agora().toISOString() }).lastInsertRowid)
      return { naEspera: true, id }
    }
    const consulta = abrirConsulta(v.cliente)
    if (!consulta) throw new Error('O certificado desta empresa não abriu.')
    return naVez(async () => {
      try {
        const t = await trechoDoPeriodo(v.cliente, consulta, v.serie, de, ate)
        if (!t) return { nenhuma: true, motivo: 'nenhuma nota no período' }
        return { serie: v.serie, primeiro: t.primeiro, ultimo: t.ultimo, estimadas: t.ultimo - t.primeiro + 1, foraDaJanela: t.foraDaJanela }
      } catch (e) {
        if (e instanceof Interrompido) throw new Error('A busca foi pausada.')
        throw e
      }
    })
  }

  /** Grava o pedido confirmado e começa a pôr as chaves na fila. */
  function confirmarPeriodo({ clienteId, de, ate, serie, primeiro, ultimo }) {
    const v = validarPedido({ clienteId, de, ate, serie })
    if (!Number.isInteger(primeiro) || !Number.isInteger(ultimo) || primeiro < 1 || primeiro > ultimo) throw new Error('Trecho de números inválido.')
    const id = Number(pedidosSql.criar.run({ cliente_id: v.cliente.id, serie: v.serie, de, ate, primeiro, ultimo, situacao: 'procurando', agora: agora().toISOString() }).lastInsertRowid)
    procurar().catch((e) => logger.warn('Saídas por período falharam', { erro: e.message }))
    return id
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
        pedidosSql.trecho.run(t.primeiro, t.ultimo, t.primeiro, iso(), p.id)
        p = pedidosSql.um.get(p.id)
      }
      const consultar = consultorDe(cliente, consulta, p.serie)
      for (let n = p.proximo; n <= p.ultimo; n++) {
        const r = await consultar(n)
        if (r.tipo === 'parar') throw new ErroDeConsulta(`${r.mensagem} — continua no próximo horário`, true)
        if (r.tipo === 'erro') throw new ErroDeConsulta(r.mensagem)
        const noPeriodo = r.tipo === 'existe' && r.aamm >= p.de_aamm && r.aamm <= p.ate_aamm
        // A nota que já está no app não entra na fila (não gasta a vez de 1 minuto da SVRS).
        if (noPeriodo && !pedidosSql.noApp.get(cliente.id, r.chave)) buscaAntiga.adicionarChaves(cliente.id, [{ chave: r.chave, direcao: 'saida' }], { origem: 'periodo' })
        pedidosSql.andou.run(n + 1, noPeriodo ? 1 : 0, iso(), p.id)
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

  /** Procura as saídas dos clientes ligados (ou de um só) e depois roda os pedidos por período. Uma busca por vez. */
  function procurar({ clienteId } = {}) {
    if (emCurso) return emCurso
    if (parando) return Promise.resolve({ clientes: 0, achadas: 0 })
    return naVez(async () => {
      const resumo = { clientes: 0, achadas: 0 }
      const aamm = aammDe(agora())
      for (const cliente of sql.clientes.all()) {
        if (parando || buscaAntiga.pausadaGeral?.()) break
        if (clienteId && cliente.id !== clienteId) continue
        if (!cliente.saidas_auto || cliente.busca_pausada || !noPrazo(cliente) || !atendido(cliente)) continue
        const consulta = abrirConsulta(cliente)
        if (!consulta) continue
        resumo.clientes++
        const lista = series(cliente)
        if (!lista.length) {
          if (await comecarSemPartida(cliente, consulta)) return resumo
          continue
        }
        for (const s of lista) {
          if (interromper(cliente)) break
          const r = await procurarSerie(cliente, consulta, s, aamm)
          resumo.achadas += r.achadas
          if (r.parar) return resumo
        }
      }
      if (resumo.achadas) logger.info('Saídas pelo certificado: chaves achadas', resumo)
      // Os pedidos por período: inclusive os que entraram na espera durante esta procura.
      for (let p = pedidosSql.ativos.get(); p; ) {
        if (parando || buscaAntiga.pausadaGeral?.()) break
        if (await rodarPedido(p)) break
        p = pedidosSql.ativos.all().find((q) => q.id > p.id)
      }
      return resumo
    })
  }

  /** Ao fechar o app: nenhuma consulta nova; devolve a procura em curso para esperar a gravação da série. */
  function parar() {
    parando = true
    return emCurso || Promise.resolve()
  }

  return { listar, ligar, definirInicio, procurar, parar, rodando: () => !!emCurso, janela, pedirPeriodo, confirmarPeriodo, excluirPeriodo, listarPeriodos }
}

module.exports = { criarSaidas }
