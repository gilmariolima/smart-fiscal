import { Fragment } from 'react'
import { Link } from 'react-router'

export default function Trilha({ partes }) {
  if (!partes?.length) return null
  return (
    <nav className="trilha" aria-label="Você está em">
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
