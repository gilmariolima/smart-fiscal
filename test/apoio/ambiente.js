'use strict'

// Ambiente de teste: banco em memória, pasta de XMLs temporária, clientes cadastrados e SEFAZ simulada.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../../src/db')
const { criarSefazMock, CNPJ_MOCK_OK } = require('../../src/sefaz/mock-client')

const AGORA = new Date('2026-10-09T12:00:00Z')
const silencioso = { info() {}, warn() {}, error() {} }

function montarAmbiente({ clientes = [CNPJ_MOCK_OK], mock = criarSefazMock({ cienciaDoDono: true }), fabrica, agora = () => AGORA, config = {} } = {}) {
  const pastaXmls = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-teste-'))
  const db = abrirBanco(':memory:')
  const ins = db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, cert_arquivo, cert_senha_enc) VALUES (?, ?, ?, 'CE', 'x.pfx', 'a:b:c')`)
  const ids = clientes.map((cnpj, i) => Number(ins.run(cnpj, `Cliente ${i + 1} Ltda`, `Cliente ${i + 1}`).lastInsertRowid))
  const pausas = []
  const deps = {
    db,
    config: { pastaXmls, intervaloEntreChamadasMs: 2000, maxConsultasChavePorCiclo: 20, maxTentativasDownload: 5, ...config },
    logger: silencioso,
    fabricaSefaz: fabrica || ((c) => mock.cliente(c.cnpj)),
    dormir: async (ms) => pausas.push(ms),
    agora,
  }
  return { db, deps, mock, ids, pausas, pastaXmls, limpar: () => fs.rmSync(pastaXmls, { recursive: true, force: true }) }
}

/** Insere notas direto no banco (chaves sintéticas de 44 dígitos). */
function inserirNotas(db, clienteId, quantidade, { status = 'resumo', inicio = 1, ...extra } = {}) {
  const ins = db.prepare(`INSERT INTO notas (cliente_id, chave, status, cancelada, situacao_sefaz, competencia, ciencia_em, tentativas_download)
    VALUES (@cliente_id, @chave, @status, @cancelada, @situacao_sefaz, @competencia, @ciencia_em, @tentativas_download)`)
  const chaves = []
  for (let i = inicio; i < inicio + quantidade; i++) {
    // cUF+AAMM+CNPJ+mod+série (25) + nNF (9) + tpEmis (1) + cNF (8) + DV (1) = 44
    const chave = '2326101234567800019555001' + String(i).padStart(9, '0') + '1' + '00000000' + '0'
    ins.run({ cliente_id: clienteId, chave, status, cancelada: 0, situacao_sefaz: '1', competencia: '2026-10', ciencia_em: null, tentativas_download: 0, ...extra })
    chaves.push(chave)
  }
  return chaves
}

const nota = (db, chave) => db.prepare('SELECT * FROM notas WHERE chave = ?').get(chave)

module.exports = { montarAmbiente, inserirNotas, nota, AGORA, silencioso }
