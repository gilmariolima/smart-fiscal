'use strict'

// Monta as dependências compartilhadas pela CLI e pelo servidor.

const { obterConfig } = require('./config')
const { criarLogger } = require('./logger')
const { abrirBanco } = require('./db')
const { criarFabricaSefaz } = require('./sefaz/client')
const { criarFabricaAdn } = require('./sefaz/adn')
const { criarFabricaCte } = require('./sefaz/cte')
const { criarServicoClientes, lerProcuradorCert } = require('./services/clientes')
const { criarServicoCiclo } = require('./services/ciclo')
const { criarConferenciaXmls } = require('./services/conferenciaXmls')
const { criarServicoImportacao } = require('./services/importacao')
const { criarNotasSemCliente } = require('./services/notasSemCliente')
const { criarServicoResumo } = require('./services/resumo')
const { criarServicoExportacao } = require('./services/exportacao')
const { criarServicoSelecao } = require('./services/selecao')
const { criarServicoExportacaoLote } = require('./services/exportacaoLote')
const { verificarAmbiente } = require('./ambiente')
const { criarAutomacao } = require('./services/automacao')
const { criarServicoBackup } = require('./services/backup')
const { criarServicoPastas } = require('./services/pastas')
const { criarOrganizador } = require('./services/pastaOrganizada')
const { migrarLayouts, limparResumosDeNotasCompletas } = require('./services/migracaoPastas')

// `verificarAmbiente: false` só para o comando que troca o ambiente do banco.
function criarContexto({ config = obterConfig(), logger, nivelConsole = 'info', db, fabricaSefaz, fabricaAdn, fabricaCte, agora, verificarAmbiente: verificar = true } = {}) {
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
  const deps = { db: banco, config, logger: log, fabricaSefaz: fabricaSefaz || criarFabricaSefaz(config), fabricaAdn: fabricaAdn || criarFabricaAdn(config, () => lerProcuradorCert({ db: banco, config })), fabricaCte: fabricaCte || criarFabricaCte(config) }
  if (agora) deps.agora = agora
  // Antes dos outros serviços: aplica as pastas escolhidas na tela Pastas.
  const pastas = criarServicoPastas(deps)
  // Uma vez só: XMLs dos formatos antigos para o atual. O que ficar pendente, o organizador tenta de novo.
  migrarLayouts({ db: banco, pastaXmls: config.pastaXmls, logger: log })
  limparResumosDeNotasCompletas({ db: banco, pastaXmls: config.pastaXmls, logger: log })
  const clientes = criarServicoClientes(deps)
  const ciclo = criarServicoCiclo(deps)
  // Com captura rodando, a pasta da empresa não muda de lugar: o grupo fica pendente e volta no fim do ciclo.
  const reconciliarPasta = (cliente) => {
    if (ciclo.cicloEmAndamento()) return ['Há uma captura em andamento: a pasta da empresa não muda de lugar agora. O Smart Fiscal tenta de novo quando ela terminar.']
    return clientes.reconciliarPasta(cliente)
  }
  // O servidor liga `deps.aoTerminarCiclo` ao organizador; a CLI fecha o banco logo após o ciclo e não gera nada.
  const organizador = criarOrganizador({ db: banco, config, logger: log, pastas, reconciliarPasta, capturaEmAndamento: () => ciclo.cicloEmAndamento() })
  const importacao = criarServicoImportacao(deps)
  return {
    config,
    logger: log,
    db: banco,
    deps,
    clientes,
    ciclo,
    resumo: criarServicoResumo(deps),
    exportacao: criarServicoExportacao(deps),
    selecao: criarServicoSelecao(deps),
    exportacaoLote: criarServicoExportacaoLote(deps),
    automacao: criarAutomacao(deps),
    backup: criarServicoBackup(deps),
    conferenciaXmls: criarConferenciaXmls(deps),
    importacao,
    notasSemCliente: criarNotasSemCliente({ ...deps, importacao }),
    pastas,
    organizador,
    fechar: () => banco.close(),
  }
}

module.exports = { criarContexto }
