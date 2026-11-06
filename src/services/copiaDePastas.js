'use strict'

// Cópia arquivo a arquivo da troca de pasta.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const PASSAGEIROS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETIMEDOUT', 'EIO', 'UNKNOWN'])
const ESPERAS_MS = [500, 2000, 5000]
const dormirDeVerdade = (ms) => new Promise((r) => setTimeout(r, ms))

/** Repete `fn` depois de cada espera quando o erro é passageiro. `deveParar` verdadeiro não espera mais. */
async function comTentativas(fn, { esperas = ESPERAS_MS, dormir = dormirDeVerdade, deveParar = () => false } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= esperas.length || !PASSAGEIROS.has(e.code) || deveParar()) throw e
      await dormir(esperas[i])
    }
  }
}

async function iguais(a, b) {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)])
  if (sa.size !== sb.size) return false
  const [ca, cb] = await Promise.all([fsp.readFile(a), fsp.readFile(b)])
  return ca.equals(cb)
}

/**
 * Por que não dá para tratar os dois stats (com bigint) como arquivos diferentes; null quando são.
 * O mesmo arquivo físico nos dois lados é a mesma pasta: apagar a origem seria apagar o único exemplar.
 * Sem `ino` não há como garantir. O `dev` fica de fora: pode variar entre endereços da mesma pasta (Samba).
 */
function recusaDeMesmoArquivo(sa, sb, nome) {
  if (!sa.ino || !sb.ino) return `não dá para garantir que são pastas diferentes: o disco não informa a identidade do arquivo ${nome}`
  if (sa.ino === sb.ino) return `os dois endereços levam ao mesmo arquivo: ${nome}`
  return null
}

const COPIA_EXCLUSIVA = fs.constants.COPYFILE_EXCL

const ehReservaAbandonada = (tamanhoDe, tamanhoPara) => tamanhoPara === 0 && tamanhoDe > 0

async function removerReservaVazia(para) {
  try {
    if ((await fsp.stat(para)).size === 0) await fsp.rm(para)
  } catch {} // o erro que vale é o de quem chamou
}

