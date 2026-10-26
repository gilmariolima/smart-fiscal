'use strict'

// Smart Fiscal como app desktop (Electron). Dois motores, uma janela:
// - notas (SEFAZ): o servidor do antigo SmartDoc (agendador + painel) roda dentro do app;
// - estoque (SPED): o motor em Python do antigo Estoque SPED roda à parte, numa porta livre,
//   e o painel repassa /estoque para ele.
// O app fica no ícone perto do relógio: fechar a janela não desliga a busca automática de
// notas; para desligar, "Sair" no menu do ícone.

const { app, BrowserWindow, Menu, Tray, Notification, dialog, nativeImage, shell } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { NOME, pastaDados, subpastas, appsAnteriores, copiarDadosAnteriores, prepararEnv } = require('./dados')
const { pastaMotor, caminhoPython, iniciarMotor } = require('./motor')
const { criarAtualizacao } = require('./atualizar')

const APP_ID = 'com.gilmariolima.smartfiscal'
const RAIZ = path.resolve(__dirname, '..')
const NO_WINDOWS = process.platform === 'win32'
const ARG_OCULTO = '--oculto' // usado ao ligar junto com o Windows

let ctx = null
let servidor = null
let motorEstoque = null
let janela = null
let bandeja = null
let urlPainel = null
let saindo = false
let encerrado = false
let pasta = null
let prefs = {}
let atualizacao = null

// ---------- preferências do app (não são configuração do sistema: essa fica no .env) ----------

const arquivoPrefs = () => path.join(app.getPath('userData'), 'preferencias.json')
function lerPrefs() {
  try {
    return JSON.parse(fs.readFileSync(arquivoPrefs(), 'utf8'))
  } catch {
    return {}
  }
}
function salvarPrefs(mudancas) {
  prefs = { ...prefs, ...mudancas }
  try {
    fs.mkdirSync(path.dirname(arquivoPrefs()), { recursive: true })
    fs.writeFileSync(arquivoPrefs(), JSON.stringify(prefs, null, 2))
  } catch {
    // preferência perdida não impede o app de funcionar
  }
}

// ---------- ícone ----------

function caminhoIcone() {
  if (NO_WINDOWS) return path.join(RAIZ, 'windows', 'icone.ico')
  return path.join(RAIZ, 'src', 'web', 'dist', 'icone.png')
}

// ---------- dados do SmartDoc e do Estoque SPED ----------

function smartDocAberto() {
  if (!NO_WINDOWS) return false
  try {
    const saida = execFileSync('tasklist', ['/FI', 'IMAGENAME eq SmartDoc.exe', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    return /SmartDoc\.exe/i.test(saida)
  } catch {
    return false
  }
}

/**
 * Primeira vez: copia os dados do SmartDoc e do Estoque SPED. O SmartDoc tem de estar fechado
 * (o banco aberto pode sair copiado pela metade) e, depois da cópia, deixa de ligar com o
 * Windows: dois programas buscando as mesmas notas na SEFAZ dão erro de consumo indevido.
 */
async function trazerDadosAnteriores() {
  if (process.env.SMART_FISCAL_DADOS) return []
  const anteriores = appsAnteriores()
  const notas = subpastas(pasta).notas
  const doSmartDoc = anteriores.find((a) => a.nome === 'SmartDoc')
  const precisaSmartDoc = doSmartDoc && fs.existsSync(path.join(doSmartDoc.origem, '.env')) && !fs.existsSync(path.join(notas, '.env'))
  while (precisaSmartDoc && smartDocAberto()) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: NOME,
      message: 'Feche o SmartDoc para trazer os dados dele',
      detail: 'O Smart Fiscal vai copiar os clientes, certificados e notas do SmartDoc. Feche o SmartDoc antes: '
        + 'botão direito no ícone dele perto do relógio > "Sair do SmartDoc". Depois clique em Continuar.',
      buttons: ['Continuar', 'Fechar o Smart Fiscal'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 1) {
      encerrado = true
      app.exit(0)
      return []
    }
  }
  const copiados = copiarDadosAnteriores({ dados: pasta, anteriores })
  if (copiados.some((c) => c.nome === 'SmartDoc')) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'SmartDoc', '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // o SmartDoc não ligava com o Windows
    }
  }
  return copiados
}

// ---------- janela ----------

