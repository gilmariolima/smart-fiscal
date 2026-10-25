// Code 128 conjunto C (pares de dígitos), o código de barras da chave no DANFE.
// Cada padrão são as larguras alternadas barra/espaço/barra/espaço/barra/espaço (a parada tem 7).
export const PADROES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

const INICIO_C = 105
const PARADA = 106

/** Valores dos símbolos (início, pares, verificador, parada) de uma sequência com número par de dígitos. */
export function simbolosC(digitos) {
  if (!/^(\d\d)+$/.test(digitos || '')) return null
  const pares = digitos.match(/\d\d/g).map(Number)
  const verificador = pares.reduce((soma, v, i) => soma + v * (i + 1), INICIO_C) % 103
  return [INICIO_C, ...pares, verificador, PARADA]
}

/** Barras como [{x, largura}] em módulos, e a largura total (com 10 módulos de margem de cada lado). */
export function barrasC(digitos) {
  const simbolos = simbolosC(digitos)
  if (!simbolos) return null
  const barras = []
  let x = 10
  for (const s of simbolos) {
    ;[...PADROES[s]].forEach((w, i) => {
      if (i % 2 === 0) barras.push({ x, largura: Number(w) })
      x += Number(w)
    })
  }
  return { barras, largura: x + 10 }
}
