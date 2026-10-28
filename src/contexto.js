'use strict'

// Monta as dependências compartilhadas pela CLI e pelo servidor.

const { obterConfig } = require('./config')
const { criarLogger } = require('./logger')
const { abrirBanco } = require('./db')
const { criarFabricaSefaz } = require('./sefaz/client')
const { criarFabricaAdn } = require('./sefaz/adn')
const { criarServicoClientes } = require('./services/clientes')
const { criarServicoCiclo } = require('./services/ciclo')
const { criarServicoResumo } = require('./services/resumo')
const { criarServicoExportacao } = require('./services/exportacao')
const { criarServicoSelecao } = require('./services/selecao')
const { verificarAmbiente } = require('./ambiente')
const { criarAutomacao } = require('./services/automacao')
const { criarServicoBackup } = require('./services/backup')
const { criarServicoPastas } = require('./services/pastas')
const { migrarPastas } = require('./services/migracaoPastas')

// `verificarAmbiente: false` só para o comando que troca o ambiente do banco.
function criarContexto({ config = obterConfig(), logger, nivelConsole = 'info', db, fabricaSefaz, fabricaAdn, agora, verificarAmbiente: verificar = true } = {}) {
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
  const deps = { db: banco, config, logger: log, fabricaSefaz: fabricaSefaz || criarFabricaSefaz(config), fabricaAdn: fabricaAdn || criarFabricaAdn(config) }
  if (agora) deps.agora = agora
  // Antes dos outros serviços: aplica as pastas escolhidas na tela Pastas.
  const pastas = criarServicoPastas(deps)
  // Uma vez só: XMLs do formato antigo (AAAA-MM) para AAAA\MM\<modelo>\<direção>.
  migrarPastas({ db: banco, pastaXmls: config.pastaXmls, logger: log })
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
    pastas,
    fechar: () => banco.close(),
  }
}

module.exports = { criarContexto }
