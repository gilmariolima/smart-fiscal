'use strict'

const path = require('node:path')

const RAIZ = path.resolve(__dirname, '..')
const HOSTS_LOCAIS = new Set(['127.0.0.1', 'localhost', '::1'])

function inteiro(valor, padrao, nome) {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${nome} deve ser um inteiro >= 0 (recebido: ${valor})`)
  return n
}

/**
 * Pasta do .env e base dos caminhos relativos (data, certs, xmls...).
 * Sem SMARTDOC_DADOS é a própria pasta do sistema; o app instalado no Windows aponta para
 * uma pasta "dados" separada, para que atualizar o programa nunca mexa nos dados.
 */
function pastaBase(env = process.env) {
  const dados = (env.SMARTDOC_DADOS || '').trim()
  return dados ? path.resolve(dados) : RAIZ
}

/**
 * Monta e valida a configuração a partir de um objeto de ambiente.
 * Lança erro com mensagem clara se algo obrigatório estiver faltando.
 */
function carregarConfig(env = process.env) {
  const erros = []
  const base = pastaBase(env)
  const pasta = (valor, padrao) => path.resolve(base, valor || padrao)

  const masterKey = (env.MASTER_KEY || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    erros.push('MASTER_KEY ausente ou inválida: precisa ter 64 caracteres hexadecimais. Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  }

  const tpAmb = (env.TP_AMB || '2').trim()
  if (tpAmb !== '1' && tpAmb !== '2') erros.push(`TP_AMB deve ser 1 (produção) ou 2 (homologação), recebido: ${tpAmb}`)

  const painelHost = (env.PAINEL_HOST || '127.0.0.1').trim()
  const painelSenha = env.PAINEL_SENHA || ''
  if (!HOSTS_LOCAIS.has(painelHost) && !painelSenha) {
    erros.push(`PAINEL_HOST=${painelHost} expõe o painel na rede: defina PAINEL_SENHA ou use 127.0.0.1`)
  }

  const cronCaptura = (env.CRON_CAPTURA || '0 8,13 * * *').trim()
  if (!require('node-cron').validate(cronCaptura)) erros.push(`CRON_CAPTURA inválido: ${cronCaptura}`)

  let numeros = {}
  try {
    numeros = {
      intervaloEntreChamadasMs: inteiro(env.INTERVALO_ENTRE_CHAMADAS_MS, 2000, 'INTERVALO_ENTRE_CHAMADAS_MS'),
      maxConsultasChavePorCiclo: inteiro(env.MAX_CONSULTAS_CHAVE_POR_CICLO, 20, 'MAX_CONSULTAS_CHAVE_POR_CICLO'),
      maxTentativasDownload: inteiro(env.MAX_TENTATIVAS_DOWNLOAD, 5, 'MAX_TENTATIVAS_DOWNLOAD'),
      painelPorta: inteiro(env.PAINEL_PORTA, 3030, 'PAINEL_PORTA'),
    }
  } catch (e) {
    erros.push(e.message)
  }

  if (erros.length) {
    const err = new Error('Configuração inválida:\n- ' + erros.join('\n- '))
    err.erros = erros
    throw err
  }

  // XMLs e exportações podem ir para outra pasta pela tela Pastas: quem troca grava no próprio
  // config (config.pastaXmls = ...) e o caminho novo vale na hora para todo o sistema.
  const pastasPadrao = Object.freeze({ xmls: pasta(env.PASTA_XMLS, './xmls'), exports: pasta(env.PASTA_EXPORTS, './exports') })
  const escolhidas = {}

  return Object.freeze({
    raiz: base,
    tpAmb,
    masterKey: masterKey.toLowerCase(),
    cronCaptura,
    ...numeros,
    painelHost,
    painelSenha,
    pastasPadrao,
    get pastaXmls() {
      return escolhidas.xmls || pastasPadrao.xmls
    },
    set pastaXmls(valor) {
      escolhidas.xmls = valor ? path.resolve(valor) : null
    },
    get pastaExports() {
      return escolhidas.exports || pastasPadrao.exports
    },
    set pastaExports(valor) {
      escolhidas.exports = valor ? path.resolve(valor) : null
    },
    pastaCerts: pasta(env.PASTA_CERTS, './certs'),
    pastaLogs: pasta(env.PASTA_LOGS, './logs'),
    caminhoBanco: path.join(pasta(env.PASTA_DADOS, './data'), 'nfe.db'),
    // Sem PASTA_BACKUP (e sem pasta escolhida na tela Backup) o backup automático fica desligado.
    pastaBackup: (env.PASTA_BACKUP || '').trim() ? pasta(env.PASTA_BACKUP.trim()) : null,
    // Dados do SPED (Smart Fiscal): entram na cópia diária do backup.
    pastaEstoque: (env.ESTOQUE_DADOS || '').trim() ? path.resolve(env.ESTOQUE_DADOS.trim()) : null,
    sefazMock: env.SEFAZ_MOCK === '1',
  })
}

let cache = null

/** Configuração do processo (lê o .env da pasta base uma vez). */
function obterConfig() {
  if (!cache) {
    require('dotenv').config({ path: path.join(pastaBase(), '.env'), quiet: true })
    cache = carregarConfig(process.env)
  }
  return cache
}

module.exports = { carregarConfig, obterConfig, pastaBase, RAIZ }
