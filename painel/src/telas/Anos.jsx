import { Link, useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { inteiro } from '../formato.js'

// Segundo nível de Notas: depois da empresa, o ano. Soma todos os tipos de nota.
export default function Anos() {
  const { cnpj } = useParams()
  const nome = useNomeDoCliente(cnpj)
  const { dados, erro, carregando } = useApi(`/api/clientes/${encodeURIComponent(cnpj)}/meses`, [cnpj])
  const anos = dados || []
  // Outros (CT-e em que o cliente não é tomador nem emitente) só aparecem se houver.
  const comOutros = anos.some((a) => a.outros > 0)

  let conteudo
  if (carregando && !dados) conteudo = <p className="vazio">Carregando…</p>
  else if (!anos.length) conteudo = !erro && <p className="vazio">Nenhuma nota capturada para este cliente.</p>
  else
    conteudo = (
      <>
        <div className="tabela-moldura">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Ano</th>
                <th scope="col" className="num">
                  Entradas
                </th>
                <th scope="col" className="num">
                  Saídas
                </th>
                {comOutros && (
                  <th scope="col" className="num">
                    Outros
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {anos.map((a) => (
                <tr key={a.ano}>
                  <td>
                    <Pasta para={`/notas/${cnpj}/${a.ano}`}>{a.ano}</Pasta>
                  </td>
                  <td className="num">{inteiro(a.entradas)}</td>
                  <td className="num">{inteiro(a.saidas)}</td>
                  {comOutros && <td className="num">{inteiro(a.outros)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rodape-tabela">
          Mostrando 1 até {inteiro(anos.length)} de {inteiro(anos.length)}
        </p>
      </>
    )

  return (
    <Pagina
      titulo={nome}
      subtitulo="Escolha o ano."
      trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: nome }]}
      acoes={
        <Link className="botao botao-claro" to={`/notas/${cnpj}/pendentes`}>
          XMLs não baixados
        </Link>
      }
      erro={erro}
    >
      {conteudo}
    </Pagina>
  )
}
