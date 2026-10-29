import { Fragment } from 'react'
import { Link, useNavigate } from 'react-router'

// Seta "voltar" antes da trilha: página anterior do histórico; aberta direto (sem histórico), sobe um nível.
function Voltar({ partes }) {
  const navegar = useNavigate()
  const acima = [...partes.slice(0, -1)].reverse().find((p) => p.para)
  function voltar() {
    if ((window.history.state?.idx ?? 0) > 0) navegar(-1)
    else if (acima) navegar(acima.para)
  }
  return (
    <button type="button" className="trilha-voltar" onClick={voltar} aria-label="Voltar" title="Voltar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  )
}

export default function Trilha({ partes }) {
  if (!partes?.length) return null
  return (
    <nav className="trilha" aria-label="Você está em">
      {partes.length > 1 && <Voltar partes={partes} />}
      {partes.map((parte, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="trilha-separador" aria-hidden="true">
              \
            </span>
          )}
          {parte.para ? (
            <Link to={parte.para}>{parte.rotulo}</Link>
          ) : (
            <span aria-current={i === partes.length - 1 ? 'page' : undefined}>{parte.rotulo}</span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}
