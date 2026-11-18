'use strict'

// Buscas na numeração das NF-e de saída de uma série, sobre a consulta de protocolo (`consultar(n)` já classificado):
// o último número emitido e o trecho de números de um intervalo de meses. A numeração sobe com o tempo, então o
// mês da nota cresce com o número e as buscas são binárias. Números inutilizados (217 no meio) têm 5 de folga.

const FOLGA_FURO = 5
const MAXIMO_NUMERO = 999999999 // nNF tem 9 dígitos

class ErroDeConsulta extends Error {
  constructor(mensagem, parar = false) {
    super(mensagem)
    this.parar = parar
  }
}

/** Retorno de `consulta.consultar(chave)` → existe (613, com o AAMM da chave verdadeira) | antiga (526) | nao-existe (217) | parar (656) | erro. */
function classificar(r) {
  if (!r || r.erro) return { tipo: 'erro', mensagem: r?.erro || 'sem resposta da SEFAZ' }
  if (r.cStat === '613' && r.chaveVerdadeira) return { tipo: 'existe', aamm: r.chaveVerdadeira.slice(2, 6), chave: r.chaveVerdadeira }
  if (r.cStat === '526') return { tipo: 'antiga' }
  if (r.cStat === '217') return { tipo: 'nao-existe' }
  if (r.cStat === '656') return { tipo: 'parar', mensagem: `SEFAZ: 656 ${r.xMotivo || 'consumo indevido'}` }
  return { tipo: 'erro', mensagem: `SEFAZ: ${r.cStat || '?'} ${r.xMotivo || ''}`.trim() }
}

const existe = (r) => r.tipo === 'existe' || r.tipo === 'antiga'

// Cada número é consultado uma vez só por busca; 656 e erro interrompem com ErroDeConsulta.
function comMemoria(consultar) {
  if (consultar.memoria) return consultar
  const vistos = new Map()
  const c = async (n) => {
    if (!vistos.has(n)) {
      const r = await consultar(n)
      if (r.tipo === 'parar') throw new ErroDeConsulta(r.mensagem, true)
      if (r.tipo === 'erro') throw new ErroDeConsulta(r.mensagem, false)
      vistos.set(n, r)
    }
    return vistos.get(n)
  }
  c.memoria = true
  return c
}

async function primeiroQueExiste(c, de, ate) {
  for (let n = de; n <= ate; n++) if (existe(await c(n))) return n
  return null
}

/** Último número emitido da série (0 quando não há nenhum). `partida`: maior número já conhecido. */
async function acharUltimo(consultar, { partida = 0 } = {}) {
  const c = comMemoria(consultar)
  let base = Math.max(partida, 1)
  if (!existe(await c(base))) {
    const vizinho = await primeiroQueExiste(c, base + 1, base + FOLGA_FURO)
    // Partida que a SEFAZ não conhece (nota de outro ambiente, número digitado errado): recomeça do 1.
    if (vizinho === null && base > 1) return acharUltimo(c)
    if (vizinho === null) return 0
    base = vizinho
  }
  for (;;) {
    // Sobe dobrando o passo até um número que não existe; depois aperta entre os dois.
    let baixo = base
    let alto
    for (let passo = 1; ; passo *= 2) {
      if (baixo + passo > MAXIMO_NUMERO) {
        alto = MAXIMO_NUMERO + 1
        break
      }
      if (existe(await c(baixo + passo))) baixo += passo
      else {
        alto = baixo + passo
        break
      }
    }
    while (alto - baixo > 1) {
      const m = Math.floor((baixo + alto) / 2)
      if (existe(await c(m))) baixo = m
      else alto = m
    }
    // O 217 pode ser um furo: se um dos 5 seguintes existe, a numeração continua dali.
    const depois = await primeiroQueExiste(c, baixo + 1, baixo + FOLGA_FURO)
    if (depois === null) return baixo
    base = depois
  }
}

// Número que existe perto de `m` dentro de [lo, hi]: o próprio, os 5 seguintes, os 5 anteriores.
// Sem nenhum: null se isso cobriu o intervalo inteiro (nada a achar ali), senão é um furo grande.
async function pontoQueExiste(c, m, lo, hi) {
  for (let n = m; n <= Math.min(hi, m + FOLGA_FURO); n++) {
    const r = await c(n)
    if (existe(r)) return { n, r }
  }
  for (let n = m - 1; n >= Math.max(lo, m - FOLGA_FURO); n--) {
    const r = await c(n)
    if (existe(r)) return { n, r }
  }
  if (lo >= m - FOLGA_FURO && hi <= m + FOLGA_FURO) return null
  throw new ErroDeConsulta(`numeração com furo grande perto do nº ${m}`)
}

/** Primeiro e último número com mês em [de, ate] (AAMM), dentro de [1, ultimo]; null sem nota no período. */
async function acharPeriodo(consultar, { de, ate, ultimo }) {
  const c = comMemoria(consultar)
  const desdeDe = (r) => r.tipo === 'existe' && r.aamm >= de
  const ateAte = (r) => r.tipo === 'antiga' || r.aamm <= ate

  let primeiro = null
  for (let lo = 1, hi = ultimo; lo <= hi; ) {
    const p = await pontoQueExiste(c, Math.floor((lo + hi) / 2), lo, hi)
    if (!p) break
    if (desdeDe(p.r)) {
      primeiro = p
      hi = p.n - 1
    } else lo = p.n + 1
  }
  if (!primeiro || !ateAte(primeiro.r)) return null

  let fim = primeiro.n
  for (let lo = primeiro.n + 1, hi = ultimo; lo <= hi; ) {
    const p = await pontoQueExiste(c, Math.floor((lo + hi) / 2), lo, hi)
    if (!p) break
    if (ateAte(p.r)) {
      fim = p.n
      lo = p.n + 1
    } else hi = p.n - 1
  }

  // Aviso de janela: a nota existente logo antes do período já passou dos 6 meses.
  let foraDaJanela = false
  for (let n = primeiro.n - 1; n >= Math.max(1, primeiro.n - FOLGA_FURO); n--) {
    const r = await c(n)
    if (existe(r)) {
      foraDaJanela = r.tipo === 'antiga'
      break
    }
  }
  return { primeiro: primeiro.n, ultimo: fim, foraDaJanela }
}

module.exports = { classificar, acharUltimo, acharPeriodo, comMemoria, ErroDeConsulta, FOLGA_FURO }
