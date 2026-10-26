'use strict'

// Pastas que podem sair da pasta de dados (tela Pastas): os XMLs das notas e os ZIPs exportados.
// Banco, certificados e .env (MASTER_KEY) ficam sempre na pasta de dados.
// A escolha fica na tabela `sistema` e vale mais que o PASTA_XMLS/PASTA_EXPORTS do .env.
// Trocar a pasta leva os arquivos junto: só os do Smart Fiscal (.xml / .zip), para nunca
// apagar outra coisa que esteja na pasta antiga.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const TIPOS = {
  xmls: { chave: 'pasta_xmls', campo: 'pastaXmls', nome: 'XMLs das notas', arquivo: (rel) => rel.toLowerCase().endsWith('.xml') },
  exports: { chave: 'pasta_exports', campo: 'pastaExports', nome: 'Exportações', arquivo: (rel) => !rel.includes(path.sep) && rel.toLowerCase().endsWith('.zip') },
}

/** Caminho completo no Windows (C:\..., \\servidor\...) ou no Linux/macOS (/...). */
const caminhoCompleto = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p)
/** `p` é `base` ou fica dentro dela. */
const dentroDe = (base, p) => {
  if (!base) return false
  const rel = path.relative(base, p)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function criarServicoPastas({ db, config, logger }) {
  const sql = {
    ler: db.prepare('SELECT valor FROM sistema WHERE chave = ?'),
    gravar: db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
  }
  const padrao = { xmls: config.pastasPadrao?.xmls ?? config.pastaXmls, exports: config.pastasPadrao?.exports ?? config.pastaExports }
  for (const [tipo, t] of Object.entries(TIPOS)) {
    const salva = sql.ler.get(t.chave)?.valor
    if (salva) config[t.campo] = salva
  }
  let movendo = null

  function estado() {
    return {
      movendo: movendo?.tipo || null,
      pastas: Object.entries(TIPOS).map(([tipo, t]) => ({
        tipo,
        nome: t.nome,
        pasta: config[t.campo],
        padrao: padrao[tipo],
        ehPadrao: path.resolve(config[t.campo]) === path.resolve(padrao[tipo]),
      })),
    }
  }

  function aplicar(t, pasta, ehPadrao) {
    config[t.campo] = pasta
    sql.gravar.run(t.chave, ehPadrao ? '' : pasta)
  }

  // Arquivos do Smart Fiscal dentro da pasta (caminhos relativos a ela).
  async function arquivosDe(t, pasta) {
    let itens = []
    try {
      itens = await fsp.readdir(pasta, { recursive: true, withFileTypes: true })
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    return itens.filter((i) => i.isFile()).map((i) => path.relative(pasta, path.join(i.parentPath, i.name))).filter(t.arquivo)
  }

  // Copia sem substituir o que já está no destino, mantendo a data do arquivo.
  async function copiar(de, para, relativos) {
    for (const rel of relativos) {
      const origem = path.join(de, rel)
      const alvo = path.join(para, rel)
      await fsp.mkdir(path.dirname(alvo), { recursive: true })
      try {
        await fsp.copyFile(origem, alvo, fs.constants.COPYFILE_EXCL)
      } catch (e) {
        if (e.code === 'EEXIST') continue
        throw e
      }
      const { atime, mtime } = await fsp.stat(origem)
      await fsp.utimes(alvo, atime, mtime)
    }
  }

  // Apaga as subpastas que ficaram vazias (a pasta em si fica).
  async function limparVazias(pasta) {
    let itens = []
    try {
      itens = await fsp.readdir(pasta, { recursive: true, withFileTypes: true })
    } catch {
      return
    }
    const dirs = itens.filter((i) => i.isDirectory()).map((i) => path.join(i.parentPath, i.name))
    dirs.sort((a, b) => b.length - a.length)
    for (const d of dirs) await fsp.rmdir(d).catch(() => {})
  }

  /**
   * Troca a pasta ('' volta para a padrão) e leva os arquivos para ela.
   * O caminho novo passa a valer antes da cópia: o que for baixado durante a mudança já vai para lá.
   * @returns {Promise<{ pasta, movidos, mudou }>}
   */
  async function mudar(tipo, valor) {
    const t = TIPOS[tipo]
    if (!t) throw new Error('Pasta desconhecida.')
    if (movendo) throw new Error(`Espere terminar de mover a pasta de ${TIPOS[movendo.tipo].nome}.`)
    const texto = String(valor ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (texto && !caminhoCompleto(texto)) throw new Error('Informe o endereço completo da pasta, como D:\\Fiscal\\XMLs ou \\\\servidor\\fiscal\\XMLs.')
    const nova = path.resolve(texto || padrao[tipo])
    const ehPadrao = nova === path.resolve(padrao[tipo])
    const atual = path.resolve(config[t.campo])
    if (nova === atual) return { pasta: nova, movidos: 0, mudou: false }
    if (dentroDe(atual, nova) || dentroDe(nova, atual)) throw new Error('A pasta nova não pode ficar dentro da atual (nem a atual dentro da nova).')
    if (!ehPadrao && (dentroDe(config.raiz, nova) || dentroDe(config.pastaEstoque, nova))) {
      throw new Error('Escolha uma pasta fora da pasta de dados do Smart Fiscal (ou volte para a padrão).')
    }
    const outra = Object.values(TIPOS).find((o) => o !== t && config[o.campo] && (dentroDe(config[o.campo], nova) || dentroDe(nova, config[o.campo])))
    if (outra) throw new Error(`Essa pasta se mistura com a de ${outra.nome.toLowerCase()}: use uma pasta só para cada uma.`)
    try {
      fs.mkdirSync(nova, { recursive: true })
      const teste = path.join(nova, `.teste-smart-fiscal-${process.pid}`)
      fs.writeFileSync(teste, 'ok')
      fs.rmSync(teste, { force: true })
    } catch (e) {
      throw new Error(`Não consegui gravar na pasta ${nova} (${e.code || e.message}). Confira o endereço e a permissão.`)
    }

    const tarefa = (async () => {
      const relativos = await arquivosDe(t, atual)
      aplicar(t, nova, ehPadrao)
      try {
        await copiar(atual, nova, relativos)
      } catch (e) {
        // Volta para a pasta antiga, que ainda tem tudo; o que já chegou na nova fica lá (e volta, se der).
        aplicar(t, atual, path.resolve(padrao[tipo]) === atual)
        await copiar(nova, atual, await arquivosDe(t, nova)).catch(() => {})
        logger.error('Falha ao mover a pasta', { tipo, de: atual, para: nova, erro: e.message })
        throw new Error(`Não consegui copiar os arquivos para ${nova} (${e.code || e.message}). Nada mudou: continua em ${atual}.`)
      }
      for (const rel of relativos) await fsp.rm(path.join(atual, rel), { force: true })
      await limparVazias(atual)
      logger.info('Pasta trocada', { tipo, de: atual, para: nova, arquivos: relativos.length })
      return { pasta: nova, movidos: relativos.length, mudou: true }
    })()
    movendo = { tipo, tarefa }
    try {
      return await tarefa
    } finally {
      movendo = null
    }
  }

  return { estado, mudar, TIPOS }
}

module.exports = { criarServicoPastas }
