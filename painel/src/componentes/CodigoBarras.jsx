import { barrasC } from '../code128.js'

// Código de barras da chave de acesso (Code 128 C), desenhado em SVG.
export default function CodigoBarras({ digitos, altura = 40 }) {
  const desenho = barrasC(digitos)
  if (!desenho) return null
  return (
    <svg
      className="codigo-barras"
      viewBox={`0 0 ${desenho.largura} ${altura}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Código de barras da chave ${digitos}`}
    >
      {desenho.barras.map((b) => (
        <rect key={b.x} x={b.x} y="0" width={b.largura} height={altura} />
      ))}
    </svg>
  )
}
