// Botões lado a lado em que só um fica ativo (ex.: Todas · Entradas · Saídas).
export default function Segmentado({ opcoes, valor, onChange, rotulo }) {
  return (
    <div className="segmentado" role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          className={o.valor === valor ? 'ativo' : undefined}
          aria-pressed={o.valor === valor}
          onClick={() => o.valor !== valor && onChange(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  )
}
