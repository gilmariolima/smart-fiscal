import { Link, useParams } from 'react-router'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { inteiro, plural } from '../formato.js'
import { MODELOS as CARDS } from './Capturar.jsx'
import { MODELOS } from '../modelos.js'

const SLUG = Object.fromEntries(Object.entries(MODELOS).map(([slug, m]) => [m.valor, slug]))

// Sem cliente (/notas): contagens de todos e o card abre a lista de clientes; com cliente, a pasta dele.
const doCliente = (cnpj) => (cnpj ? `cnpj=${cnpj}&` : '')
const pastaDe = (cnpj, slug) => (cnpj ? `/notas/${cnpj}/${slug}` : `/notas/${slug}`)

// Card de um tipo de nota, com as mesmas cores e ícones da tela Capturar. CT-e ainda não é capturado.
function Card({ cnpj, chave }) {
  const m = CARDS[chave]
  const ativo = !m.emBreve
  const { dados } = useApi(ativo ? `/api/notas?${doCliente(cnpj)}modelo=${chave}&status=com_xml&somenteContagem=1` : null, [cnpj, chave])
  const c = dados?.contagemTipo
  const conteudo = (
    <>
      <i className={`fa-solid ${m.icone}`} aria-hidden="true" />
      <span>
        <strong>
          {m.rotulo}
          {m.emBreve && <Etiqueta cor="cinza">Em breve</Etiqueta>}
        </strong>
        {ativo && <small>{c ? `${inteiro(c.entradas)} entradas · ${inteiro(c.saidas)} saídas` : '…'}</small>}
      </span>
    </>
  )
  if (!ativo)
    return (
      <button type="button" className={`card-captura card-${m.cor}`} disabled>
        {conteudo}
      </button>
    )
  return (
    <Link to={pastaDe(cnpj, SLUG[chave])} className={`card-captura card-${m.cor}`}>
      {conteudo}
    </Link>
  )
}

// Embaixo dos tipos: as notas do cliente que ainda não têm o XML completo (canceladas fora).
function CardSemXml({ cnpj }) {
  const { dados } = useApi(`/api/notas?${doCliente(cnpj)}status=sem_xml&somenteContagem=1`, [cnpj])
  const c = dados?.contagemTipo
  const total = c ? c.entradas + c.saidas : null
  return (
    <Link to={pastaDe(cnpj, 'pendentes')} className="card-captura card-vermelho">
      <i className="fa-solid fa-file-circle-exclamation" aria-hidden="true" />
      <span>
        <strong>XMLs não baixados</strong>
        <small>{total === null ? '…' : total ? `${plural(total, 'nota', 'notas')} sem XML` : 'Nenhuma nota sem XML'}</small>
      </span>
    </Link>
  )
}

export default function Modelos() {
  const { cnpj } = useParams()
  const nome = useNomeDoCliente(cnpj)
  return (
    <Pagina titulo="Notas" subtitulo="Escolha o tipo de nota." trilha={cnpj && [{ rotulo: 'Início', para: '/notas' }, { rotulo: nome }]}>
      <ul className="cards-captura">
        {Object.keys(CARDS).map((chave) => (
          <li key={chave}>
            <Card cnpj={cnpj} chave={chave} />
          </li>
        ))}
        <li>
          <CardSemXml cnpj={cnpj} />
        </li>
      </ul>
    </Pagina>
  )
}
