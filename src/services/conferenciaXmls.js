'use strict'

// Conferência ao abrir o app: todo XML que o banco conhece está no disco?
// Só lê e anota no log (quantidades, sem nomes): depois de reorganizar pastas, é o que prova que nada se perdeu.

const fsp = require('node:fs/promises')
const path = require('node:path')

function criarConferenciaXmls({ db, config, logger }) {
  let parada = false
  let emCurso = null

  const existe = (caminho) => fsp.access(caminho).then(() => true, () => false)

  // Uma leitura por vez e sem travar: em pasta de rede pode levar minutos, com o app em uso.
  async function contarFaltando(tabela) {
    const caminhos = db.prepare(`SELECT caminho_xml FROM ${tabela} WHERE caminho_xml IS NOT NULL`).pluck().all()
    let faltando = 0
    for (const caminho of caminhos) {
      if (parada) return null
      if (!(await existe(path.join(config.pastaXmls, caminho)))) faltando++
    }
    return { conferidos: caminhos.length, faltando }
  }

  async function executar() {
    // Pasta de rede desconectada faltaria inteira: não é arquivo perdido.
    if (!(await existe(config.pastaXmls))) {
      logger.info('Conferência dos XMLs pulada: pasta indisponível')
      return { pulada: true }
    }
    const notas = parada ? null : await contarFaltando('notas')
    const eventos = notas && (await contarFaltando('eventos'))
    if (!eventos) return { interrompida: true }
    const conferidos = notas.conferidos + eventos.conferidos
    const faltando = notas.faltando + eventos.faltando
    if (faltando) logger.warn('Conferência dos XMLs: há arquivos faltando no disco', { conferidos, faltando, notasFaltando: notas.faltando, eventosFaltando: eventos.faltando })
    else logger.info('Conferência dos XMLs: todos no disco', { conferidos })
    return { conferidos, faltando }
  }

  function conferir() {
    emCurso = executar()
      .catch((e) => {
        logger.error('Erro na conferência dos XMLs', { erro: e.message })
        return { erro: e.message }
      })
      .finally(() => {
        emCurso = null
      })
    return emCurso
  }

  /** Para antes de o banco fechar. */
  function parar() {
    parada = true
    return emCurso || Promise.resolve()
  }

  return { conferir, parar }
}

module.exports = { criarConferenciaXmls }
