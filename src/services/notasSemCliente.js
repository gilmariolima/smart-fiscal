'use strict'

// Notas em "Sem cliente cadastrado" (pasta do escritório) vão para o cliente quando ele é cadastrado.
// Cada XML passa pelo Importar só da carteira: com dono, grava nele; sem dono, fica onde está.

const fs = require('node:fs')
const path = require('node:path')
const { pastaDoClienteNoDisco, pastasDoClienteNoBanco, pastasPendentesDoCliente, PASTAS } = require('./armazenamento')

const NOTA = /-(nfe|cte|nfse)\.xml$/i
const cederAVez = () => new Promise((r) => setImmediate(r))

function criarNotasSemCliente({ db, config, logger, importacao }) {
  // A pasta do escritório pode estar com o nome antigo, se ainda não foi renomeada.
  function pastas(escritorio) {
    const todos = db.prepare('SELECT cnpj, papel, apelido, razao_social FROM clientes').all()
    const nomes = new Set([pastaDoClienteNoDisco(escritorio, todos), ...pastasDoClienteNoBanco(db, escritorio.id), ...pastasPendentesDoCliente(db, escritorio.id)])
    return [...nomes].map((n) => path.join(config.pastaXmls, n, PASTAS.foraDaCarteira)).filter((d) => fs.existsSync(d))
  }

  // Tira o arquivo e as pastas que ficaram vazias, sem tirar a própria pasta das notas sem cliente.
  function tirar(arquivo, raiz) {
    fs.rmSync(arquivo, { force: true })
    for (let d = path.dirname(arquivo); d !== raiz && d.startsWith(raiz); d = path.dirname(d)) {
      try {
        fs.rmdirSync(d)
      } catch {
        break
      }
    }
  }

  /** @returns {Promise<{ levadas: number, ficaram: number, falhas: number, clientesAfetados: number[] }>} */
  async function levar() {
    const r = { levadas: 0, ficaram: 0, falhas: 0, clientesAfetados: [] }
    const escritorio = db.prepare("SELECT * FROM clientes WHERE papel = 'escritorio'").get()
    if (!escritorio || !config.pastaXmls) return r
    const afetados = new Set()
    for (const raiz of pastas(escritorio)) {
      const arquivos = fs.readdirSync(raiz, { recursive: true, withFileTypes: true }).filter((i) => i.isFile() && NOTA.test(i.name))
      for (const item of arquivos) {
        await cederAVez()
        const arquivo = path.join(item.parentPath, item.name)
        try {
          const ri = importacao.importar([{ nome: item.name, bytes: fs.readFileSync(arquivo) }], { soDaCarteira: true })
          const gravadas = Object.values(ri.importadas).reduce((s, d) => s + Object.values(d).reduce((a, b) => a + b, 0), 0)
          if (ri.ignoradas.length || !(gravadas || ri.jaExistiam)) {
            r.ficaram++
            continue
          }
          ri.clientesAfetados.forEach((id) => afetados.add(id))
          tirar(arquivo, raiz)
          r.levadas++
        } catch (e) {
          r.falhas++
          logger.warn('Nota sem cliente não levada; tenta de novo na próxima vez', { arquivo: item.name, erro: e.code || e.message })
        }
      }
    }
    r.clientesAfetados = [...afetados]
    if (r.levadas || r.falhas) logger.info('Notas sem cliente levadas aos clientes', { levadas: r.levadas, ficaram: r.ficaram, falhas: r.falhas })
    return r
  }

  return { levar }
}

module.exports = { criarNotasSemCliente }
