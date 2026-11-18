'use strict'

// Chaves das NF-e de um SPED Fiscal (EFD ICMS/IPI): o 0000 diz de quem é o arquivo e o C100 traz cada nota do mês.
// 0000: 02 COD_VER | 03 COD_FIN | 04 DT_INI | 05 DT_FIN | 06 NOME | 07 CNPJ ...
// C100: 02 IND_OPER (0 entrada, 1 saída) | 03 IND_EMIT | 04 COD_PART | 05 COD_MOD | 06 COD_SIT | 07 SER | 08 NUM_DOC | 09 CHV_NFE ...

/** @returns {{ cnpj: string, periodo: string|null, chaves: { chave: string, direcao: 'entrada'|'saida' }[] }} */
function lerChavesDoSped(bytes) {
  // O SPED é gravado em Latin-1; as chaves e os indicadores são só dígitos, então qualquer leitura serve para eles.
  const texto = Buffer.from(bytes).toString('latin1')
  let cnpj = null
  let periodo = null
  const vistas = new Set()
  const chaves = []
  for (const linha of texto.split(/\r?\n/)) {
    if (linha.startsWith('|0000|')) {
      const c = linha.split('|')
      const deste = String(c[7] || '').replace(/\D/g, '') || null
      if (cnpj && deste !== cnpj) throw new Error('O arquivo junta SPEDs de mais de um CNPJ: solte um arquivo por empresa')
      cnpj = deste
      const ini = String(c[4] || '')
      periodo = /^\d{8}$/.test(ini) ? `${ini.slice(4)}-${ini.slice(2, 4)}` : null
      continue
    }
    if (!linha.startsWith('|C100|')) continue
    const c = linha.split('|')
    const chave = String(c[9] || '').trim()
    // Denegada (04) e inutilizada (05) não têm XML autorizado para baixar.
    if (c[5] !== '55' || ['04', '05'].includes(c[6]) || !/^\d{44}$/.test(chave) || vistas.has(chave)) continue
    vistas.add(chave)
    chaves.push({ chave, direcao: c[2] === '1' ? 'saida' : 'entrada' })
  }
  if (!cnpj) throw new Error('O arquivo não é um SPED Fiscal (falta o registro 0000 com o CNPJ)')
  return { cnpj, periodo, chaves }
}

module.exports = { lerChavesDoSped }
