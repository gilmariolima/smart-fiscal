import { Link } from 'react-router'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Icone from '../componentes/Icone.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { inteiro, plural, quando } from '../formato.js'

// A próxima busca e o ambiente já aparecem nas estatísticas do menu lateral.
function subtitulo(resumo) {
  if (resumo.capturaEmAndamento) return 'Captura em andamento'
  return resumo.ultimaCaptura ? `Última captura ${quando(resumo.ultimaCaptura)}` : 'Nenhuma captura ainda'
}

// Notas só em resumo: o XML completo chega depois que o cliente der ciência (canceladas não contam).
function pendentesDeCiencia(resumo) {
  const linha = resumo.notasPorStatus?.find((s) => s.status === 'resumo')
  return linha ? (linha.total || 0) - (linha.canceladas || 0) : 0
}

const ATALHOS = [
  { para: '/notas', icone: 'notas', cor: 'azul', titulo: 'Notas', texto: 'Por tipo de nota, cliente, ano e mês' },
  { para: '/clientes', icone: 'clientes', cor: 'verde', titulo: 'Clientes', texto: 'Certificados e situação da captura' },
  { para: '/clientes/novo', icone: 'novoCliente', cor: 'roxo', titulo: 'Novo cliente', texto: 'Cadastrar empresa com o certificado A1', soNoPc: true },
  { para: '/notas/pendentes', icone: 'pendentes', cor: 'vermelho', titulo: 'XMLs não baixados', texto: 'Notas aguardando a ciência do cliente' },
  { para: '/execucoes', icone: 'execucoes', cor: 'grafite', titulo: 'Execuções', texto: 'Histórico de consultas e downloads' },
  { para: '/escritorio', icone: 'escritorio', cor: 'ocre', titulo: 'Escritório', texto: 'Certificado para as notas de saída', soNoPc: true },
  { para: '/capturar', icone: 'capturar', cor: 'ciano', titulo: 'Capturar', texto: 'Buscar NF-e e NFS-e dos clientes' },
]

// Último quadro dos atalhos: barra com os certificados A1 no prazo, a vencer em 30 dias e vencidos.
const PARTES_CERT = [
  { chave: 'noPrazo', um: 'no prazo', varios: 'no prazo', classe: 'verde' },
  { chave: 'aVencer', um: 'a vencer', varios: 'a vencer', classe: 'ambar' },
  { chave: 'vencidos', um: 'vencido', varios: 'vencidos', classe: 'vermelho' },
]

function QuadroCertificados({ certificados: c }) {
  const total = c?.total || 0
  const partes = PARTES_CERT.map((p) => ({ ...p, valor: c?.[p.chave] || 0 }))
  return (
    <Link to="/clientes" className="atalho quadro-cert">
      <span className="quadro-cert-topo">
        <strong>Certificados A1</strong>
        <span className="quadro-cert-total">{inteiro(total)}</span>
      </span>
      <span className="barra-cert" role="img" aria-label={partes.map((p) => plural(p.valor, p.um, p.varios)).join(', ')}>
        {total > 0 && partes.map((p) => p.valor > 0 && <span key={p.chave} className={`barra-cert-${p.classe}`} style={{ flexGrow: p.valor }} />)}
      </span>
      <span className="legenda-cert">
        {partes.map((p) => (
          <span key={p.chave} className={p.valor ? undefined : 'zerada'}>
            <i className={`bolinha-${p.classe}`} aria-hidden="true" />
            {plural(p.valor, p.um, p.varios)}
          </span>
        ))}
      </span>
    </Link>
  )
}

function Atalhos({ cadastroLiberado, certificados }) {
  return (
    <ul className="atalhos">
      {ATALHOS.filter((a) => cadastroLiberado || !a.soNoPc).map((a) => (
        <li key={a.para}>
          <Link to={a.para} className={`atalho atalho-${a.cor}`}>
            <Icone nome={a.icone} />
            <span>
              <strong>{a.titulo}</strong>
              <small>{a.texto}</small>
            </span>
          </Link>
        </li>
      ))}
      <li>
        <QuadroCertificados certificados={certificados} />
      </li>
    </ul>
  )
}

// Certificados A1 só aparecem quando pedem ação: vencidos ou vencendo nos próximos 30 dias.
const MAX_CERT_NOMES = 3

function prazoCert(dias) {
  if (dias < 0) return `venceu há ${plural(-dias, 'dia', 'dias')}`
  if (dias === 0) return 'vence hoje'
  return `vence em ${plural(dias, 'dia', 'dias')}`
}

function AvisoCertificados({ lista }) {
  if (!lista?.length) return null
  const vencido = lista.some((c) => c.dias < 0)
  const nomes = lista.slice(0, MAX_CERT_NOMES).map((c) => `${c.nome} (${prazoCert(c.dias)})`)
  const resto = lista.length - nomes.length
  return (
    <div className={`faixa ${vencido ? 'faixa-erro' : 'faixa-ambar'}`} role="status">
      <span>
        {lista.length === 1 ? 'Certificado A1' : 'Certificados A1'} para trocar: {nomes.join(', ')}
        {resto > 0 && ` e mais ${resto}`}. Sem certificado válido a captura do cliente para.
      </span>
      <Link className="botao botao-claro" to="/clientes">
        Abrir Clientes
      </Link>
    </div>
  )
}

export default function Inicio() {
  const { resumo } = useResumo()

  if (!resumo) return <Pagina titulo="Início" subtitulo="Carregando…" />

  const pendentes = pendentesDeCiencia(resumo)

  return (
    <Pagina titulo="Início" subtitulo={subtitulo(resumo)} acoes={resumo.capturaEmAndamento && <Etiqueta cor="ambar">Capturando…</Etiqueta>}>
      <div className="inicio-corpo">
        <Atalhos cadastroLiberado={resumo.cadastroLiberado} certificados={resumo.certificados} />
      </div>

      <AvisoCertificados lista={resumo.certificadosVencendo} />

      {resumo.backup?.alerta && (
        <div className="faixa faixa-ambar faixa-ciencia" role="status">
          <span>{resumo.backup.alerta}</span>
          <Link className="botao botao-claro" to="/backup">
            Abrir Backup
          </Link>
        </div>
      )}

      {pendentes > 0 && (
        <div className="faixa faixa-ambar faixa-ciencia">
          <span>
            {plural(pendentes, 'nota aguarda', 'notas aguardam')} a ciência do cliente: avise o dono da empresa. Depois que ele der
            ciência, o XML completo chega sozinho na próxima captura.
          </span>
          <Link className="botao botao-claro" to="/notas/pendentes">
            Ver as notas
          </Link>
        </div>
      )}
    </Pagina>
  )
}
