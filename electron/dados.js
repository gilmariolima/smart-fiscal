'use strict'

// Pasta de dados do Smart Fiscal, .env da primeira vez e a cópia dos dados do SmartDoc e do
// Estoque SPED instalados antes. Fica separado do main.js para os testes rodarem sem o Electron.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const NOME = 'Smart Fiscal'

/**
 * Onde ficam os dados: notas\ (SEFAZ: .env, data, certs, xmls, exports, logs) e estoque\
 * (SPED: empresas, escritório, saida...). Fica FORA da pasta do programa: o instalador apaga a
 * pasta do programa inteira ao atualizar ou desinstalar, e os dados nunca podem ir junto.
 */
function pastaDados({ env = process.env, localAppData = env.LOCALAPPDATA } = {}) {
  const definida = (env.SMART_FISCAL_DADOS || '').trim()
  if (definida) return path.resolve(definida)
  if (!localAppData) throw new Error('LOCALAPPDATA não definido: defina SMART_FISCAL_DADOS com a pasta de dados.')
  return path.join(localAppData, NOME, 'dados')
}

const subpastas = (dados) => ({ notas: path.join(dados, 'notas'), estoque: path.join(dados, 'estoque') })

/** Os apps que o Smart Fiscal substitui, com a pasta de dados de cada um. */
function appsAnteriores({ localAppData = process.env.LOCALAPPDATA } = {}) {
  if (!localAppData) return []
  return [
    // SmartDoc: só conta se tem o .env (sem a MASTER_KEY dele, os certificados não abrem)
    { nome: 'SmartDoc', parte: 'notas', origem: path.join(localAppData, 'SmartDoc', 'dados'), marca: '.env' },
    { nome: 'Estoque SPED', parte: 'estoque', origem: path.join(localAppData, 'Estoque SPED', 'dados'), marca: null },
  ]
}

/** Pasta sem nada que importe (vazia ou só com logs criados antes da cópia). */
function semDados(pasta) {
  if (!fs.existsSync(pasta)) return true
  return fs.readdirSync(pasta).every((n) => ['logs', 'painel.log', 'painel.token'].includes(n))
}

/**
 * Primeira vez: copia os dados do SmartDoc e do Estoque SPED para as partes do Smart Fiscal
 * que ainda estão vazias. Só copia: os apps antigos continuam com os dados deles. A cópia vai
 * para uma pasta temporária e só depois ganha o nome final, para uma cópia interrompida não
 * deixar a pasta pela metade (a próxima abertura copia de novo).
 * @returns {{ nome, de, para }[]} o que foi copiado
 */
function copiarDadosAnteriores({ dados, anteriores }) {
  const partes = subpastas(dados)
  const copiados = []
  for (const a of anteriores) {
    const destino = partes[a.parte]
    if (!fs.existsSync(a.origem) || (a.marca && !fs.existsSync(path.join(a.origem, a.marca)))) continue
    if (fs.readdirSync(a.origem).length === 0 || !semDados(destino)) continue
    const temp = `${destino}.copiando`
    fs.rmSync(temp, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(destino), { recursive: true })
    fs.cpSync(a.origem, temp, { recursive: true, preserveTimestamps: true })
    fs.rmSync(destino, { recursive: true, force: true })
    fs.renameSync(temp, destino)
    copiados.push({ nome: a.nome, de: a.origem, para: destino })
  }
  return copiados
}

const LINHA_PRODUCAO = 'TP_AMB=1                       # 1 = produção: o Smart Fiscal trabalha sempre em produção'

/**
 * Primeira vez: cria o .env das notas a partir do modelo com uma MASTER_KEY nova, em produção.
 * Um .env que já existe nunca é recriado: a MASTER_KEY é o que abre os certificados guardados.
 */
function prepararEnv(pasta, caminhoModelo) {
  const arquivo = path.join(pasta, '.env')
  if (fs.existsSync(arquivo)) return { criado: false, arquivo }
  const modelo = fs.readFileSync(caminhoModelo, 'utf8')
  const chave = crypto.randomBytes(32).toString('hex')
  const comChave = /^MASTER_KEY=.*$/m.test(modelo)
    ? modelo.replace(/^MASTER_KEY=.*$/m, `MASTER_KEY=${chave}`)
    : `MASTER_KEY=${chave}\n${modelo}`
  const conteudo = /^TP_AMB=.*$/m.test(comChave) ? comChave.replace(/^TP_AMB=.*$/m, LINHA_PRODUCAO) : `${LINHA_PRODUCAO}\n${comChave}`
  fs.mkdirSync(pasta, { recursive: true })
  fs.writeFileSync(arquivo, conteudo, { encoding: 'utf8', flag: 'wx' })
  return { criado: true, arquivo }
}

/**
 * O Smart Fiscal trabalha sempre em produção: um .env em homologação (TP_AMB=2, ou sem TP_AMB)
 * passa para TP_AMB=1, mantendo o resto (MASTER_KEY inclusive). O modo demonstração (SEFAZ_MOCK=1) fica como está.
 * @returns {boolean} se o .env foi mudado
 */
function garantirProducao(pasta) {
  const arquivo = path.join(pasta, '.env')
  if (!fs.existsSync(arquivo)) return false
  const texto = fs.readFileSync(arquivo, 'utf8')
  if (/^\s*SEFAZ_MOCK\s*=\s*1\b/m.test(texto)) return false
  if (/^\s*TP_AMB\s*=\s*1\b/m.test(texto)) return false
  const novo = /^\s*TP_AMB\s*=.*$/m.test(texto) ? texto.replace(/^\s*TP_AMB\s*=.*$/m, LINHA_PRODUCAO) : `${LINHA_PRODUCAO}\n${texto}`
  const temp = `${arquivo}.${process.pid}.tmp`
  fs.writeFileSync(temp, novo, 'utf8')
  fs.renameSync(temp, arquivo)
  return true
}

module.exports = { NOME, pastaDados, subpastas, appsAnteriores, copiarDadosAnteriores, prepararEnv, garantirProducao }