function abrirJanela() {
  if (janela) {
    if (janela.isMinimized()) janela.restore()
    janela.show()
    janela.focus()
    return
  }
  janela = new BrowserWindow({
    title: NOME,
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: caminhoIcone(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  if (prefs.maximizada) janela.maximize()

  // Links para fora do painel abrem no navegador padrão.
  const doPainel = (url) => url === urlPainel || url.startsWith(urlPainel + '/')
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (doPainel(url)) return { action: 'allow' }
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  janela.webContents.on('will-navigate', (e, url) => {
    if (doPainel(url)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  janela.once('ready-to-show', () => janela.show())
  janela.on('maximize', () => salvarPrefs({ maximizada: true }))
  janela.on('unmaximize', () => salvarPrefs({ maximizada: false }))

  // Fechar só esconde: o agendador continua rodando na bandeja.
  janela.on('close', (e) => {
    if (saindo) return
    e.preventDefault()
    janela.hide()
    if (!prefs.avisouBandeja) {
      salvarPrefs({ avisouBandeja: true })
      notificar('O Smart Fiscal continua rodando', 'A busca automática de notas segue nos horários. Para abrir de novo ou sair, use o ícone perto do relógio.')
    }
  })
  janela.on('closed', () => {
    janela = null
  })

  janela.loadURL(urlPainel)
}

// ---------- bandeja ----------

function notificar(titulo, corpo) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: titulo, body: corpo, icon: caminhoIcone() })
  n.on('click', abrirJanela)
  n.show()
}

const opcoesInicio = () => ({ args: [ARG_OCULTO], name: NOME })
function iniciaComWindows() {
  return app.getLoginItemSettings(opcoesInicio()).openAtLogin
}
function definirInicioComWindows(ligado) {
  if (!app.isPackaged) return // em desenvolvimento não mexe na inicialização do Windows
  app.setLoginItemSettings({ ...opcoesInicio(), openAtLogin: ligado })
  salvarPrefs({ iniciarComWindows: ligado })
}

function dataHora(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function textoEstado() {
  const e = servidor?.agendador.estado()
  if (!e) return NOME
  if (e.rodandoAgora) return `${NOME}: buscando notas…`
  if (!e.automatica) return `${NOME}: busca automática de notas desligada`
  return `${NOME}: próxima busca de notas ${dataHora(e.proximaExecucao)}`
}

async function buscarAgora() {
  if (servidor.agendador.estado().rodandoAgora) {
    notificar('Busca em andamento', 'O Smart Fiscal já está buscando notas agora.')
    return
  }
  notificar('Buscando notas', 'O Smart Fiscal começou a buscar as notas de todos os clientes.')
  atualizarBandeja()
  const r = await servidor.agendador.executarAgora('bandeja')
  const u = servidor.agendador.estado().ultimaExecucao
  if (!r.ok) notificar('A busca não foi feita', r.erro || 'Veja os detalhes no painel.')
  else if (u?.clientesComErro) notificar('Busca concluída com erros', `${u.clientesComErro} de ${u.clientes} cliente(s) com erro. Veja no painel.`)
  else notificar('Busca concluída', `${u?.clientes ?? 0} cliente(s) consultado(s).`)
  atualizarBandeja()
}

function atualizarBandeja() {
  if (!bandeja) return
  const rodando = !!servidor?.agendador.estado().rodandoAgora
  bandeja.setToolTip(textoEstado())
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o Smart Fiscal', click: abrirJanela },
    { label: rodando ? 'Buscando notas…' : 'Buscar notas agora', enabled: !rodando, click: () => buscarAgora() },
    { type: 'separator' },
    { label: textoEstado().replace(`${NOME}: `, ''), enabled: false },
    { label: 'Abrir pasta de dados', click: () => shell.openPath(pasta) },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: iniciaComWindows(), visible: app.isPackaged, click: (item) => definirInicioComWindows(item.checked) },
    { type: 'separator' },
    { label: 'Sair do Smart Fiscal', click: sair },
  ]))
}

function criarBandeja() {
  const icone = nativeImage.createFromPath(caminhoIcone())
  bandeja = new Tray(NO_WINDOWS ? icone : icone.resize({ width: 22, height: 22 }))
  bandeja.on('click', abrirJanela)
  bandeja.on('double-click', abrirJanela)
  atualizarBandeja()

  // Mantém o texto da bandeja em dia e avisa quando uma busca automática termina com erro.
  let ultimaVista = servidor.agendador.estado().ultimaExecucao?.fim || null
  setInterval(() => {
    const u = servidor?.agendador.estado().ultimaExecucao
    if (u && u.fim !== ultimaVista) {
      ultimaVista = u.fim
      if (u.origem !== 'bandeja' && (!u.ok || u.clientesComErro)) {
        notificar('Busca automática com problemas', u.ok ? `${u.clientesComErro} de ${u.clientes} cliente(s) com erro. Veja no painel.` : (u.erro || 'Veja no painel.'))
      }
    }
    atualizarBandeja()
  }, 30e3).unref()
}

// ---------- erros ao ligar ----------

