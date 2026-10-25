// ‹ 1 2 3 › — com reticências quando há muitas páginas.
function numeros(pagina, ultima) {
  const lista = []
  for (let p = 1; p <= ultima; p++) {
    if (p === 1 || p === ultima || Math.abs(p - pagina) <= 2) lista.push(p)
    else if (lista.at(-1) !== '…') lista.push('…')
  }
  return lista
}

export default function Paginacao({ pagina, total, porPagina, onIr }) {
  const ultima = Math.max(1, Math.ceil(total / porPagina))
  if (ultima <= 1) return null
  return (
    <nav className="paginacao" aria-label="Páginas">
      <button type="button" onClick={() => onIr(pagina - 1)} disabled={pagina <= 1} aria-label="Página anterior">
        ‹
      </button>
      {numeros(pagina, ultima).map((p, i) =>
        p === '…' ? (
          <span key={`r${i}`} className="paginacao-reticencias" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={p === pagina ? 'ativa' : undefined}
            aria-current={p === pagina ? 'page' : undefined}
            aria-label={`Página ${p}`}
            onClick={() => p !== pagina && onIr(p)}
          >
            {p}
          </button>
        ),
      )}
      <button type="button" onClick={() => onIr(pagina + 1)} disabled={pagina >= ultima} aria-label="Próxima página">
        ›
      </button>
    </nav>
  )
}
