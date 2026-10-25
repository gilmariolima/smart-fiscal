import { useSped } from './SpedProvider.jsx'

// "Gerando o SPED…" por cima da tela e os avisos no canto (somem sozinhos).
export default function Camadas() {
  const { processando, avisos } = useSped()
  return (
    <>
      {processando && (
        <div className="processando" role="status">
          <div><span className="spin" />{processando}</div>
        </div>
      )}
      <div className="toast-area" aria-live="polite">
        {avisos.map((a) => (
          <div key={a.id} className={`toast toast-${a.tipo}`}>
            <i className={`fa-solid ${a.tipo === 'ok' ? 'fa-circle-check' : 'fa-triangle-exclamation'}`} />
            <span>{a.msg}</span>
          </div>
        ))}
      </div>
    </>
  )
}
