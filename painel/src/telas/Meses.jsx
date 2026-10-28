import { useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { NOMES_DOS_MESES, inteiro } from '../formato.js'


export default function Meses() {
  const { cnpj, ano } = useParams()
  const nome = useNomeDoCliente(cnpj)
  const { dados, erro, carregando } = useApi(`/api/clientes/${encodeURIComponent(cnpj)}/meses`, [cnpj])
  const grupo = (dados || []).find((a) => String(a.ano) === ano)
  const meses = grupo?.meses || []

  let conteudo
  if (carregando && !dados) conteudo = <p className="vazio">Carregando…</p>
  else if (!meses.length) conteudo = !erro && <p className="vazio">Nenhuma nota capturada neste ano.</p>
  else
    conteudo = (
      <>
        <div className="tabela-moldura">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Mês</th>
                <th scope="col" className="num">
                  Entradas
                </th>
                <th scope="col" className="num">
                  Saídas
                </th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.mes}>
                  <td>
                    <Pasta para={`/notas/${cnpj}/${ano}/${String(m.mes).padStart(2, '0')}`}>{NOMES_DOS_MESES[m.mes - 1]}</Pasta>
                  </td>
                  <td className="num">{inteiro(m.entradas)}</td>
                  <td className="num">{inteiro(m.saidas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rodape-tabela">
          Mostrando 1 até {inteiro(meses.length)} de {inteiro(meses.length)}
        </p>
      </>
    )

  return (
    <Pagina
      titulo="Notas"
      subtitulo="Escolha o mês."
      trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: nome, para: `/notas/${cnpj}` }, { rotulo: ano }]}
      erro={erro}
    >
      {conteudo}
    </Pagina>
  )
}
