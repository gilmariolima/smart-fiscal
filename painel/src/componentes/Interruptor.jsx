export default function Interruptor({ ligado, onChange, rotulo, descricao, desabilitado = false }) {
  return (
    <label className={`interruptor${desabilitado ? ' desabilitado' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={!!ligado}
        disabled={desabilitado}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="interruptor-chave" aria-hidden="true" />
      <span className="interruptor-texto">
        <span className="interruptor-rotulo">{rotulo}</span>
        {descricao && <small>{descricao}</small>}
      </span>
    </label>
  )
}
