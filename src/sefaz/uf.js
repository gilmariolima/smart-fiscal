'use strict'

// Código IBGE (cUFAutor) e fuso usado no dhEvento da manifestação.
// Os fusos são os aceitos pelo node-mde.
const UFS = {
  AC: { codigo: '12', fuso: 'America/Rio_Branco' },
  AL: { codigo: '27', fuso: 'America/Maceio' },
  AP: { codigo: '16', fuso: 'America/Belem' },
  AM: { codigo: '13', fuso: 'America/Manaus' },
  BA: { codigo: '29', fuso: 'America/Bahia' },
  CE: { codigo: '23', fuso: 'America/Fortaleza' },
  DF: { codigo: '53', fuso: 'America/Sao_Paulo' },
  ES: { codigo: '32', fuso: 'America/Sao_Paulo' },
  GO: { codigo: '52', fuso: 'America/Sao_Paulo' },
  MA: { codigo: '21', fuso: 'America/Fortaleza' },
  MT: { codigo: '51', fuso: 'America/Cuiaba' },
  MS: { codigo: '50', fuso: 'America/Campo_Grande' },
  MG: { codigo: '31', fuso: 'America/Sao_Paulo' },
  PA: { codigo: '15', fuso: 'America/Belem' },
  PB: { codigo: '25', fuso: 'America/Recife' },
  PR: { codigo: '41', fuso: 'America/Sao_Paulo' },
  PE: { codigo: '26', fuso: 'America/Recife' },
  PI: { codigo: '22', fuso: 'America/Fortaleza' },
  RJ: { codigo: '33', fuso: 'America/Sao_Paulo' },
  RN: { codigo: '24', fuso: 'America/Fortaleza' },
  RS: { codigo: '43', fuso: 'America/Sao_Paulo' },
  RO: { codigo: '11', fuso: 'America/Porto_Velho' },
  RR: { codigo: '14', fuso: 'America/Boa_Vista' },
  SC: { codigo: '42', fuso: 'America/Sao_Paulo' },
  SP: { codigo: '35', fuso: 'America/Sao_Paulo' },
  SE: { codigo: '28', fuso: 'America/Maceio' },
  TO: { codigo: '17', fuso: 'America/Araguaina' },
}

/** Dados da UF pela sigla ('CE'). Lança erro se a sigla não existir. */
function dadosUf(sigla) {
  const uf = UFS[String(sigla || '').trim().toUpperCase()]
  if (!uf) throw new Error(`UF inválida: ${sigla}`)
  return uf
}

module.exports = { UFS, dadosUf }
