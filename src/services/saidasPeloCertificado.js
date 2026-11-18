'use strict'

// "Saídas pelo certificado": descobre as chaves das NF-e de saída do cliente pelo número, na consulta de protocolo
// da SEFAZ (a chave montada com um código qualquer volta com 613 e a chave verdadeira), e põe na fila da Busca por chave,
// que baixa o XML pela SVRS com o certificado do próprio cliente. Alcança só os últimos 6 meses (cStat 526).

const { montarChave } = require('../sefaz/consultaProtocolo')
const { UFS } = require('../sefaz/uf')

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
      ON CONFLICT(cliente_id, serie) DO UPDATE SET ultimo_numero = excluded.ultimo_numero, achadas = saidas_series.achadas + excluded.achadas,
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
      if (i) await dormir(intervalo())
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

  let emCurso = null
  /** Procura as saídas dos clientes ligados (ou de um só). Uma busca por vez: chamada em dobro devolve a mesma. */
  function procurar({ clienteId } = {}) {
    if (emCurso) return emCurso
    emCurso = (async () => {
      const resumo = { clientes: 0, achadas: 0 }
      const d = agora()
      const aamm = `${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}`
      for (const cliente of sql.clientes.all()) {
        if (clienteId && cliente.id !== clienteId) continue
        if (!cliente.saidas_auto || cliente.busca_pausada || !noPrazo(cliente) || !atendido(cliente)) continue
        let consulta
        try {
          consulta = fabricaConsulta(cliente)
        } catch (e) {
          logger.warn('Saídas pelo certificado: certificado indisponível', { cnpj: cliente.cnpj, erro: e.message })
          continue
        }
        resumo.clientes++
        for (const s of series(cliente)) {
          const r = await procurarSerie(cliente, consulta, s, aamm)
          resumo.achadas += r.achadas
          if (r.parar) return resumo
        }
      }
      if (resumo.achadas) logger.info('Saídas pelo certificado: chaves achadas', resumo)
      return resumo
    })().finally(() => {
      emCurso = null
    })
    return emCurso
  }

  return { listar, ligar, definirInicio, procurar, rodando: () => !!emCurso }
}

module.exports = { criarSaidas }
