'use strict'

// Chaves de automação, guardadas na tabela `sistema` (valem na hora, sem reiniciar):
// - captura: o agendador busca os resumos sozinho no horário do CRON_CAPTURA;
// - ciencia: o ciclo envia a ciência sozinho (desligada, só pelo botão "Dar ciência" ou `ciencia`).
// As duas começam ligadas.

const CHAVES = { captura: 'captura_automatica', ciencia: 'ciencia_automatica' }

function criarAutomacao({ db, logger }) {
  const ler = db.prepare('SELECT valor FROM sistema WHERE chave = ?')
  const gravar = db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')

  function obter() {
    const ligada = (nome) => ler.get(CHAVES[nome])?.valor !== '0'
    return { captura: ligada('captura'), ciencia: ligada('ciencia') }
  }

  /** @param {{captura?: boolean, ciencia?: boolean}} mudancas */
  function definir(mudancas) {
    for (const [nome, valor] of Object.entries(mudancas)) {
      if (!CHAVES[nome]) throw new Error(`Automação desconhecida: ${nome}`)
      if (typeof valor !== 'boolean') throw new Error(`Valor inválido para ${nome}: use ligado ou desligado.`)
      gravar.run(CHAVES[nome], valor ? '1' : '0')
      logger?.info(`${nome === 'captura' ? 'Busca' : 'Ciência'} automática ${valor ? 'ligada' : 'desligada'}`)
    }
    return obter()
  }

  return { obter, definir }
}

module.exports = { criarAutomacao }
