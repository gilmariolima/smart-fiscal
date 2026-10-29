import { useParams } from 'react-router'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { inteiro } from '../formato.js'
import { MODELOS } from './PastasDoMes.jsx'

// Primeira pasta do cliente: o tipo de nota. CT-e ainda não é capturado.
function Linha({ cnpj, slug, modelo }) {
  const { dados } = useApi(`/api/notas?cnpj=${cnpj}&modelo=${modelo.valor}&somenteContagem=1`, [cnpj, modelo.valor])
  const c = dados?.contagemTipo
  return (
    <tr>
      <td>
        <Pasta para={`/notas/${cnpj}/${slug}`}>{modelo.rotulo}</Pasta>
      </td>
      <td className="num">{c ? inteiro(c.entradas) : '…'}</td>
      <td className="num">{c ? inteiro(c.saidas) : '…'}</td>
    </tr>
  )
}

export default function Modelos() {
  const { cnpj } = useParams()
  const nome = useNomeDoCliente(cnpj)
  return (
    <Pagina titulo="Notas" subtitulo="Escolha o tipo de nota." trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: nome }]}>
      <div className="tabela-moldura">
        <table className="tabela">
          <thead>
            <tr>
              <th scope="col">Tipo de nota</th>
              <th scope="col" className="num">
                Entradas
              </th>
              <th scope="col" className="num">
                Saídas
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MODELOS).map(([slug, modelo]) => (
              <Linha key={slug} cnpj={cnpj} slug={slug} modelo={modelo} />
            ))}
            <tr>
              <td>
                <Pasta>
                  CT-e <Etiqueta cor="cinza">Em breve</Etiqueta>
                </Pasta>
              </td>
              <td className="num">—</td>
              <td className="num">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Pagina>
  )
}
