import { inteiro, plural } from '../formato.js'

export default function ReciboExportacao({ r, aoFechar }) {
  return (
    <section className="recibo" aria-label="Exportação do mês">
      <div className="recibo-topo">
        <strong>Pacote gerado: {r.nome}</strong>
        <button type="button" className="faixa-fechar" onClick={aoFechar} aria-label="Fechar">
          ×
        </button>
      </div>
      <p>
        {plural(r.xmls, 'XML', 'XMLs')} ({inteiro(r.porTipo?.entrada?.xmls)} de entrada, {inteiro(r.porTipo?.saida?.xmls)} de saída),{' '}
        {plural(r.canceladas, 'cancelada', 'canceladas')}, {inteiro(r.semXml)} sem XML completo · {plural(r.totalNotas, 'nota', 'notas')} na
        planilha notas.xlsx.
      </p>
      {!!r.avisos?.length && (
        <ul className="recibo-avisos">
          {r.avisos.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <a className="botao botao-azul" href={r.url} download={r.nome}>
        ⤓ Baixar ZIP da exportação
      </a>
    </section>
  )
}
