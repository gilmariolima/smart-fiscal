import { useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { inteiro } from '../formato.js'

export default function Anos() {
  const { cnpj } = useParams()
  const nome = useNomeDoCliente(cnpj)
  const { dados, erro, carregando } = useApi(`/api/clientes/${encodeURIComponent(cnpj)}/meses`, [cnpj])
  const anos = dados || []

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
    <Pagina titulo="NF-es" subtitulo="Escolha o ano." trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: nome }]} erro={erro}>
      {conteudo}
    </Pagina>
  )
}
