import { useId, useState } from 'react'

const CORES = new Set(['verde', 'ambar', 'vermelha', 'cinza'])
const LARGURA_DICA = 320
const ALTURA_DICA = 160

// O título vira um balão próprio (aparece na hora, aceita várias linhas). Fica com position: fixed
// para não ser cortado pela tabela-moldura, que tem overflow.
export default function Etiqueta({ cor = 'cinza', titulo, children }) {
  const id = useId()
  const [posicao, setPosicao] = useState(null)
  const classe = `etiqueta etiqueta-${CORES.has(cor) ? cor : 'cinza'}`
  if (!titulo) return <span className={classe}>{children}</span>

  function mostrar(e) {
    const r = e.currentTarget.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - LARGURA_DICA - 8))
    const embaixo = r.bottom + ALTURA_DICA < window.innerHeight
    setPosicao(embaixo ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 })
  }
  const esconder = () => setPosicao(null)

  return (
    <>
      <span
        className={`${classe} com-dica`}
        tabIndex={0}
        aria-describedby={id}
        onMouseEnter={mostrar}
        onMouseLeave={esconder}
        onFocus={mostrar}
        onBlur={esconder}
      >
        {children}
      </span>
      <span id={id} role="tooltip" className="dica" hidden={!posicao} style={posicao || undefined}>
        {titulo}
      </span>
    </>
  )
}
