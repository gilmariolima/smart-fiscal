import { Link } from 'react-router'

// Ícone de pasta + rótulo, como link para a pasta; sem `para`, pasta apagada (ainda não existe).
export default function Pasta({ para, children }) {
  const conteudo = (
    <>
      <svg className="pasta-icone" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
      </svg>
      <span>{children}</span>
    </>
  )
  if (!para) return <span className="pasta pasta-desativada">{conteudo}</span>
  return (
    <Link to={para} className="pasta">
      {conteudo}
    </Link>
  )
}
