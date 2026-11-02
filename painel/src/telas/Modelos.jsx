import { Link, useParams } from 'react-router'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { inteiro } from '../formato.js'
import { MODELOS as CARDS } from './Capturar.jsx'
import { MODELOS } from '../modelos.js'

const SLUG = Object.fromEntries(Object.entries(MODELOS).map(([slug, m]) => [m.valor, slug]))

// Sem cliente (/notas): contagens de todos e o card abre a lista de clientes; com cliente, a pasta dele.
const doCliente = (cnpj) => (cnpj ? `cnpj=${cnpj}&` : '')
const pastaDe = (cnpj, slug) => (cnpj ? `/notas/${cnpj}/${slug}` : `/notas/${slug}`)

// Card de Notas: ícone e nome do tipo, o total grande, o detalhe embaixo e "Acessar".
function CardNota({ cor, icone, rotulo, etiqueta, rotuloNumero, numero, detalhe, para }) {
  const conteudo = (
    <>
      <span className="card-nota-topo">
        <i className={`fa-solid ${icone}`} aria-hidden="true" />
        <strong>{rotulo}</strong>
        {etiqueta}
      </span>
      <span className="card-nota-rotulo">{rotuloNumero}</span>
      <span className="card-nota-numero">{numero === null ? '…' : inteiro(numero)}</span>
      <span className="card-nota-detalhe">{detalhe}</span>
      {para && (
        <span className="card-nota-acessar">
          Acessar <i className="fa-solid fa-arrow-right" aria-hidden="true" />
        </span>
      )}
    </>
  )
  if (!para)
    return (
      <span className={`card-nota card-${cor} desativado`} aria-disabled="true">
        {conteudo}
      </span>
    )
  return (
    <Link to={para} className={`card-nota card-${cor}`}>
      {conteudo}
    </Link>
  )
}

// Card de um tipo de nota, com as mesmas cores e ícones da tela Capturar; conta só as notas com XML.
function Card({ cnpj, chave }) {
  const m = CARDS[chave]
  const ativo = !m.emBreve
  const { dados } = useApi(ativo ? `/api/notas?${doCliente(cnpj)}modelo=${chave}&status=com_xml&somenteContagem=1` : null, [cnpj, chave])
  const c = dados?.contagemTipo
  const total = c ? c.entradas + c.saidas + c.outros : null
  const detalhe = c ? `${inteiro(c.entradas)} entradas · ${inteiro(c.saidas)} saídas${c.outros ? ` · ${inteiro(c.outros)} outros` : ''}` : ''
  return (
    <CardNota
      cor={m.cor}
      icone={m.icone}
      rotulo={m.rotulo}
      etiqueta={m.emBreve && <Etiqueta cor="cinza">Em breve</Etiqueta>}
      rotuloNumero="Notas"
      numero={ativo ? total : 0}
      detalhe={ativo ? detalhe : ''}
      para={ativo ? pastaDe(cnpj, SLUG[chave]) : null}
    />
  )
}

// Depois dos tipos: as notas do cliente que ainda não têm o XML completo (canceladas fora).
function CardSemXml({ cnpj }) {
  const { dados } = useApi(`/api/notas?${doCliente(cnpj)}status=sem_xml&somenteContagem=1`, [cnpj])
  const c = dados?.contagemTipo
  const total = c ? c.entradas + c.saidas : null
  return (
    <CardNota
      cor="vermelho"
      icone="fa-file-circle-exclamation"
      rotulo="XMLs não baixados"
      rotuloNumero="Notas sem XML"
      numero={total}
      detalhe={total ? 'Aguardando o XML completo' : total === 0 ? 'Nenhuma nota sem XML' : ''}
      para={pastaDe(cnpj, 'pendentes')}
    />
  )
}

export default function Modelos() {
  const { cnpj } = useParams()
  const nome = useNomeDoCliente(cnpj)
  return (
    <Pagina titulo="Notas" subtitulo="Escolha o tipo de nota." trilha={cnpj && [{ rotulo: 'Início', para: '/notas' }, { rotulo: nome }]}>
      <ul className="cards-notas">
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
