'use strict'

// Pastas que podem sair da pasta de dados (tela Pastas): os XMLs das notas e os ZIPs exportados.
// Banco, certificados e .env (MASTER_KEY) ficam sempre na pasta de dados.
// A escolha fica na tabela `sistema` e vale mais que o PASTA_XMLS/PASTA_EXPORTS do .env.
// Trocar a pasta leva os arquivos junto: só os do Smart Fiscal (.xml / .zip), para nunca
// apagar outra coisa que esteja na pasta antiga.
// Pasta principal: a pasta escolhida é a própria raiz das empresas (config.pastaXmls).
// Só vale pasta vazia ou que já tem a marca `.smart-fiscal`, gravada depois de validar.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { copiar, recusaDeMesmoArquivo, dormirDeVerdade } = require('./copiaDePastas')

const TIPOS = {
  xmls: { chave: 'pasta_xmls', campo: 'pastaXmls', nome: 'XMLs das notas', arquivo: (rel) => rel.toLowerCase().endsWith('.xml') },
  exports: { chave: 'pasta_exports', campo: 'pastaExports', nome: 'Exportações', arquivo: (rel) => !rel.includes(path.sep) && rel.toLowerCase().endsWith('.zip') },
}

const MARCA = '.smart-fiscal'
// Nomes que o armazenamento grava: chave em dígitos + -nfe, -nfse, -cte, -resumo ou -evento-<tipo>-<seq>.
const NOME_DO_APP = /^\d+-(nfe|nfse|cte|resumo|evento-\d+-\d+)\.xml$/i
const EXTENSOES = ['.xml', '.pdf', '.xlsx', '.zip']
// O Windows cria estes sozinho: não contam para pasta vazia.
const DO_WINDOWS = ['desktop.ini', 'thumbs.db']
const semDoWindows = (nomes) => nomes.filter((n) => !DO_WINDOWS.includes(n.toLowerCase()))
const DIFERENTES_NO_AVISO = 5
// O cache de diretório do cliente SMB esconde arquivo novo por cerca de 10 s.
const ESPERA_DA_SONDA = { intervaloMs: 1000, limiteMs: 15000 }