/** O banco é de homologação e o .env já está em produção: oferece a troca (o mesmo que ambiente:producao). */
function podePassarParaProducao() {
  try {
    const { criarContexto } = require('../src/contexto')
    const { ambienteDoBanco, conferirTrocaParaProducao } = require('../src/ambiente')
    const c = criarContexto({ nivelConsole: 'error', verificarAmbiente: false })
    try {
      conferirTrocaParaProducao(c.db, c.config)
      return ambienteDoBanco(c.db) === 'homologacao'
    } finally {
      c.fechar()
    }
  } catch {
    return false
  }
}

async function passarParaProducao() {
  const { criarContexto } = require('../src/contexto')
  const { previaProducao, passarParaProducao: passar } = require('../src/ambiente')
  const c = criarContexto({ nivelConsole: 'error', verificarAmbiente: false })
  try {
    const p = previaProducao(c.db)
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Passar para produção',
      message: 'Passar as notas (SEFAZ) de homologação para produção?',
      detail: `Os ${p.clientes} cliente(s) e os certificados continuam cadastrados.\n`
        + `Serão descartados: ${p.notas} nota(s) e ${p.eventos} evento(s) de teste, e a posição na fila da SEFAZ de cada cliente volta para o início.\n\n`
        + 'Não dá para desfazer.',
      buttons: ['Passar para produção', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return false
    passar({ db: c.db, config: c.config, logger: c.logger })
    return true
  } finally {
    c.fechar()
  }
}

async function falhaAoIniciar(erro) {
  const producao = podePassarParaProducao()
  const botoes = [...(producao ? ['Passar para produção…'] : []), 'Abrir pasta de dados', 'Fechar']
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: NOME,
    message: 'O Smart Fiscal não conseguiu iniciar.',
    detail: `${erro.message}\n\nPasta de dados: ${pasta}`,
    buttons: botoes,
    defaultId: 0,
    cancelId: botoes.length - 1,
    noLink: true,
  })
  const escolha = botoes[response]
  if (escolha === 'Passar para produção…') {
    try {
      if (await passarParaProducao()) {
        app.relaunch()
      }
    } catch (e) {
      dialog.showErrorBox(NOME, `Não foi possível passar para produção:\n${e.message}`)
    }
  } else if (escolha === 'Abrir pasta de dados') {
    await shell.openPath(pasta)
  }
  encerrado = true
  app.exit(1)
}

// ---------- motor do SPED (Python) ----------

/** Liga o motor do SPED. Sem ele o app continua (as notas não dependem dele); a seção mostra o erro. */
async function ligarMotorEstoque(dadosEstoque) {
  const dirMotor = pastaMotor({ empacotado: app.isPackaged, recursos: process.resourcesPath, raiz: RAIZ })
  try {
    motorEstoque = await iniciarMotor({
      python: caminhoPython({ motor: dirMotor }),
      motor: dirMotor,
      dados: dadosEstoque,
      log: path.join(dadosEstoque, 'painel.log'),
      versao: app.getVersion(),
    })
    motorEstoque.processo.once('exit', (codigo) => {
      if (saindo) return
      ctx?.logger.error('O motor do SPED fechou sozinho', { codigo })
      motorEstoque = { erro: `O motor do SPED fechou sozinho (código ${codigo}). Feche e abra o Smart Fiscal; se continuar, veja o painel.log em ${dadosEstoque}.` }
    })
  } catch (e) {
    motorEstoque = { erro: `O motor do SPED não ligou: ${e.message}` }
  }
}

// ---------- atualização automática ----------

function procurarAtualizacao() {
  // Só no app instalado no Windows: rodando do código (npm run app) não há o que atualizar
  if (!app.isPackaged || !NO_WINDOWS || process.env.SMART_FISCAL_SEM_ATUALIZAR) return
  try {
    const { autoUpdater } = require('electron-updater')
    atualizacao = criarAtualizacao({
      atualizador: autoUpdater,
      titulo: NOME,
      perguntar: (opcoes) => (janela ? dialog.showMessageBox(janela, opcoes) : dialog.showMessageBox(opcoes)),
      sair,
      log: path.join(pasta, 'atualizacao.log'),
    })
    atualizacao.procurar()
    // O app fica dias ligado perto do relógio: procura de novo a cada 6 horas
    setInterval(() => atualizacao.procurar(), 6 * 3600e3).unref()
  } catch {
    // sem a atualização, o app funciona do mesmo jeito
  }
}

// ---------- ciclo de vida ----------

