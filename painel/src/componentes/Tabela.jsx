// Tabela com cabeçalho que ordena (▲/▼) e, se receber `selecao`, uma coluna de caixas de marcar.
// colunas: [{ chave, titulo, ordem?, classe?, render(linha) }]; ordem: '<coluna>-<asc|desc>'; cada linha precisa de `id`.
function Cabecalho({ coluna, ordem, onOrdenar }) {
  if (!coluna.ordem) {
    return (
      <th scope="col" className={coluna.classe}>
        {coluna.titulo}
      </th>
    )
  }
  const [campo, sentido] = (ordem || '').split('-')
  const ativa = campo === coluna.ordem
  const proxima = `${coluna.ordem}-${ativa && sentido === 'asc' ? 'desc' : 'asc'}`
  return (
    <th scope="col" className={coluna.classe} aria-sort={ativa ? (sentido === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className={`ordenar${ativa ? ' ativa' : ''}`} onClick={() => onOrdenar(proxima)}>
        {coluna.titulo}
        <span className="ordenar-seta" aria-hidden="true">
          {ativa ? (sentido === 'asc' ? '▲' : '▼') : '▲▼'}
        </span>
      </button>
    </th>
  )
}

export default function Tabela({ colunas, linhas, ordem, onOrdenar, selecao, rotuloDaLinha = (l) => `Marcar a linha ${l.id}` }) {
  const idsDaPagina = linhas.map((l) => l.id)
  const todasMarcadas = !!selecao && idsDaPagina.length > 0 && idsDaPagina.every((id) => selecao.ids.has(id))
  const algumaMarcada = !!selecao && idsDaPagina.some((id) => selecao.ids.has(id))
  return (
    <div className="tabela-moldura">
      <table className="tabela tabela-notas">
        <thead>
          <tr>
            {selecao && (
              <th scope="col" className="marcar">
                <input
                  type="checkbox"
                  aria-label="Marcar as notas desta página"
                  checked={todasMarcadas}
                  ref={(caixa) => {
                    if (caixa) caixa.indeterminate = algumaMarcada && !todasMarcadas
                  }}
                  onChange={() => (todasMarcadas ? selecao.desmarcar(idsDaPagina) : selecao.marcar(idsDaPagina))}
                />
              </th>
            )}
            {colunas.map((c) => (
              <Cabecalho key={c.chave} coluna={c} ordem={ordem} onOrdenar={onOrdenar} />
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => {
            const marcada = !!selecao?.ids.has(linha.id)
            return (
              <tr key={linha.id} className={marcada ? 'selecionada' : undefined}>
                {selecao && (
                  <td className="marcar">
                    <input
                      type="checkbox"
                      aria-label={rotuloDaLinha(linha)}
                      checked={marcada}
                      onChange={() => selecao.alternar(linha.id)}
                    />
                  </td>
                )}
                {colunas.map((c) => (
                  <td key={c.chave} className={c.classe}>
                    {c.render(linha)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
