import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api.js'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Icone from '../componentes/Icone.jsx'
import Interruptor from '../componentes/Interruptor.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { inteiro, plural, quando } from '../formato.js'

// A próxima busca e o ambiente já aparecem nas estatísticas do menu lateral.
function subtitulo(resumo) {
  if (resumo.capturaEmAndamento) return 'Captura em andamento'
  return resumo.ultimaCaptura ? `Última captura ${quando(resumo.ultimaCaptura)}` : 'Nenhuma captura ainda'
}

// Notas em resumo aguardando ciência (canceladas não recebem ciência).
function pendentesDeCiencia(resumo) {
  const linha = resumo.notasPorStatus?.find((s) => s.status === 'resumo')
  return linha ? (linha.total || 0) - (linha.canceladas || 0) : 0
}

const ATALHOS = [
  { para: '/notas', icone: 'notas', cor: 'azul', titulo: 'Notas', texto: 'Pastas de cada cliente, por ano e mês' },
  { para: '/clientes', icone: 'clientes', cor: 'verde', titulo: 'Clientes', texto: 'Certificados e situação da captura' },
  { para: '/clientes/novo', icone: 'novoCliente', cor: 'roxo', titulo: 'Novo cliente', texto: 'Cadastrar empresa com o certificado A1', soNoPc: true },
  { para: '/pendentes', icone: 'pendentes', cor: 'vermelho', titulo: 'XMLs não baixados', texto: 'Notas aguardando ciência ou XML' },
  { para: '/exportar', icone: 'exportar', cor: 'laranja', titulo: 'Exportar', texto: 'ZIP do mês para o Domínio/Fortes' },
  { para: '/execucoes', icone: 'execucoes', cor: 'grafite', titulo: 'Execuções', texto: 'Histórico de consultas e downloads' },
  { para: '/escritorio', icone: 'escritorio', cor: 'ocre', titulo: 'Escritório', texto: 'Certificado para as notas de saída', soNoPc: true },
]

function Atalhos({ cadastroLiberado }) {
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
    </ul>
  )
}

// Meio círculo dividido em no prazo / a vencer / vencidos (pathLength 100 = arco inteiro).
const ARCO = 'M 12 62 A 50 50 0 0 1 112 62'

function Certificados({ certificados: c }) {
  const total = c?.total || 0
  const partes = [
    { chave: 'noPrazo', rotulo: 'No prazo', classe: 'verde', valor: c?.noPrazo || 0 },
    { chave: 'aVencer', rotulo: 'A vencer (30 dias)', classe: 'ambar', valor: c?.aVencer || 0 },
    { chave: 'vencidos', rotulo: 'Vencidos', classe: 'vermelho', valor: c?.vencidos || 0 },
  ]
  let inicio = 0
  return (
    <Link to="/clientes" className="certificados">
      <svg viewBox="0 0 124 70" role="img" aria-label={`${plural(total, 'certificado', 'certificados')}: ${partes.map((p) => `${p.valor} ${p.rotulo.toLowerCase()}`).join(', ')}`}>
        <path d={ARCO} pathLength="100" className="arco-fundo" />
        {total > 0 &&
          partes.map((p) => {
            const tamanho = (p.valor / total) * 100
            const arco = (
              <path key={p.chave} d={ARCO} pathLength="100" className={`arco arco-${p.classe}`} strokeDasharray={`${tamanho} 100`} strokeDashoffset={-inicio} />
            )
            inicio += tamanho
            return p.valor ? arco : null
          })}
        <text x="62" y="46" className="arco-rotulo">
          Certificados
        </text>
        <text x="62" y="64" className="arco-total">
          {inteiro(total)}
        </text>
      </svg>
      <ul className="legenda">
        {partes.map((p) => (
          <li key={p.chave}>
            <span className={`bolinha bolinha-${p.classe}`} aria-hidden="true" />
            {p.rotulo}
            <strong>{inteiro(p.valor)}</strong>
          </li>
        ))}
      </ul>
    </Link>
  )
}

export default function Inicio() {
  const { resumo, recarregar } = useResumo()
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [enviando, setEnviando] = useState(false)

  if (!resumo) return <Pagina titulo="Início" subtitulo="Carregando…" />

  const auto = resumo.automacao || {}
  const pendentes = pendentesDeCiencia(resumo)

  async function enviar(acao) {
    setEnviando(true)
    setErro(null)
    setAviso(null)
    try {
      setAviso(await acao())
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
      recarregar()
    }
  }

  function mudarAutomacao(nome, ligar) {
    const pergunta = `Ligar a ciência automática?\n\nNa próxima busca o sistema dá ciência sozinho nas ${plural(pendentes, 'nota pendente', 'notas pendentes')} e nas que chegarem depois.`
    if (nome === 'ciencia' && ligar && pendentes && !window.confirm(pergunta)) return
    enviar(async () => {
      await api.post('/api/automacao', { [nome]: ligar })
      return `${nome === 'captura' ? 'Busca' : 'Ciência'} automática ${ligar ? 'ligada' : 'desligada'}.`
    })
  }

  const darCiencia = () => {
    const pergunta = `Dar ciência em ${plural(pendentes, 'nota', 'notas')} de todos os clientes?

A ciência é uma manifestação na SEFAZ, aparece para o fornecedor e não pode ser desfeita.`
    if (!window.confirm(pergunta)) return
    enviar(async () => (await api.post('/api/ciencia', {})).mensagem)
  }

  const automacao = (
    <div className="automacao">
      <Interruptor
        ligado={auto.captura}
        onChange={(v) => mudarAutomacao('captura', v)}
        desabilitado={enviando}
        rotulo="Busca automática"
        descricao={auto.captura ? 'Busca as notas novas nos horários do agendamento.' : 'Só busca quando você manda capturar.'}
      />
      <Interruptor
        ligado={auto.ciencia}
        onChange={(v) => mudarAutomacao('ciencia', v)}
        desabilitado={enviando}
        rotulo="Ciência automática"
        descricao={auto.ciencia ? 'Dá ciência e baixa o XML completo depois de cada busca.' : 'A ciência só sai quando você clica em Dar ciência.'}
      />
      <div className="automacao-captura">
        <Link className="botao botao-azul" to="/clientes">
          Capturar agora
        </Link>
        {resumo.capturaEmAndamento && <Etiqueta cor="ambar">Capturando…</Etiqueta>}
      </div>
    </div>
  )

  return (
    <Pagina titulo="Início" subtitulo={subtitulo(resumo)} acoes={automacao} erro={erro} aoFecharErro={() => setErro(null)} aviso={aviso}>
      <div className="inicio-corpo">
        <Atalhos cadastroLiberado={resumo.cadastroLiberado} />
        <Certificados certificados={resumo.certificados} />
      </div>

      {resumo.backup?.alerta && (
        <p className="faixa faixa-ambar" role="status">
          {resumo.backup.alerta}
        </p>
      )}

      {!auto.ciencia && pendentes > 0 && (
        <div className="faixa faixa-ambar faixa-ciencia">
          <span>{plural(pendentes, 'nota aguarda', 'notas aguardam')} a sua ciência para o XML completo ser baixado.</span>
          <button type="button" className="botao botao-azul" onClick={darCiencia} disabled={enviando || resumo.capturaEmAndamento}>
            {resumo.capturaEmAndamento ? 'Capturando…' : `Dar ciência em ${plural(pendentes, 'nota', 'notas')}`}
          </button>
        </div>
      )}
    </Pagina>
  )
}
