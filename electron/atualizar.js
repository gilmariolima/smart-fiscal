'use strict'

// Atualização automática: ao abrir, o app procura uma versão nova em Releases do GitHub
// (o latest.yml que o workflow "Publicar versão" publica) e baixa em segundo plano. Baixada,
// pergunta se reinicia agora; se a pessoa deixar para depois, instala quando o app fechar.
// Sem internet ou sem versão nova, não aparece nada. O botão "Verificar atualizações" do painel
// chama verificar(), que responde na hora e, se houver versão nova, mostra o download no painel.

const fs = require('node:fs')

/**
 * @param {object} o
 * @param {import('electron-updater').AppUpdater} o.atualizador  o autoUpdater do electron-updater
 * @param {(opcoes: object) => Promise<{ response: number }>} o.perguntar  dialog.showMessageBox já com a janela
 * @param {() => void} o.sair  fecha o app (app.quit), que para os motores e chama instalarAoSair
 * @param {string} [o.log]  arquivo onde anotar o que aconteceu
 * @param {string} [o.titulo]  nome do app nas mensagens
 */
function criarAtualizacao({ atualizador, perguntar, sair, log, titulo = 'Smart Fiscal' }) {
  let baixada = null // versão pronta para instalar
  let reabrir = false
  // O que o painel mostra ao lado da versão
  let situacao = { situacao: 'nada' }
  const mudar = (s) => {
    situacao = { ...s, em: new Date().toISOString() }
  }

  const anotar = (nivel, msg) => {
    if (!log) return
    try {
      fs.appendFileSync(log, `${new Date().toISOString()} ${nivel} ${msg instanceof Error ? msg.stack || msg.message : msg}\n`)
    } catch {
      // sem log não impede nada
    }
  }
  atualizador.logger = {
    info: (m) => anotar('info', m),
    warn: (m) => anotar('aviso', m),
    error: (m) => anotar('erro', m),
    debug: () => {},
  }
  atualizador.autoDownload = true
  // O app para o motor antes de sair (before-quit) e sai com app.exit, que não dispara o
  // "quit" de que o autoInstallOnAppQuit depende: quem instala ao sair é instalarAoSair
  atualizador.autoInstallOnAppQuit = false

  atualizador.on('error', (e) => {
    anotar('erro', e)
    if (situacao.situacao !== 'pronta') mudar({ situacao: 'erro', mensagem: e?.message || String(e) })
  })
  atualizador.on('update-available', (info) => mudar({ situacao: 'baixando', versao: info.version, progresso: 0 }))
  atualizador.on('update-not-available', () => mudar({ situacao: 'atualizado' }))
  atualizador.on('download-progress', (p) => {
    if (situacao.situacao === 'baixando') mudar({ ...situacao, progresso: Math.round(p.percent || 0) })
  })

  async function oferecerReinicio(versao) {
    const { response } = await perguntar({
      type: 'info',
      title: titulo,
      message: `A versão ${versao} do ${titulo} está pronta para instalar.`,
      detail: 'Reinicie agora para usar a versão nova. Se preferir continuar, ela é instalada quando você fechar o programa. '
        + 'Os cadastros e os arquivos gerados continuam.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) {
      reabrir = true
      sair()
    }
  }

  atualizador.on('update-downloaded', async (info) => {
    mudar({ situacao: 'pronta', versao: info.version })
    if (baixada === info.version) return // já perguntou (o app procura de novo de tempos em tempos)
    baixada = info.version
    await oferecerReinicio(info.version)
  })

  return {
    procurar() {
      return atualizador.checkForUpdates().catch((e) => anotar('erro', e))
    },
    /** Situação para o painel: nada | procurando | atualizado | baixando | pronta | erro. */
    estado: () => situacao,
    /**
     * Botão "Verificar atualizações": procura agora. Com versão nova, o download segue em segundo
     * plano (o painel acompanha pelo estado); já baixada, pergunta de novo se reinicia.
     */
    async verificar() {
      if (baixada) {
        mudar({ situacao: 'pronta', versao: baixada })
        oferecerReinicio(baixada)
        return situacao
      }
      if (situacao.situacao === 'baixando') return situacao
      mudar({ situacao: 'procurando' })
      try {
        const r = await atualizador.checkForUpdates()
        // Os eventos já atualizaram a situação; sem resposta (atualizador desligado), fica como atualizado
        if (situacao.situacao === 'procurando') {
          const nova = r?.isUpdateAvailable ?? false
          mudar(nova ? { situacao: 'baixando', versao: r.updateInfo?.version, progresso: 0 } : { situacao: 'atualizado' })
        }
      } catch (e) {
        anotar('erro', e)
        mudar({ situacao: 'erro', mensagem: e?.message || String(e) })
      }
      return situacao
    },
    /** Chamado no fim da saída, com o motor já parado. Devolve true se o instalador assumiu. */
    instalarAoSair() {
      if (!baixada) return false
      anotar('info', `instalando a versão ${baixada}${reabrir ? ' e reabrindo' : ''}`)
      // silencioso (o instalador não faz perguntas); reabre só se a pessoa pediu "Reiniciar agora"
      atualizador.quitAndInstall(true, reabrir)
      return true
    },
  }
}

module.exports = { criarAtualizacao }
