export default function FaixaErro({ mensagem, aoFechar }) {
  if (!mensagem) return null
  return (
    <div className="faixa faixa-erro" role="alert">
      <span>{mensagem}</span>
      {aoFechar && (
        <button type="button" className="faixa-fechar" onClick={aoFechar} aria-label="Fechar aviso">
          ×
        </button>
      )}
    </div>
  )
}
