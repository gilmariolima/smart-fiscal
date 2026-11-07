'use strict'

// Horários da busca automática, guardados na tabela `sistema` (valem na hora, sem reiniciar):
// "HH:MM" escolhidos no painel (lista vazia = nenhum horário); sem nada gravado vale o CRON_CAPTURA do .env.
// Quem entra em cada horário é a escolha de cada cliente (auto_nfe / auto_nfse / auto_cte); não há chave geral.
// O escritório não dá ciência: quem dá é o dono da empresa, e o XML completo chega depois pela consulta.

const CHAVE_GERAL_ANTIGA = 'captura_automatica'
const CHAVE_HORARIOS = 'horarios_captura'
const MAX_HORARIOS = 12
const HORARIO = /^([01]\d|2[0-3]):[0-5]\d$/

function criarAutomacao({ db, logger }) {
  const ler = db.prepare('SELECT valor FROM sistema WHERE chave = ?')
  const gravar = db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')

  // A chave geral saiu na 1.10.2. Se estava desligada, os clientes ficam desligados: ninguém começa a capturar sozinho.
  const antiga = ler.get(CHAVE_GERAL_ANTIGA)
  if (antiga) {
    db.transaction(() => {
      if (antiga.valor === '0') db.prepare('UPDATE clientes SET auto_nfe = 0, auto_nfse = 0, auto_cte = 0').run()
      db.prepare('DELETE FROM sistema WHERE chave = ?').run(CHAVE_GERAL_ANTIGA)
    })()
    if (antiga.valor === '0') logger?.info('Chave geral da busca automática retirada; estava desligada, os clientes ficaram desligados')
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

  return { horarios, definirHorarios }
}

module.exports = { criarAutomacao }
