import { Link, Navigate, useParams } from 'react-router'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { NOMES_DOS_MESES, inteiro } from '../formato.js'

// Caminho das notas: cliente → NF-e | NFS-e → ano → mês → Entradas | Saídas.
export const MODELOS = { 'nf-e': { valor: 'nfe', rotulo: 'NF-e' }, 'nfs-e': { valor: 'nfse', rotulo: 'NFS-e' } }
export const DIRECOES = { entradas: { valor: 'entrada', rotulo: 'Entradas' }, saidas: { valor: 'saida', rotulo: 'Saídas' } }

export default function PastasDoMes() {
  const { cnpj, modelo: slug, ano, mes } = useParams()
  const modelo = MODELOS[slug]
  const nome = useNomeDoCliente(cnpj)
  const competencia = `${ano}-${String(mes).padStart(2, '0')}`
  const nomeDoMes = NOMES_DOS_MESES[Number(mes) - 1] || mes
  const base = `/notas/${cnpj}/${slug}/${ano}/${mes}`
  const filtro = `cnpj=${cnpj}&competencia=${competencia}&modelo=${modelo?.valor || 'nfe'}&somenteContagem=1`
  const { dados, erro } = useApi(`/api/notas?${filtro}`, [filtro])
  if (!modelo) return <Navigate to={`/notas/${cnpj}`} replace />

  const trilha = [
    { rotulo: 'Início', para: '/notas' },
    { rotulo: nome, para: `/notas/${cnpj}` },
    { rotulo: modelo.rotulo, para: `/notas/${cnpj}/${slug}` },
    { rotulo: ano, para: `/notas/${cnpj}/${slug}/${ano}` },
    { rotulo: nomeDoMes },
  ]

  return (
    <Pagina
      titulo={modelo.rotulo}
      subtitulo="Escolha entradas ou saídas."
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
              <th scope="col" className="num">
                Notas
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DIRECOES).map(([d, info]) => (
              <tr key={d}>
                <td>
                  <Pasta para={`${base}/${d}`}>{info.rotulo}</Pasta>
                </td>
                <td className="num">{dados ? inteiro(dados.contagemTipo[d === 'entradas' ? 'entradas' : 'saidas']) : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rodape-tabela">
        <Link to={`${base}/todas`}>Ver todas as {modelo.rotulo} do mês numa lista só</Link>
      </p>
    </Pagina>
  )
}
