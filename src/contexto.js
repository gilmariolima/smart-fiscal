'use strict'

// Monta as dependências compartilhadas pela CLI e pelo servidor.

const { obterConfig } = require('./config')
const { criarLogger } = require('./logger')
const { abrirBanco } = require('./db')
const { criarFabricaSefaz } = require('./sefaz/client')
const { criarServicoClientes } = require('./services/clientes')
const { criarServicoCiclo } = require('./services/ciclo')
const { criarServicoResumo } = require('./services/resumo')
const { criarServicoExportacao } = require('./services/exportacao')
const { criarServicoSelecao } = require('./services/selecao')
const { verificarAmbiente } = require('./ambiente')
const { criarAutomacao } = require('./services/automacao')
const { criarServicoBackup } = require('./services/backup')

// `verificarAmbiente: false` só para o comando que troca o ambiente do banco.
function criarContexto({ config = obterConfig(), logger, nivelConsole = 'info', db, fabricaSefaz, agora, verificarAmbiente: verificar = true } = {}) {
  const log = logger || criarLogger({ pasta: config.pastaLogs, nivelConsole })
  const banco = db || abrirBanco(config.caminhoBanco)
  if (verificar) {
    try {
      verificarAmbiente(banco, config)
    } catch (e) {
      if (!db) banco.close()
      throw e
    }
  }
  const deps = { db: banco, config, logger: log, fabricaSefaz: fabricaSefaz || criarFabricaSefaz(config) }
  if (agora) deps.agora = agora
  return {
    config,
    logger: log,
    db: banco,
    deps,
    clientes: criarServicoClientes(deps),
    ciclo: criarServicoCiclo(deps),
    resumo: criarServicoResumo(deps),
    exportacao: criarServicoExportacao(deps),
    selecao: criarServicoSelecao(deps),
    automacao: criarAutomacao(deps),
    backup: criarServicoBackup(deps),
    fechar: () => banco.close(),
  }
}

module.exports = { criarContexto }
