import { useId, useState } from 'react'
import { Link } from 'react-router'

// Botão só com o ícone; o que ele faz aparece num balão ao passar o mouse (ou ao focar pelo teclado).
// O balão é o mesmo da Etiqueta (position: fixed, para a tabela-moldura não cortar).
export default function BotaoIcone({ icone, dica, to, onClick, disabled, perigo }) {
  const id = useId()
  const [posicao, setPosicao] = useState(null)

  function mostrar(e) {
    const r = e.currentTarget.getBoundingClientRect()
    setPosicao({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 })
  }
  const esconder = () => setPosicao(null)
  const props = {
    className: `botao-icone${perigo ? ' perigo' : ''}`,
    'aria-label': dica,
    'aria-describedby': id,
    onMouseEnter: mostrar,
    onMouseLeave: esconder,
    onFocus: mostrar,
    onBlur: esconder,
  }

  return (
    <>
      {to ? (
        <Link to={to} {...props}>
          <i className={`fa-solid ${icone}`} aria-hidden="true" />
        </Link>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled} {...props}>
          <i className={`fa-solid ${icone}`} aria-hidden="true" />
        </button>
      )}
      <span id={id} role="tooltip" className="dica" hidden={!posicao} style={posicao || undefined}>
        {dica}
      </span>
    </>
  )
}