/** Caminho completo no Windows (C:\..., \\servidor\...) ou no Linux/macOS (/...). */
const caminhoCompleto = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p)
/** `p` é `base` ou fica dentro dela. */
const dentroDe = (base, p) => {
  if (!base) return false
  const rel = path.relative(base, p)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function criarServicoPastas({ db, config, logger, dormir, esperaDaSonda = ESPERA_DA_SONDA }) {
  const sql = {
    ler: db.prepare('SELECT valor FROM sistema WHERE chave = ?'),
    gravar: db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
    caminhos: db.prepare('SELECT caminho_xml FROM notas WHERE caminho_xml IS NOT NULL UNION SELECT caminho_xml FROM eventos WHERE caminho_xml IS NOT NULL'),
    temCaminho: db.prepare('SELECT 1 FROM notas WHERE caminho_xml IS NOT NULL UNION ALL SELECT 1 FROM eventos WHERE caminho_xml IS NOT NULL LIMIT 1'),
  }
  const padrao = { xmls: config.pastasPadrao?.xmls ?? config.pastaXmls, exports: config.pastasPadrao?.exports ?? config.pastaExports }
  for (const [tipo, t] of Object.entries(TIPOS)) {
    const salva = sql.ler.get(t.chave)?.valor
    if (salva) config[t.campo] = salva
  }
  let movendo = null
  let fimDaTroca = Promise.resolve()
  let pararPedido = false
  let ultimaTroca = null
  const aoMudar = new Set()
  const deveParar = () => pararPedido
  const tentativas = dormir ? { dormir } : {}

  function avisarTroca(trocando) {
    for (const cb of aoMudar) {
      try {
        cb(trocando)
      } catch (e) {
        logger.warn('Falha ao avisar da troca de pasta', { erro: e.message })
      }
    }
  }

  /** `cb(true)` no começo de cada troca e `cb(false)` no fim; devolve a função que cancela. */
  function aoMudarTroca(cb) {
    aoMudar.add(cb)
    return () => aoMudar.delete(cb)
  }

  /** Para a troca entre arquivos e espera; depois disso nenhuma troca começa (o app está fechando). */
  function pararTroca() {
    pararPedido = true
    return fimDaTroca
  }

  /** Há pasta principal escolhida (inclusive a antiga …\SMART FISCAL). */
  function temPasta() {
    return Boolean(sql.ler.get('pasta_principal')?.valor)
  }

  /** Há troca de pasta em andamento: nenhuma captura pode começar. */
  function movendoAgora() {
    return movendo !== null
  }

  function estado() {
    return {
      movendo: movendo ? { ...movendo } : null,
      ultimaTroca: ultimaTroca ? { ...ultimaTroca, avisos: [...ultimaTroca.avisos] } : null,
      principal: sql.ler.get('pasta_principal')?.valor || null,
      pastas: Object.entries(TIPOS).map(([tipo, t]) => ({
        tipo,
        nome: t.nome,
        pasta: config[t.campo],
        padrao: padrao[tipo],
        ehPadrao: path.resolve(config[t.campo]) === path.resolve(padrao[tipo]),
      })),
    }
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

  // Tudo que o Smart Fiscal grava na pasta marcada (caminhos relativos a ela).
  async function arquivosComMarca(pasta) {
    const itens = await fsp.readdir(pasta, { recursive: true, withFileTypes: true })
    return itens
      .filter((i) => i.isFile())
      .map((i) => path.relative(pasta, path.join(i.parentPath, i.name)))
      .filter((rel) => EXTENSOES.includes(path.extname(rel).toLowerCase()) && !rel.toLowerCase().endsWith('.tmp'))
  }

  // Sem marca: o que o banco registrou e os .xml com nome de arquivo do app (os resumos não têm caminho no banco).
  // Qualquer outro .xml é de outra pessoa e fica.
  async function arquivosDoBanco(pasta) {
    const itens = await fsp.readdir(pasta, { recursive: true, withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    const rels = new Set()
    const naPasta = new Map() // sem diferenciar maiúsculas, como o Windows
    for (const i of itens) {
      if (!i.isFile()) continue
      const rel = path.relative(pasta, path.join(i.parentPath, i.name))
      naPasta.set(rel.toLowerCase(), rel)
      if (NOME_DO_APP.test(i.name)) rels.add(rel)
    }
    for (const { caminho_xml: c } of sql.caminhos.all()) {
      const rel = path.isAbsolute(c) ? path.relative(pasta, c) : path.normalize(c)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.toLowerCase().endsWith('.tmp')) continue
      const real = naPasta.get(rel.toLowerCase())
      if (real) rels.add(real)
    }
    return [...rels]
  }

  function registradosNoBanco() {
    return Boolean(sql.temCaminho.get())
  }

  // Apaga só as pastas de onde saíram os arquivos levados, se ficaram vazias (a pasta em si fica).
  async function limparVazias(pasta, relativos) {
    const dirs = new Set()
    for (const rel of relativos) {
      for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) dirs.add(d)
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await fsp.rmdir(path.join(pasta, d)).catch(() => {})
  }

  // Marca oculta no Windows; falhar em esconder não impede nada.
  function esconder(arquivo) {
    if (process.platform !== 'win32') return
    try {
      spawnSync('attrib', ['+h', arquivo], { windowsHide: true })
    } catch {}
  }

  // Destino vazio (ou inexistente) ou já com a marca. A marca só é gravada depois disso e prova a permissão de escrita.
  function prepararDestino(nova) {
    const marca = path.join(nova, MARCA)
    if (fs.existsSync(nova)) {
      if (!fs.statSync(nova).isDirectory()) throw new Error(`${nova} não é uma pasta.`)
      if (!fs.existsSync(marca) && semDoWindows(fs.readdirSync(nova)).length) {
        throw new Error('Esta pasta não está vazia e não é do Smart Fiscal. Escolha uma pasta vazia ou crie uma nova.')
      }
    }
    try {
      fs.mkdirSync(nova, { recursive: true })
      if (fs.existsSync(marca)) {
        const teste = path.join(nova, `.teste-smart-fiscal-${process.pid}`)
        fs.writeFileSync(teste, 'ok')
        fs.rmSync(teste, { force: true })
      } else {
        fs.writeFileSync(marca, 'Pasta do Smart Fiscal. Não apague este arquivo.\n')
        esconder(marca)
      }
    } catch (e) {
      throw new Error(`Não consegui gravar na pasta ${nova} (${e.code || e.message}). Confira o endereço e a permissão.`)
    }
  }

  // Junction, letra de rede ou caminho UNC levam à mesma pasta sem que o texto mostre: uma sonda gravada em `nova` aparece em `atual`.
  // `esperar`: procura de novo até o limite, porque o cache da rede pode esconder a sonda. `open` vai até o servidor; `access` pode responder do cache.
  // Com `esperar` a resposta libera apagar a origem: qualquer dúvida recusa, e nenhum existsSync decide.
  async function mesmaPastaPorSonda(nova, atual, { esperar = false } = {}) {
    if (!esperar && (!fs.existsSync(nova) || !fs.existsSync(atual) || !fs.statSync(nova).isDirectory())) return false
    const nome = `.sonda-smart-fiscal-${crypto.randomBytes(8).toString('hex')}`
    const sonda = path.join(nova, nome)
    const vista = () =>
      fsp.open(path.join(atual, nome)).then(
        async (arquivo) => {
          await arquivo.close()
          return true
        },
        (e) => {
          if (e.code === 'ENOENT') return false
          throw e
        },
      )
    let gravou = false
    let lendoAsPastas = esperar
    try {
      if (esperar) {
        const [pastaNova] = await Promise.all([fsp.stat(nova), fsp.stat(atual)])
        if (!pastaNova.isDirectory()) throw Object.assign(new Error('não é uma pasta'), { code: 'ENOTDIR' })
      }
      lendoAsPastas = false
      await fsp.writeFile(sonda, 'ok', { flag: 'wx' })
      gravou = true
      if (await vista()) return true
      if (!esperar) return false
      for (let resta = esperaDaSonda.limiteMs; resta > 0 && !pararPedido; resta -= esperaDaSonda.intervaloMs) {
        await (dormir || dormirDeVerdade)(esperaDaSonda.intervaloMs)
        if (await vista()) return true
      }
      return false
    } catch (e) {
      const fim = `(${e.code || e.message}). Confira o endereço e a permissão. Nada mudou: continua em ${atual}.`
      throw new Error(gravou || lendoAsPastas ? `Não consegui conferir se ${nova} é a mesma pasta ${fim}` : `Não consegui gravar na pasta ${nova} ${fim}`)
    } finally {
      await fsp.rm(sonda, { force: true }).catch((e) => logger.warn('Arquivo de teste não apagado da pasta nova', { sonda, erro: e.message }))
    }
  }

  /**
   * Troca a pasta e leva os arquivos para ela. XMLs: a pasta escolhida é a raiz das empresas, vazia ou com a marca; '' é recusado.
   * Exportações: '' volta para a padrão.
   * Durante a cópia nada muda no banco nem em config: o app continua na pasta antiga. Só depois de copiar tudo o caminho novo
   * é gravado (junto com pasta_principal, numa transação) e então se apaga da origem o que foi conferido no destino.
   * `interrompida`: pararTroca cortou antes de gravar; nada mudou e repetir continua de onde parou.
   * `avisos`: o que ficou para trás na pasta antiga.
   * @returns {Promise<{ pasta, movidos, mudou, avisos: string[], interrompida?: boolean }>}
   */
  async function mudar(tipo, valor) {
    if (!TIPOS[tipo]) throw new Error('Pasta desconhecida.')
    if (pararPedido) throw new Error('O Smart Fiscal está fechando: a pasta não foi trocada.')
    if (movendo) throw new Error('A pasta já está sendo trocada.')
    // Marca antes de qualquer await: nem outra troca nem uma captura passam pela guarda durante a preparação.
    movendo = { tipo, feitos: 0, total: 0, fase: 'copiando' }
    avisarTroca(true)
    const troca = trocar(tipo, valor)
      .then(
        (r) => {
          ultimaTroca = { tipo, ok: !r.interrompida, mensagem: mensagemDaTroca(tipo, r), avisos: r.avisos }
          return r
        },
        (e) => {
          ultimaTroca = { tipo, ok: false, mensagem: e.message, avisos: [] }
          throw e
        },
      )
      .finally(() => {
        movendo = null
        avisarTroca(false)
      })
    fimDaTroca = troca.then(
      () => {},
      () => {},
    )
    return troca
  }

  function mensagemDaTroca(tipo, r) {
    if (r.interrompida) return `A troca foi interrompida. Nada mudou: continua em ${r.pasta}.`
    if (!r.mudou) return 'A pasta continua a mesma.'
    const levados = r.movidos === 1 ? '1 arquivo levado' : `${r.movidos.toLocaleString('pt-BR')} arquivos levados`
    return `${tipo === 'xmls' ? 'Pasta principal' : 'Pasta trocada'}: ${r.pasta}. ${levados}.`
  }

  async function trocar(tipo, valor) {
    const t = TIPOS[tipo]
    const ehXmls = tipo === 'xmls'
    const texto = String(valor ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
    if (ehXmls && !texto) throw new Error('Escolha a pasta onde ficam as notas: não há volta para a pasta padrão.')
    if (texto && !caminhoCompleto(texto)) throw new Error('Informe o endereço completo da pasta, como D:\\Fiscal\\XMLs ou \\\\servidor\\fiscal\\XMLs.')
    const nova = path.resolve(texto || padrao[tipo])
    const ehPadrao = nova === path.resolve(padrao[tipo])
    const atual = path.resolve(config[t.campo])
    const principalSalva = sql.ler.get('pasta_principal')?.valor
    const mesma = nova === atual
    // Escolher a pasta que já está em uso só não faz nada se ela já é a principal; senão é adotada (marca e pasta_principal).
    if (mesma && (!ehXmls || (principalSalva && path.resolve(principalSalva) === nova))) return { pasta: nova, movidos: 0, mudou: false, avisos: [] }
    if (!mesma && (dentroDe(atual, nova) || dentroDe(nova, atual))) throw new Error('A pasta nova não pode ficar dentro da atual (nem a atual dentro da nova).')
    if ((ehXmls || !ehPadrao) && (dentroDe(config.raiz, nova) || dentroDe(config.pastaEstoque, nova))) {
      throw new Error('Escolha uma pasta fora da pasta de dados do Smart Fiscal.')
    }
    const outra = Object.values(TIPOS).find((o) => o !== t && config[o.campo] && (dentroDe(config[o.campo], nova) || dentroDe(nova, config[o.campo])))
    if (outra) throw new Error(`Essa pasta se mistura com a de ${outra.nome.toLowerCase()}: use uma pasta só para cada uma.`)

    const gravarEndereco = () => {
      try {
        db.transaction(() => {
          sql.gravar.run(t.chave, ehPadrao ? '' : nova)
          if (ehXmls) sql.gravar.run('pasta_principal', nova)
        })()
      } catch (e) {
        logger.error('Falha ao gravar a pasta nova', { tipo, de: atual, para: nova, erro: e.message })
        throw new Error(`Nada mudou: continua em ${atual}.`)
      }
      config[t.campo] = nova
    }

    const soOEndereco = () => {
      gravarEndereco()
      logger.info('Mesma pasta por outro endereço: só o endereço mudou', { tipo, de: atual, para: nova })
      return { pasta: nova, movidos: 0, mudou: true, avisos: [] }
    }

    if (!mesma && (await mesmaPastaPorSonda(nova, atual))) return soOEndereco()

    // O que levar da pasta atual: tudo do Smart Fiscal se ela tem a marca; senão o que o banco registrou e os nomes do app.
    let relativos = []
    let marcaOrigem = false
    if (!mesma) {
      if (ehXmls) {
        marcaOrigem = fs.existsSync(path.join(atual, MARCA))
        try {
          if (marcaOrigem) relativos = await arquivosComMarca(atual)
          else if (!fs.existsSync(atual) && registradosNoBanco()) throw Object.assign(new Error('não existe'), { code: 'ENOENT' })
          else relativos = await arquivosDoBanco(atual)
        } catch (e) {
          throw new Error(`Não consegui ler a pasta atual das notas (${atual}): ${e.code || e.message}. Confira se o disco ou a rede estão disponíveis; nada foi mudado.`)
        }
      } else {
        relativos = await arquivosDe(t, atual)
      }
    }

    if (ehXmls && !mesma && !relativos.length && registradosNoBanco()) throw new Error('A pasta atual está sem os arquivos. Confira se a rede está conectada.')
    movendo.total = relativos.length

    if (ehXmls) prepararDestino(nova)
    else {
      try {
        fs.mkdirSync(nova, { recursive: true })
        const teste = path.join(nova, `.teste-smart-fiscal-${process.pid}`)
        fs.writeFileSync(teste, 'ok')
        fs.rmSync(teste, { force: true })
      } catch (e) {
        throw new Error(`Não consegui gravar na pasta ${nova} (${e.code || e.message}). Confira o endereço e a permissão.`)
      }
    }

    const feito = { apagaveis: [], criados: [], diferentes: [] }
    // Só apaga o que a identidade prova ser outro arquivo: o "criado" pode ser o próprio original, visto por outro endereço.
    const desfazerCriados = async () => {
      const mantidos = []
      let erro
      for (const alvo of feito.criados) {
        const rel = path.relative(nova, alvo)
        try {
          const [sa, sb] = await Promise.all([fsp.stat(path.join(atual, rel), { bigint: true }), fsp.stat(alvo, { bigint: true })])
          const recusa = recusaDeMesmoArquivo(sa, sb, rel)
          if (recusa) {
            mantidos.push(rel)
            erro ??= recusa
          } else await fsp.rm(alvo, { force: true })
        } catch (e) {
          mantidos.push(rel)
          erro ??= e.code || e.message
        }
      }
      // Uma linha só: com a rede fora, seriam milhares.
      if (mantidos.length) logger.warn('Arquivos da pasta nova não apagados: na dúvida, ficam; repetir a troca continua deles', { pasta: nova, arquivos: mantidos.length, exemplos: mantidos.slice(0, 5), erro })
      await limparVazias(nova, feito.criados.map((alvo) => path.relative(nova, alvo)))
    }
    const interrompida = () => {
      logger.warn('Troca de pasta interrompida antes de gravar: nada mudou', { tipo, de: atual, para: nova, copiados: feito.apagaveis.length })
      return { pasta: atual, movidos: 0, mudou: false, interrompida: true, avisos: [] }
    }
    try {
      await copiar({ de: atual, para: nova, relativos, feito, logger, deveParar, tentativas, aoCopiar: () => movendo.feitos++ })
    } catch (e) {
      // Parando: a cópia parcial fica no destino e repetir a troca continua dela.
      if (pararPedido) return interrompida()
      // A pasta atual não mudou e tem tudo: só sai do destino o que esta tentativa criou.
      await desfazerCriados()
      logger.error('Falha ao mover a pasta', { tipo, de: atual, para: nova, erro: e.message })
      throw new Error(`Não consegui copiar os arquivos para ${nova} (${e.code || e.message}). Nada mudou: continua em ${atual}.`)
    }
    if (feito.interrompida) return interrompida()
    // Arquivo que "já estava lá" pode ser ele mesmo: antes de apagar qualquer coisa, a sonda tem mais tempo para aparecer.
    if (feito.achouExistente) {
      let mesmaPasta
      try {
        mesmaPasta = await mesmaPastaPorSonda(nova, atual, { esperar: true })
      } catch (e) {
        await desfazerCriados()
        logger.error('Falha ao conferir a pasta nova', { tipo, de: atual, para: nova, erro: e.message })
        throw e
      }
      // Nada a desfazer: na mesma pasta, o que "esta tentativa criou" é o que está na pasta atual.
      if (mesmaPasta) return soOEndereco()
      if (pararPedido) return interrompida()
      if (feito.recusa) {
        await desfazerCriados()
        logger.error('Troca de pasta recusada', { tipo, de: atual, para: nova, erro: feito.recusa })
        throw new Error(`Não troquei a pasta: ${feito.recusa}. Nada mudou: continua em ${atual}.`)
      }
    }
    try {
      gravarEndereco()
    } catch (e) {
      await desfazerCriados()
      throw e
    }

    const sobraram = await apagarDaOrigem(atual, feito.apagaveis)
    await limparVazias(atual, feito.apagaveis)
    if (marcaOrigem && !sobraram) {
      // Pasta antiga que só tinha o que foi levado: some junto com a marca.
      try {
        const sobrou = semDoWindows(await fsp.readdir(atual).catch(() => []))
        if (sobrou.length === 1 && sobrou[0] === MARCA) {
          await fsp.rm(path.join(atual, MARCA), { force: true })
          await fsp.rmdir(atual).catch(() => {})
        }
      } catch (e) {
        logger.warn('Pasta antiga não removida', { pasta: atual, erro: e.message })
      }
    }
    logger.info('Pasta trocada', { tipo, de: atual, para: nova, arquivos: feito.apagaveis.length })
    return { pasta: nova, movidos: feito.apagaveis.length, mudou: true, avisos: avisosDaTroca(sobraram, feito.diferentes) }
  }

  // Depois de gravar o endereço a troca já valeu: o que não sair da pasta antiga vira aviso, nunca erro.
  async function apagarDaOrigem(atual, relativos) {
    movendo.fase = 'apagando'
    movendo.feitos = 0
    movendo.total = relativos.length
    let sobraram = 0
    for (const [i, rel] of relativos.entries()) {
      if (pararPedido) {
        sobraram += relativos.length - i
        logger.warn('Troca de pasta interrompida depois de gravar: parte dos arquivos ficou na pasta antiga', { pasta: atual, arquivos: sobraram })
        break
      }
      try {
        await fsp.rm(path.join(atual, rel), { force: true })
      } catch (e) {
        sobraram++
        logger.warn('Arquivo não saiu da pasta antiga', { arquivo: path.join(atual, rel), erro: e.code || e.message })
      }
      movendo.feitos++
    }
    return sobraram
  }

  function avisosDaTroca(sobraram, diferentes) {
    const avisos = []
    if (sobraram === 1) avisos.push('1 arquivo não saiu da pasta antiga. Pode apagá-lo depois.')
    else if (sobraram) avisos.push(`${sobraram.toLocaleString('pt-BR')} arquivos não saíram da pasta antiga. Pode apagá-los depois.`)
    if (diferentes.length) {
      const lista = diferentes.slice(0, DIFERENTES_NO_AVISO).join(', ')
      const resto = diferentes.length - DIFERENTES_NO_AVISO
      const qual = diferentes.length === 1 ? '1 arquivo diferente já estava na pasta nova e ficou na antiga' : `${diferentes.length.toLocaleString('pt-BR')} arquivos diferentes já estavam na pasta nova e ficaram na antiga`
      avisos.push(`${qual}: ${lista}${resto > 0 ? ` e mais ${resto.toLocaleString('pt-BR')}` : ''}.`)
    }
    return avisos
  }

  /**
   * Escolhe a pasta principal (a própria raiz das empresas) e leva os arquivos para ela.
   * @returns {Promise<{ raiz: string, movidos: number, mudou: boolean, avisos: string[], interrompida?: boolean }>}
   */
  async function mudarPrincipal(valor) {
    const r = await mudar('xmls', valor)
    const { pasta, ...resto } = r
    return { raiz: pasta, ...resto }
  }

  return { estado, temPasta, movendoAgora, mudar, mudarPrincipal, pararTroca, aoMudarTroca, TIPOS }
}

module.exports = { criarServicoPastas, MARCA }
