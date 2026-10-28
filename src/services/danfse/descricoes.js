'use strict'

// Descrições dos códigos do leiaute da NFS-e Nacional para o DANFSe (NT 008/2026, item 2.4.5).
// Fonte: Anexo I (SEFIN_ADN-DPS_NFSe v1.01, 09/02/2026) e Anexo A (municípios IBGE) do Sistema Nacional NFS-e.

const DESCRICOES = {
  tpEmit: { 1: 'Prestador', 2: 'Tomador', 3: 'Intermediário' },
  cStat: { 100: 'NFS-e Gerada', 102: 'NFS-e de Decisão Judicial ou Administrativa', 103: 'NFS-e Avulsa', 107: 'NFS-e MEI' },
  finNFSe: { 0: 'NFS-e regular' },
  ambGer: { 1: 'Sistema próprio do município', 2: 'Sistema Nacional NFS-e' },
  tpAmb: { 1: 'Produção', 2: 'Homologação' },
  opSimpNac: { 1: 'Não Optante', 2: 'Optante - Microempreendedor Individual (MEI)', 3: 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)' },
  regApTribSN: {
    1: 'Regime de apuração dos tributos federais e municipal pelo SN',
    2: 'Regime de apuração dos tributos federais pelo SN e o ISSQN pela NFS-e conforme respectiva legislação municipal do tributo',
    3: 'Regime de apuração dos tributos federais e municipal pela NFS-e conforme respectivas legislações federal e municipal de cada tributo',
  },
  regEspTrib: { 0: 'Nenhum', 1: 'Ato Cooperado (Cooperativa)', 2: 'Estimativa', 3: 'Microempresa Municipal', 4: 'Notário ou Registrador', 5: 'Profissional Autônomo', 6: 'Sociedade de Profissionais', 9: 'Outros' },
  tribISSQN: { 1: 'Operação tributável', 2: 'Imunidade', 3: 'Exportação de serviço', 4: 'Não Incidência' },
  tpRetISSQN: { 1: 'Não Retido', 2: 'Retido pelo Tomador', 3: 'Retido pelo Intermediário' },
  tpImunidade: {
    0: 'Imunidade (tipo não informado na nota de origem)',
    1: 'Patrimônio, renda ou serviços, uns dos outros',
    2: 'Entidades religiosas e templos de qualquer culto',
    3: 'Patrimônio, renda ou serviços dos partidos políticos, sindicatos, educação e assistência social',
    4: 'Livros, jornais, periódicos e o papel destinado a sua impressão',
    5: 'Fonogramas e videofonogramas musicais produzidos no Brasil',
  },
  tpSusp: { 1: 'Exigibilidade Suspensa por Decisão Judicial', 2: 'Exigibilidade Suspensa por Processo Administrativo' },
  tpBM: { 1: 'Isenção', 2: 'Redução da BC em percentual', 3: 'Redução da BC em valor', 4: 'Alíquota diferenciada' },
  tpRetPisCofins: {
    0: 'PIS/COFINS/CSLL Não Retidos',
    1: 'PIS/COFINS Retido',
    2: 'PIS/COFINS Não Retido',
    3: 'PIS/COFINS/CSLL Retidos',
    4: 'PIS/COFINS Retidos, CSLL Não Retido',
    5: 'PIS Retido, COFINS/CSLL Não Retido',
    6: 'COFINS Retido, PIS/CSLL Não Retido',
    7: 'PIS Não Retido, COFINS/CSLL Retidos',
    8: 'PIS/COFINS Não Retidos, CSLL Retido',
    9: 'COFINS Não Retido, PIS/CSLL Retidos',
  },
}

const MUNICIPIOS = require('./municipios.json')

/** Descrição do código ou null (o DANFSe mostra "-"). */
const descricao = (campo, codigo) => (codigo === null || codigo === undefined || codigo === '' ? null : DESCRICOES[campo]?.[String(Number(codigo))] ?? String(codigo))

/** "Município / UF" pelo código IBGE de 7 dígitos. */
const municipio = (cMun) => (cMun ? MUNICIPIOS[String(cMun)] || null : null)

module.exports = { descricao, municipio, DESCRICOES }
