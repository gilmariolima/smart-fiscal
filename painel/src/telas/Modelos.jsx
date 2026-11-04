import { useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { NOMES_DOS_MESES, inteiro } from '../formato.js'
import { MODELOS } from '../modelos.js'

// Uma pasta por tipo de nota do mês; conta só as notas com XML. Tipo sem nota aparece apagado, para a lista não mudar.
function LinhaTipo({ cnpj, ano, mes, slug, modelo }) {
  const { dados } = useApi(`/api/notas?cnpj=${cnpj}&competencia=${ano}-${mes}&modelo=${modelo.valor}&status=com_xml&somenteContagem=1`, [cnpj, ano, mes, modelo.valor])
  const c = dados?.contagemTipo
  const total = c ? c.entradas + c.saidas + c.outros : null
  return (
    <tr>
      <td>
        <Pasta para={total ? `/notas/${cnpj}/${ano}/${mes}/${slug}` : undefined}>{modelo.rotulo}</Pasta>
      </td>
      <td className="num">{c ? inteiro(c.entradas) : '…'}</td>
      <td className="num">{c ? inteiro(c.saidas) : '…'}</td>
      <td className="num">{modelo.valor !== 'cte' ? '—' : c ? inteiro(c.outros) : '…'}</td>
    </tr>
  )
}

// Último nível antes das notas: depois do mês, o tipo de nota.
export default function Modelos() {
  const { cnpj, ano, mes } = useParams()
  const nome = useNomeDoCliente(cnpj)
  const nomeDoMes = NOMES_DOS_MESES[Number(mes) - 1] || mes
  return (
    <Pagina
      titulo={`${nome} · ${nomeDoMes} de ${ano}`}
      subtitulo="Escolha o tipo de nota."
      trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: nome, para: `/notas/${cnpj}` }, { rotulo: ano, para: `/notas/${cnpj}/${ano}` }, { rotulo: nomeDoMes }]}
    >
      <div className="tabela-moldura">
        <table className="tabela">
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              <th scope="col" className="num">
                Entradas
              </th>
              <th scope="col" className="num">
                Saídas
              </th>
              <th scope="col" className="num">
                Outros
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MODELOS).map(([slug, modelo]) => (
              <LinhaTipo key={slug} cnpj={cnpj} ano={ano} mes={mes} slug={slug} modelo={modelo} />
            ))}
          </tbody>
        </table>
      </div>
    </Pagina>
  )
}
