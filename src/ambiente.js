'use strict'

// Cada banco pertence a um ambiente: homologação, produção ou SEFAZ simulada.
// O NSU (posição na fila da SEFAZ) e as notas de um ambiente não valem no outro, então o
// sistema recusa rodar com o .env apontando para outro ambiente. A única troca permitida é
// homologação → produção (ambiente:producao), que zera os NSU e descarta as notas de teste.

const fs = require('node:fs')
const path = require('node:path')

const NOMES = { homologacao: 'homologação', producao: 'produção', simulada: 'SEFAZ simulada' }
const NSU_ZERO = '000000000000000'

function ambienteDaConfig(config) {
  if (config.sefazMock) return 'simulada'
  return config.tpAmb === '1' ? 'producao' : 'homologacao'
}

function ambienteDoBanco(db) {
  return db.prepare("SELECT valor FROM sistema WHERE chave = 'ambiente'").get()?.valor || null
}

function gravarAmbiente(db, ambiente) {
  db.prepare("INSERT INTO sistema (chave, valor) VALUES ('ambiente', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(ambiente)
}

const bancoVazio = (db) => !db.prepare('SELECT 1 FROM clientes LIMIT 1').get() && !db.prepare('SELECT 1 FROM notas LIMIT 1').get()

/**
 * Confere se o .env está no mesmo ambiente do banco. Banco novo ou vazio adota o ambiente do .env.
 * Lança Error com a orientação para o usuário.
 */
function verificarAmbiente(db, config) {
  const atual = ambienteDaConfig(config)
  const salvo = ambienteDoBanco(db)
  if (salvo === atual) return atual
  if (!salvo || bancoVazio(db)) {
    gravarAmbiente(db, atual)
    return atual
  }
  if (salvo === 'homologacao' && atual === 'producao') {
    throw new Error('Este banco foi usado em homologação e o .env agora está em produção (TP_AMB=1). '
      + 'Para passar para produção, rode: node src/cli.js ambiente:producao (zera a posição na fila da SEFAZ de todos os clientes e descarta as notas de teste).')
  }
  throw new Error(`Este banco é de ${NOMES[salvo]} e o .env está em ${NOMES[atual]}. `
    + `Volte o .env para ${NOMES[salvo]} ou use outra pasta de dados (PASTA_DADOS) para ${NOMES[atual]}.`)
}

/** O que a passagem para produção vai descartar. */
function previaProducao(db) {
  const conta = (sql) => db.prepare(sql).get().n
  return {
    ambienteBanco: ambienteDoBanco(db),
    clientes: conta('SELECT COUNT(*) n FROM clientes'),
    notas: conta('SELECT COUNT(*) n FROM notas'),
    eventos: conta('SELECT COUNT(*) n FROM eventos'),
  }
}

/**
 * Homologação → produção: zera NSU, esperas e erros de todos os clientes, apaga notas e eventos
 * de teste (e os XMLs delas) e marca o banco como produção. Clientes e certificados ficam.
 */
/** Lança Error se a troca não puder ser feita (chamado antes de pedir confirmação). */
function conferirTrocaParaProducao(db, config) {
  if (ambienteDaConfig(config) !== 'producao') throw new Error('Mude o .env para produção (TP_AMB=1, sem SEFAZ_MOCK) antes de rodar este comando.')
  const salvo = ambienteDoBanco(db)
  if (salvo === 'producao') throw new Error('Este banco já está em produção.')
  if (salvo && salvo !== 'homologacao') throw new Error(`Este banco é de ${NOMES[salvo]}; só dá para passar para produção a partir de homologação. Use outra pasta de dados.`)
}

function passarParaProducao({ db, config, logger }) {
  conferirTrocaParaProducao(db, config)

  const arquivos = db.prepare('SELECT caminho_xml FROM notas WHERE caminho_xml IS NOT NULL').all().map((n) => n.caminho_xml)
  const r = db.transaction(() => {
    const eventos = db.prepare('DELETE FROM eventos').run().changes
    const notas = db.prepare('DELETE FROM notas').run().changes
    const clientes = db.prepare(`UPDATE clientes SET ult_nsu = ?, max_nsu = NULL, proxima_consulta = NULL, bloqueado_ate = NULL,
      ultima_consulta = NULL, ultimo_erro = NULL`).run(NSU_ZERO).changes
    gravarAmbiente(db, 'producao')
    return { clientes, notas, eventos }
  })()

  // XMLs de teste: só de dentro da pasta de XMLs.
  const base = path.resolve(config.pastaXmls)
  let xmls = 0
  for (const relativo of arquivos) {
    const alvo = path.resolve(base, relativo)
    if (!alvo.startsWith(base + path.sep)) continue
    try {
      fs.rmSync(alvo)
      xmls++
    } catch {
      // já não existia
    }
  }
  logger?.info('Banco passado de homologação para produção', { ...r, xmls })
  return { ...r, xmls }
}

module.exports = { NOMES, ambienteDaConfig, ambienteDoBanco, verificarAmbiente, previaProducao, conferirTrocaParaProducao, passarParaProducao }