/** Cria o nome final vazio, de forma exclusiva. Devolve false quando o nome já existe. */
async function reservar(para) {
  let aberto
  try {
    aberto = await fsp.open(para, 'wx')
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
  try {
    await aberto.close()
  } catch (e) {
    await removerReservaVazia(para)
    throw e
  }
  return true
}

async function reservaAbandonada(de, para) {
  const [sa, sb] = await Promise.all([fsp.stat(de), fsp.stat(para)])
  return ehReservaAbandonada(sa.size, sb.size)
}

/**
 * Dá o nome final a `de`, um temporário ao lado de `para`, sem sobrescrever. Devolve false quando o nome já existe.
 * Link físico; se o disco não tiver, reserva exclusiva e rename, que só substitui a reserva vazia e leva o conteúdo inteiro de uma vez.
 * Só essas operações decidem: existsSync responde false para qualquer erro.
 * Destino de 0 byte com origem de mais de 0 byte é reserva interrompida. A mesma pasta por outro endereço tem o mesmo tamanho nos dois lados.
 */
async function nomearSemSobrescrever(de, para) {
  let erroDoLink
  try {
    await fsp.link(de, para)
    return true
  } catch (e) {
    erroDoLink = e
  }
  const livre = erroDoLink.code !== 'EEXIST' && (await reservar(para))
  if (!livre && !(await reservaAbandonada(de, para))) return false
  try {
    await fsp.rename(de, para)
    return true
  } catch (e) {
    await removerReservaVazia(para)
    throw e
  }
}

function removerReservaVaziaSync(para) {
  try {
    if (fs.statSync(para).size === 0) fs.rmSync(para)
  } catch {} // o erro que vale é o de quem chamou
}

function reservarSync(para) {
  let aberto
  try {
    aberto = fs.openSync(para, 'wx')
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
  try {
    fs.closeSync(aberto)
  } catch (e) {
    removerReservaVaziaSync(para)
    throw e
  }
  return true
}

const reservaAbandonadaSync = (de, para) => ehReservaAbandonada(fs.statSync(de).size, fs.statSync(para).size)

/** A mesma regra para quem é síncrono: `de` é o arquivo original e fica; sem link, o temporário é criado aqui e conferido pelo tamanho. */
function nomearSemSobrescreverSync(de, para) {
  let erroDoLink
  try {
    fs.linkSync(de, para)
    return true
  } catch (e) {
    erroDoLink = e
  }
  const nomeExiste = erroDoLink.code === 'EEXIST'
  if (nomeExiste && !reservaAbandonadaSync(de, para)) return false
  const tmp = `${para}.${process.pid}.tmp`
  try {
    fs.rmSync(tmp, { force: true })
    fs.copyFileSync(de, tmp, COPIA_EXCLUSIVA)
    if (fs.statSync(de).size !== fs.statSync(tmp).size) throw Object.assign(new Error('cópia incompleta'), { code: 'EIO' })
    if (!nomeExiste && !reservarSync(para) && !reservaAbandonadaSync(de, para)) return false
    try {
      fs.renameSync(tmp, para)
      return true
    } catch (e) {
      removerReservaVaziaSync(para)
      throw e
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {} // sobra de .tmp é ignorada por quem lê a pasta
  }
}

// Grava num .tmp, confere o tamanho e só então dá o nome final (sem sobrescrever): o conteúdo chega inteiro ao nome final, por link ou por rename.
// Se o destino já tem o arquivo, a origem só é apagável quando o conteúdo é idêntico.
async function copiarUm({ origem, alvo, rel, feito, logger }) {
  const tmp = `${alvo}.${process.pid}.tmp`
  await fsp.mkdir(path.dirname(alvo), { recursive: true })
  try {
    await fsp.rm(tmp, { force: true })
    await fsp.copyFile(origem, tmp, fs.constants.COPYFILE_EXCL)
    const { size, atime, mtime } = await fsp.stat(origem)
    if ((await fsp.stat(tmp)).size !== size) throw Object.assign(new Error('cópia incompleta'), { code: 'EIO' })
    if (!(await nomearSemSobrescrever(tmp, alvo))) {
      feito.achouExistente = true
      const [sa, sb] = await Promise.all([fsp.stat(origem, { bigint: true }), fsp.stat(alvo, { bigint: true })])
      feito.recusa = recusaDeMesmoArquivo(sa, sb, rel)
      if (feito.recusa) return
      if (await iguais(origem, alvo)) feito.apagaveis.push(rel)
      else {
        feito.diferentes.push(rel)
        logger.warn('Arquivo diferente já existe na pasta nova: o da pasta antiga foi mantido', { origem, alvo })
      }
      return
    }
    feito.criados.push(alvo)
    try {
      await fsp.utimes(alvo, atime, mtime)
    } catch (e) {
      if (!feito.avisouData) logger.warn('Data do arquivo não mantida na pasta nova', { alvo, erro: e.code || e.message })
      feito.avisouData = true
    }
    if ((await fsp.stat(alvo)).size !== size) throw Object.assign(new Error('cópia incompleta'), { code: 'EIO' })
    feito.apagaveis.push(rel)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * Copia sem substituir o que já está no destino, mantendo a data do arquivo.
 * `feito.apagaveis`: relativos conferidos no destino (podem sair da origem). `feito.criados`: arquivos que esta tentativa criou.
 * `feito.diferentes`: relativos mantidos na origem porque o destino tem outro conteúdo. `feito.interrompida`: `deveParar` cortou a cópia entre arquivos.
 * `feito.achouExistente`: algum arquivo já estava no destino. `feito.recusa`: motivo para não apagar nada; a cópia para aí e quem chama decide.
 */
async function copiar({ de, para, relativos, feito, logger, deveParar = () => false, tentativas = {}, aoCopiar = () => {} }) {
  for (const rel of relativos) {
    if (deveParar()) {
      feito.interrompida = true
      return feito
    }
    const contexto = { origem: path.join(de, rel), alvo: path.join(para, rel), rel, feito, logger }
    await comTentativas(() => copiarUm(contexto), { ...tentativas, deveParar })
    if (feito.recusa) return feito
    aoCopiar()
  }
  return feito
}

module.exports = { copiar, comTentativas, recusaDeMesmoArquivo, nomearSemSobrescrever, nomearSemSobrescreverSync, dormirDeVerdade }
