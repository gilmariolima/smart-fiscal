import { Link, useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { NOMES_DOS_MESES, inteiro } from '../formato.js'

// Pastas do mês, iguais às do disco: <mês> → NF-e | NFS-e → Entradas | Saídas.
export const MODELOS = { 'nf-e': { valor: 'nfe', rotulo: 'NF-e' }, 'nfs-e': { valor: 'nfse', rotulo: 'NFS-e' } }
export const DIRECOES = { entradas: { valor: 'entrada', rotulo: 'Entradas' }, saidas: { valor: 'saida', rotulo: 'Saídas' } }

function Contagens({ cnpj, competencia, modelo }) {
  const { dados } = useApi(`/api/notas?cnpj=${cnpj}&competencia=${competencia}&modelo=${modelo}&somenteContagem=1`, [cnpj, competencia, modelo])
  const c = dados?.contagemTipo
  return (
    <>
      <td className="num">{c ? inteiro(c.entradas) : '…'}</td>
      <td className="num">{c ? inteiro(c.saidas) : '…'}</td>
    </>
  )
}

export default function PastasDoMes() {
  const { cnpj, ano, mes, modelo: slug } = useParams()
  const nome = useNomeDoCliente(cnpj)
  const competencia = `${ano}-${String(mes).padStart(2, '0')}`
  const nomeDoMes = NOMES_DOS_MESES[Number(mes) - 1] || mes
  const base = `/notas/${cnpj}/${ano}/${mes}`
  const modelo = MODELOS[slug]
  const filtro = `cnpj=${cnpj}&competencia=${competencia}${modelo ? `&modelo=${modelo.valor}` : ''}&somenteContagem=1`
  const { dados, erro } = useApi(`/api/notas?${filtro}`, [filtro])

  const trilha = [
    { rotulo: 'Início', para: '/notas' },
    { rotulo: nome, para: `/notas/${cnpj}` },
    { rotulo: ano, para: `/notas/${cnpj}/${ano}` },
    ...(modelo ? [{ rotulo: nomeDoMes, para: base }, { rotulo: modelo.rotulo }] : [{ rotulo: nomeDoMes }]),
  ]

  const linhas = modelo
    ? Object.entries(DIRECOES).map(([d, info]) => (
        <tr key={d}>
          <td>
            <Pasta para={`${base}/${slug}/${d}`}>{info.rotulo}</Pasta>
          </td>
          <td className="num">{dados ? inteiro(dados.contagemTipo[d === 'entradas' ? 'entradas' : 'saidas']) : '…'}</td>
        </tr>
      ))
    : Object.entries(MODELOS).map(([m, info]) => (
        <tr key={m}>
          <td>
            <Pasta para={`${base}/${m}`}>{info.rotulo}</Pasta>
          </td>
          <Contagens cnpj={cnpj} competencia={competencia} modelo={info.valor} />
        </tr>
      ))

  return (
    <Pagina
      titulo="Notas"
      subtitulo={modelo ? 'Escolha entradas ou saídas.' : 'Escolha NF-e ou NFS-e.'}
      trilha={trilha}
      erro={erro}
      acoes={
        <a className="botao botao-claro" href={`/api/planilha?cnpj=${cnpj}&competencia=${competencia}`} download>
          Baixar Excel do mês
        </a>
      }
    >
      <div className="tabela-moldura">
        <table className="tabela">
          <thead>
            <tr>
              <th scope="col">Pasta</th>
              {modelo ? (
                <th scope="col" className="num">
                  Notas
                </th>
              ) : (
                <>
                  <th scope="col" className="num">
                    Entradas
                  </th>
                  <th scope="col" className="num">
                    Saídas
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>{linhas}</tbody>
        </table>
      </div>
      <p className="rodape-tabela">
        <Link to={`${base}/todas`}>Ver todas as notas do mês numa lista só</Link>
      </p>
    </Pagina>
  )
}
