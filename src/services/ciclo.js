'use strict'

// Ciclo por cliente: consulta por NSU → download por chave das notas com ciência enviada antes.
// O escritório não dá ciência: o dono da empresa dá, e o XML completo chega numa consulta seguinte.
// Um cliente por vez; erro em um cliente não interrompe os outros.
// Trava: em memória (mesmo processo) + no banco (CLI e servidor ao mesmo tempo).

const { criarServicoCaptura } = require('./captura')
const { criarServicoManifestacao } = require('./manifestacao')
const { criarServicoDownload } = require('./download')

const JANELA_TRAVA_MS = 30 * 60e3 // execução sem fim há mais de 30 min = processo que caiu

function criarServicoCiclo(deps) {
  const { db, logger, agora = () => new Date() } = deps
  const captura = criarServicoCaptura(deps)
  const manifestacao = criarServicoManifestacao(deps)
  const download = criarServicoDownload({ ...deps, captura })
  let rodando = false

  const sql = {
    emAndamento: db.prepare(`SELECT id, tipo, inicio FROM execucoes WHERE fim IS NULL AND tipo IN ('captura', 'ciencia', 'download')
      AND inicio > ? LIMIT 1`),
    ativos: db.prepare("SELECT * FROM clientes WHERE ativo = 1 AND papel = 'cliente' ORDER BY id"),
    escritorio: db.prepare("SELECT * FROM clientes WHERE papel = 'escritorio' AND ativo = 1 LIMIT 1"),
    porCnpj: db.prepare('SELECT * FROM clientes WHERE cnpj = ?'),
  }

  function cicloEmAndamento() {
    if (rodando) return 'Já existe um ciclo rodando neste processo.'
    const limite = new Date(agora().getTime() - JANELA_TRAVA_MS).toISOString()
    const exec = sql.emAndamento.get(limite)
    return exec ? `Já existe uma execução (${exec.tipo}) em andamento desde ${exec.inicio}.` : null
  }

  function clientesAlvo({ cnpj, cnpjs }) {
    if (cnpjs) {
      const achados = []
      for (const x of cnpjs) {
        const c = sql.porCnpj.get(x)
        if (!c) return { erro: `CNPJ ${x} não cadastrado.` }
        if (c.papel === 'escritorio') return { erro: `CNPJ ${x} é do escritório.` }
        achados.push(c)
      }
      return { clientes: achados.filter((c) => c.ativo === 1).sort((a, b) => a.id - b.id) }
    }
    if (!cnpj) return { clientes: sql.ativos.all() }
    const c = sql.porCnpj.get(cnpj)
    if (!c) return { erro: `CNPJ ${cnpj} não cadastrado.` }
    if (c.papel === 'escritorio') return { clientes: [], escritorio: c.ativo ? c : null }
    return { clientes: [c] }
  }

  function avisar(aoIniciarCliente, cnpj) {
    try {
      aoIniciarCliente?.(cnpj)
    } catch (e) {
      logger.error('Erro no aviso de cliente iniciado', { cnpj, erro: e.message })
    }
  }

  // Executa `passo` para cada cliente sob a trava.
  // O escritório (se existir e estiver ativo) roda antes, só com `passoEscritorio`.
  async function comTrava({ cnpj, cnpjs } = {}, passo, passoEscritorio, aoIniciarCliente) {
    const ocupado = cicloEmAndamento()
    if (ocupado) return { ok: false, erro: ocupado, clientes: [] }
    const { clientes, erro, escritorio: alvoEscritorio } = clientesAlvo({ cnpj, cnpjs })
    if (erro) return { ok: false, erro, clientes: [] }
    const escritorio = passoEscritorio ? (cnpj && !cnpjs ? alvoEscritorio : sql.escritorio.get()) : null
    rodando = true
    try {
      let resultadoEscritorio
      if (escritorio) {
        avisar(aoIniciarCliente, escritorio.cnpj)
        try {
          resultadoEscritorio = { cnpj: escritorio.cnpj, ...(await passoEscritorio(escritorio)) }
        } catch (e) {
          logger.error('Erro inesperado no ciclo do escritório', { cnpj: escritorio.cnpj, erro: e.message })
          resultadoEscritorio = { cnpj: escritorio.cnpj, erro: e.message }
        }
      }
      const resultados = []
      for (const cliente of clientes) {
        avisar(aoIniciarCliente, cliente.cnpj)
        try {
          resultados.push({ cnpj: cliente.cnpj, ...(await passo(cliente)) })
        } catch (e) {
          logger.error('Erro inesperado no ciclo do cliente', { cnpj: cliente.cnpj, erro: e.message })
          resultados.push({ cnpj: cliente.cnpj, erro: e.message })
        }
      }
      return resultadoEscritorio ? { ok: true, escritorio: resultadoEscritorio, clientes: resultados } : { ok: true, clientes: resultados }
    } finally {
      rodando = false
    }
  }

  /** Ciclo completo. `forcar` ignora a espera de 1 h da consulta por NSU (nunca o bloqueio do 656). */
  function executarCiclo({ cnpj, cnpjs, forcar = false, aoIniciarCliente } = {}) {
    return comTrava({ cnpj, cnpjs }, async (cliente) => ({
      captura: await captura.capturarCliente(cliente.id, { forcar }),
      download: await download.baixarPendentes(cliente.id),
    }), async (escritorio) => ({ captura: await captura.capturarCliente(escritorio.id, { forcar }) }), aoIniciarCliente)
  }

  const somenteDownload = ({ cnpj } = {}) => comTrava({ cnpj }, async (c) => ({ download: await download.baixarPendentes(c.id) }))

  return {
    executarCiclo,
    somenteDownload,
    manifestar: (args) => manifestacao.manifestar(args),
    cicloEmAndamento,
  }
}

module.exports = { criarServicoCiclo }