async function iniciar() {
  app.setAppUserModelId(APP_ID)
  Menu.setApplicationMenu(null)
  prefs = lerPrefs()

  try {
    pasta = pastaDados()
    const copiados = await trazerDadosAnteriores()
    if (encerrado) return
    const partes = subpastas(pasta)
    fs.mkdirSync(partes.estoque, { recursive: true })
    const env = prepararEnv(partes.notas, path.join(RAIZ, '.env.example'))
    process.env.SMARTDOC_DADOS = partes.notas
    process.env.ESTOQUE_DADOS = partes.estoque
    process.env.SMART_FISCAL_VERSAO = app.getVersion()

    await ligarMotorEstoque(partes.estoque)
    const { criarContexto } = require('../src/contexto')
    const { iniciarServidor } = require('../src/servidor')
    ctx = criarContexto({ nivelConsole: 'warn' })
    if (copiados.length) ctx.logger.info('Dados dos apps anteriores copiados', { copiados })
    if (motorEstoque?.erro) ctx.logger.error('Motor do SPED', { erro: motorEstoque.erro })
    servidor = await iniciarServidor(ctx, { estoque: () => motorEstoque })
    urlPainel = `http://127.0.0.1:${servidor.painel.porta}`

    // Primeira vez: liga junto com o Windows (a busca automática de notas depende disso).
    if (prefs.iniciarComWindows === undefined) definirInicioComWindows(true)
    criarBandeja()
    if (!process.argv.includes(ARG_OCULTO)) abrirJanela()
    procurarAtualizacao()

    if (janela && (copiados.length || env.criado) && !janela.isVisible()) await new Promise((r) => janela.once('show', r))
    if (copiados.length) {
      const opcoes = {
        type: 'info',
        title: NOME,
        message: 'Dados trazidos para o Smart Fiscal',
        detail: `Copiados os dados de: ${copiados.map((c) => c.nome).join(' e ')}.\n\n`
          + 'O Smart Fiscal faz tudo o que eles faziam. Pode desinstalar o SmartDoc e o Estoque SPED '
          + '(Configurações do Windows > Aplicativos): os dados deles continuam guardados na pasta antiga.'
          + (copiados.some((c) => c.nome === 'SmartDoc') ? '\n\nO SmartDoc não liga mais com o Windows, para os dois não buscarem as mesmas notas.' : ''),
        buttons: ['OK'],
        noLink: true,
      }
      await (janela ? dialog.showMessageBox(janela, opcoes) : dialog.showMessageBox(opcoes))
    } else if (env.criado) {
      const opcoes = {
        type: 'info',
        title: NOME,
        message: 'Configuração criada',
        detail: `O Smart Fiscal criou a configuração das notas em\n${env.arquivo}\ncom uma MASTER_KEY nova, em homologação.\n\n`
          + 'Guarde uma cópia desse arquivo num lugar seguro: sem a MASTER_KEY os certificados cadastrados não abrem.',
        buttons: ['Abrir a pasta', 'OK'],
        defaultId: 1,
        noLink: true,
      }
      const { response } = await (janela ? dialog.showMessageBox(janela, opcoes) : dialog.showMessageBox(opcoes))
      if (response === 0) shell.showItemInFolder(env.arquivo)
    }
  } catch (e) {
    if (ctx) {
      try {
        ctx.fechar()
      } catch {
        // já fechado
      }
      ctx = null
    }
    await motorEstoque?.parar?.().catch(() => {})
    await falhaAoIniciar(e)
  }
}

async function encerrar() {
  try {
    if (servidor) await servidor.parar()
  } finally {
    if (ctx) ctx.fechar()
    ctx = null
    await motorEstoque?.parar?.().catch(() => {})
  }
}

function sair() {
  saindo = true
  app.quit()
}

if (!app.requestSingleInstanceLock()) {
  // Já está aberto: o outro processo mostra a janela (evento second-instance).
  app.quit()
} else {
  app.on('second-instance', () => {
    if (urlPainel) abrirJanela()
  })

  // Senha do painel (PAINEL_SENHA): a janela do próprio app entra sem perguntar.
  app.on('login', (e, _wc, detalhes, _auth, responder) => {
    const senha = ctx?.config.painelSenha
    if (senha && urlPainel && detalhes.url.startsWith(urlPainel)) {
      e.preventDefault()
      responder('smartfiscal', senha)
    }
  })

  app.on('window-all-closed', () => {
    // fica rodando perto do relógio
  })

  app.on('before-quit', (e) => {
    saindo = true
    if (encerrado) return
    e.preventDefault()
    if (bandeja) bandeja.setToolTip(`${NOME}: encerrando…`)
    if (janela) janela.hide()
    // Motores parados e banco fechado: sai direto (um segundo app.quit() às vezes não termina o processo).
    encerrar().catch(() => {}).finally(() => {
      encerrado = true
      bandeja?.destroy()
      // Versão nova baixada: o instalador assume e o app sai pelo app.quit dele.
      // Se a saída travar, o app.exit garante (o instalador já está rodando à parte).
      if (atualizacao?.instalarAoSair()) {
        setTimeout(() => app.exit(0), 5000).unref()
        return
      }
      app.exit(0)
    })
  })

  process.on('unhandledRejection', (e) => ctx?.logger.error('Promessa rejeitada sem tratamento', { erro: e?.message || String(e) }))

  app.whenReady().then(iniciar)
}
