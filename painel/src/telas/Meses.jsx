import { Navigate, useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { NOMES_DOS_MESES, inteiro } from '../formato.js'
import { MODELOS } from '../modelos.js'

export default function Meses() {
  const { cnpj, modelo: slug, ano } = useParams()
  const modelo = MODELOS[slug]
  const nome = useNomeDoCliente(cnpj)
  const { dados, erro, carregando } = useApi(`/api/clientes/${encodeURIComponent(cnpj)}/meses?modelo=${modelo?.valor || 'nfe'}`, [cnpj, slug])
  const grupo = (dados || []).find((a) => String(a.ano) === ano)
  const meses = grupo?.meses || []
  if (!modelo) return <Navigate to={`/notas/${cnpj}`} replace />

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
                    <Pasta para={`/notas/${cnpj}/${slug}/${ano}/${String(m.mes).padStart(2, '0')}`}>{NOMES_DOS_MESES[m.mes - 1]}</Pasta>
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
      titulo={modelo.rotulo}
      subtitulo="Escolha o mês."
      trilha={[
        { rotulo: 'Início', para: '/notas' },
        { rotulo: modelo.rotulo, para: `/notas/${slug}` },
        { rotulo: nome, para: `/notas/${cnpj}/${slug}` },
        { rotulo: ano },
      ]}
      erro={erro}
    >
      {conteudo}
    </Pagina>
  )
}
