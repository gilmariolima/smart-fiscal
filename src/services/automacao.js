'use strict'

// Automação guardada na tabela `sistema` (vale na hora, sem reiniciar):
// - captura: o agendador busca as notas sozinho no horário do CRON_CAPTURA. Começa ligada.
// O escritório não dá ciência: quem dá é o dono da empresa, e o XML completo chega depois pela consulta.

const CHAVES = { captura: 'captura_automatica' }

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

  return { obter, definir }
}

module.exports = { criarAutomacao }
