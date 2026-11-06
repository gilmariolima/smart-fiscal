'use strict'

// Organização das pastas ao abrir, em processo próprio (utilityProcess): mover milhares de arquivos é síncrono e,
// no processo principal, a janela pararia de responder. Falhar aqui não impede a abertura: o app tenta de novo depois.

const { obterConfig } = require('../src/config')
const { abrirBanco } = require('../src/db')
const { criarLogger } = require('../src/logger')
const { criarServicoPastas } = require('../src/services/pastas')
const { migrarLayouts, limparResumosDeNotasCompletas, VERSAO_XML } = require('../src/services/migracaoPastas')

const INTERVALO_DO_ANDAMENTO_MS = 500

/**
 * @param {object} p
 * @param {(aviso: { tipo: 'inicio' } | { tipo: 'andamento', movidos: number }) => void} p.avisar
 */
function organizar({ config = obterConfig(), avisar = () => {}, agora = Date.now } = {}) {
  const logger = criarLogger({ pasta: config.pastaLogs, nivelConsole: 'error' })
  const db = abrirBanco(config.caminhoBanco)
  try {
    criarServicoPastas({ db, config, logger }) // aplica a pasta escolhida
    const valor = (chave) => db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(chave)
    const temXml = db.prepare('SELECT 1 FROM notas WHERE caminho_xml IS NOT NULL UNION ALL SELECT 1 FROM eventos WHERE caminho_xml IS NOT NULL LIMIT 1').get()
    if (temXml && (valor('pastas_layout') !== VERSAO_XML || !valor('resumos_limpos'))) avisar({ tipo: 'inicio' })
    let ultimo = 0
    const aoAvancar = (movidos) => {
      if (agora() - ultimo < INTERVALO_DO_ANDAMENTO_MS) return
      ultimo = agora()
      avisar({ tipo: 'andamento', movidos })
    }
    const r = migrarLayouts({ db, pastaXmls: config.pastaXmls, logger, fsOps: { aoAvancar } })
    limparResumosDeNotasCompletas({ db, pastaXmls: config.pastaXmls, logger })
    return r
  } finally {
    db.close()
  }
}

if (process.parentPort) {
  try {
    organizar({ avisar: (aviso) => process.parentPort.postMessage(aviso) })
  } catch (e) {
    process.parentPort.postMessage({ tipo: 'erro', mensagem: e.message })
  }
  process.exit(0)
}

module.exports = { organizar }
