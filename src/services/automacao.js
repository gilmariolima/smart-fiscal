'use strict'

// Automação guardada na tabela `sistema` (vale na hora, sem reiniciar):
// - captura: o agendador busca as notas sozinho nos horários escolhidos. Começa ligada.
// - horarios: "HH:MM" escolhidos no painel (lista vazia = nenhum horário); sem nada gravado vale o CRON_CAPTURA do .env.
// O escritório não dá ciência: quem dá é o dono da empresa, e o XML completo chega depois pela consulta.

const CHAVES = { captura: 'captura_automatica' }
const CHAVE_HORARIOS = 'horarios_captura'
const MAX_HORARIOS = 12
const HORARIO = /^([01]\d|2[0-3]):[0-5]\d$/

function criarAutomacao({ db, logger }) {
  const ler = db.prepare('SELECT valor FROM sistema WHERE chave = ?')
  const gravar = db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')

  function obter() {
    const ligada = (nome) => ler.get(CHAVES[nome])?.valor !== '0'
    return { captura: ligada('captura') }
  }

  /** @param {{captura?: boolean}} mudancas */
  function definir(mudancas) {
    for (const [nome, valor] of Object.entries(mudancas)) {
      if (!CHAVES[nome]) throw new Error(`Automação desconhecida: ${nome}`)
      if (typeof valor !== 'boolean') throw new Error(`Valor inválido para ${nome}: use ligado ou desligado.`)
      gravar.run(CHAVES[nome], valor ? '1' : '0')
      logger?.info(`Busca automática ${valor ? 'ligada' : 'desligada'}`)
    }
    return obter()
  }

  /** @returns {string[]|null} horários "HH:MM" em ordem, ou null se nunca foram escolhidos */
  function horarios() {
    const valor = ler.get(CHAVE_HORARIOS)?.valor
    if (valor === undefined) return null
    return valor ? valor.split(',') : []
  }

  /** @param {string[]} lista */
  function definirHorarios(lista) {
    if (!Array.isArray(lista)) throw new Error('Envie a lista de horários.')
    const invalido = lista.find((h) => !HORARIO.test(String(h)))
    if (invalido !== undefined) throw new Error(`Horário inválido: ${invalido}. Use HH:MM.`)
    const unicos = [...new Set(lista)].sort()
    if (unicos.length > MAX_HORARIOS) throw new Error(`No máximo ${MAX_HORARIOS} horários por dia.`)
    gravar.run(CHAVE_HORARIOS, unicos.join(','))
    logger?.info('Horários da busca automática', { horarios: unicos })
    return unicos
  }

  return { obter, definir, horarios, definirHorarios }
}

module.exports = { criarAutomacao }
