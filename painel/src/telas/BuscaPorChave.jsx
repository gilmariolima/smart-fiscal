import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import Pagina from '../layout/Pagina.jsx'
import Pasta from '../componentes/Pasta.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import Interruptor from '../componentes/Interruptor.jsx'
import BotaoIcone from '../componentes/BotaoIcone.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { cnpj as formatarCnpj, data, dinheiro, hora, inteiro, plural } from '../formato.js'

// Busca por chave: NF-e baixadas pela SVRS, uma por minuto. A fila fica em pastas: empresa → NF-e Entradas / Saídas → notas.

const SITUACOES = {
  fila: 'Na fila',
  baixada: 'Baixada',
  'ja-existia': 'Já estava no Smart Fiscal',
  'nao-envolvido': 'Certificado não é de envolvido',
  'nao-nfe': 'Não é NF-e',
  'outro-estado': 'Outro estado',
  erro: 'Erro',
}
const PROBLEMA = new Set(['erro', 'nao-envolvido'])
const DIRECOES = { entrada: 'NF-e · Entradas', saida: 'NF-e · Saídas' }
const emBlocos = (chave) => chave.match(/.{1,4}/g).join(' ')
// Antes do download só há a chave: o número e o mês da emissão saem dela.
const daChave = (ch) => `nº ${Number(ch.slice(25, 34))} · ${ch.slice(4, 6)}/20${ch.slice(2, 4)}`
const BASE = '/busca-por-chave'

// ---------- topo: andamento geral ----------

function textoDoAndamento(e, agora) {
  if (!e) return { cor: 'cinza', texto: '' }
  if (e.pausada) return { cor: 'cinza', texto: 'Pausado' }
  if (e.voltaAs) return { cor: 'ambar', texto: e.pausaPor === 'sem-resposta' ? `SVRS sem resposta: tenta de novo às ${hora(e.voltaAs)}` : `SVRS pediu pausa: volta às ${hora(e.voltaAs)}` }
  if (e.motivo) return { cor: 'ambar', texto: e.motivo }
  if (!e.pendentes) return { cor: 'cinza', texto: e.total ? 'Fila concluída' : 'Fila vazia' }
  if (e.pendentesAtivos === 0) return { cor: 'cinza', texto: 'Empresas com fila pausadas' }
  if (e.rodando) return { cor: 'verde', texto: 'Baixando agora…' }
  if (e.proximaEm) return { cor: 'verde', texto: `Baixando · próxima em ${Math.max(0, Math.round((new Date(e.proximaEm) - agora) / 1000))} s` }
  return { cor: 'ambar', texto: 'Esperando' }
}

function Andamento({ estado, agora, aoPausar, aoContinuar }) {
  const { cor, texto } = textoDoAndamento(estado, agora)
  return (
    <div className="busca-andamento">
      <span className={`busca-ponto busca-ponto-${cor}`} aria-hidden="true" />
      <span>{texto}</span>
      {(estado?.pendentes > 0 || estado?.pausada) &&
        (estado.pausada ? (
          <button type="button" className="botao botao-verde" onClick={aoContinuar}>
            Continuar
          </button>
        ) : (
          <button type="button" className="botao botao-claro" onClick={aoPausar}>
            Pausar
          </button>
        ))}
    </div>
  )
}

function Barra({ feito, total }) {
  const pct = total ? Math.round((feito / total) * 100) : 0
  return (
    <span className="busca-barra" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

function Progresso({ estado, agora }) {
  if (!estado?.total) return null
  const feito = estado.total - estado.pendentes
  const min = Math.ceil((estado.estimativaS || 0) / 60)
  const termina = new Date(agora.getTime() + (estado.estimativaS || 0) * 1000)
  return (
    <div className="busca-progresso">
      <Barra feito={feito} total={estado.total} />
      <span>
        <strong>
          {inteiro(feito)} de {inteiro(estado.total)}
        </strong>
        {estado.pendentes > 0 && !estado.pausada && min > 0 && ` · faltam ~${plural(min, 'min', 'min')} (termina por volta de ${hora(termina.toISOString())})`}
      </span>
    </div>
  )
}

// ---------- NF-e de entrada: colar as chaves ----------

function NotasDeEntrada({ clientes, aoAdicionar }) {
  const [cnpj, setCnpj] = useState('')
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  async function buscar(e) {
    e.preventDefault()
    setEnviando(true)
    try {
      const r = await api.post('/api/busca-antiga', { cnpj, texto })
      setTexto('')
      aoAdicionar(resumoDaAdicao(r))
    } catch (e2) {
      aoAdicionar(null, e2.message)
    } finally {
      setEnviando(false)
    }
  }
  return (
    <form className="busca-colar" onSubmit={buscar}>
      <p className="apagado">Notas que a empresa recebeu e a captura não trouxe (mais de 90 dias). Cole as chaves de acesso.</p>
      <label className="campo">
        <span>Empresa</span>
        <select value={cnpj} onChange={(e) => setCnpj(e.target.value)} required>
          <option value="">Escolha a empresa</option>
          {clientes.map((c) => (
            <option key={c.cnpj} value={c.cnpj}>
              {c.apelido || c.razaoSocial}
            </option>
          ))}
        </select>
      </label>
      <label className="campo">
        <span>Chaves (uma por linha ou como vierem)</span>
        <textarea className="antigas-chaves" rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} required spellCheck={false} />
      </label>
      <div className="antigas-acoes">
        <button type="submit" className="botao botao-azul" disabled={enviando || !cnpj || !texto.trim()}>
          {enviando ? 'Enviando…' : 'Buscar'}
        </button>
      </div>
    </form>
  )
}

function resumoDaAdicao(r) {
  const partes = [
    r.repetidas > 0 && plural(r.repetidas, 'repetida ignorada', 'repetidas ignoradas'),
    r.naoNfe > 0 && plural(r.naoNfe, 'não é NF-e', 'não são NF-e'),
    r.outroEstado > 0 && plural(r.outroEstado, 'de estado com SEFAZ própria', 'de estados com SEFAZ própria'),
  ].filter(Boolean)
  return `${plural(r.adicionadas, 'chave na fila', 'chaves na fila')}${partes.length ? ` (${partes.join(', ')})` : ''}`
}

// ---------- NF-e de saída: período e notas novas ----------

const mesRotulo = (m) => (m ? `${m.slice(5)}/${m.slice(0, 4)}` : '')
function mesesDaJanela(j) {
  if (!j) return []
  const lista = []
  let [a, m] = j.de.split('-').map(Number)
  const [af, mf] = j.ate.split('-').map(Number)
  while (a < af || (a === af && m <= mf)) {
    lista.push(`${a}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      a++
    }
  }
  return lista
}
const duracao = (min) => (min >= 60 ? `~${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `~${Math.max(1, min)} min`)
function intervaloDeMeses(de, ate) {
  if (de === ate) return mesRotulo(de)
  if (de.slice(0, 4) === ate.slice(0, 4)) return `${de.slice(5)} a ${mesRotulo(ate)}`
  return `${mesRotulo(de)} a ${mesRotulo(ate)}`
}

function NotasDoPeriodo({ clientes, janela, pendentesNaFila, aoMudar, aoErro }) {
  const meses = mesesDaJanela(janela)
  const [cnpj, setCnpj] = useState('')
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  const [serie, setSerie] = useState('1')
  const [outraSerie, setOutraSerie] = useState(false)
  const [buscando, setBuscando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const deEfetivo = de || meses[meses.length - 1] || ''
  const ateEfetivo = ate && ate >= deEfetivo ? ate : deEfetivo
  const pedido = { cnpj, de: deEfetivo, ate: ateEfetivo, serie: serie || '1' }

  async function buscar(e) {
    e.preventDefault()
    setResultado(null)
    setBuscando(true)
    try {
      const r = await api.post('/api/saidas/periodo', pedido)
      if (r.naEspera) aoMudar('O pedido entrou em andamento: roda quando a busca atual terminar.')
      else setResultado({ ...r, ...pedido })
    } catch (e2) {
      aoErro(e2.message)
    } finally {
      setBuscando(false)
    }
  }
  async function confirmar() {
    setEnviando(true)
    try {
      await api.post('/api/saidas/periodo/confirmar', { cnpj: resultado.cnpj, de: resultado.de, ate: resultado.ate, serie: resultado.serie, primeiro: resultado.primeiro, ultimo: resultado.ultimo })
      setResultado(null)
      aoMudar()
    } catch (e) {
      aoErro(e.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form className="busca-periodo" onSubmit={buscar}>
      <div className="busca-periodo-campos">
        <label className="campo">
          <span>Empresa</span>
          <select value={cnpj} onChange={(e) => setCnpj(e.target.value)} required>
            <option value="">Escolha a empresa</option>
            {clientes.map((c) => (
              <option key={c.cnpj} value={c.cnpj}>
                {c.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span>De</span>
          <select value={deEfetivo} onChange={(e) => setDe(e.target.value)}>
            {meses.map((m) => (
              <option key={m} value={m}>
                {mesRotulo(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span>Até</span>
          <select value={ateEfetivo} onChange={(e) => setAte(e.target.value)}>
            {meses
              .filter((m) => m >= deEfetivo)
              .map((m) => (
                <option key={m} value={m}>
                  {mesRotulo(m)}
                </option>
              ))}
          </select>
        </label>
        {outraSerie && (
          <label className="campo busca-periodo-serie">
            <span>Série</span>
            <input className="entrada" value={serie} onChange={(e) => setSerie(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" />
          </label>
        )}
        <button type="submit" className="botao botao-azul" disabled={buscando || !cnpj}>
          {buscando ? 'Procurando… (1–2 min)' : 'Buscar'}
        </button>
      </div>
      <p className="busca-periodo-dica apagado">
        Só os últimos 6 meses.{' '}
        {!outraSerie && (
          <button type="button" className="botao-link" onClick={() => setOutraSerie(true)}>
            Outra série
          </button>
        )}
      </p>
      {resultado &&
        (resultado.nenhuma ? (
          <p className="apagado">{resultado.motivo}</p>
        ) : (
          <div className="busca-periodo-resultado">
            <span>
              Achadas ~{plural(resultado.estimadas, 'nota', 'notas')} (nº {inteiro(resultado.primeiro)} a {inteiro(resultado.ultimo)}) · download {duracao(resultado.estimadas + (pendentesNaFila || 0))}
              {resultado.foraDaJanela && <small className="busca-erro">parte de {mesRotulo(resultado.de)} ficou fora (mais de 6 meses)</small>}
            </span>
            <span className="busca-periodo-botoes">
              <button type="button" className="botao botao-claro" onClick={() => setResultado(null)}>
                Cancelar
              </button>
              <button type="button" className="botao botao-azul" onClick={confirmar} disabled={enviando}>
                Colocar na fila
              </button>
            </span>
          </div>
        ))}
    </form>
  )
}

function situacaoDoPedido(p) {
  if (p.situacao === 'na-espera') return 'esperando a vez'
  if (p.situacao === 'procurando') {
    if (p.primeiro == null) return 'procurando o período…'
    // O trecho consultado inclui a margem de segurança: mostra a porcentagem e quantas já foram para a fila.
    const pct = Math.min(100, Math.floor(((p.proximo - p.primeiro) / (p.ultimo - p.primeiro + 1)) * 100))
    const texto = `achando notas · ${pct}% · ${plural(p.achadas, 'na fila', 'na fila')}`
    return p.erro ? `${texto} · ${p.erro}` : texto
  }
  if (p.situacao === 'concluido') return p.erro || `pronto · ${plural(p.achadas, 'nota na fila', 'notas na fila')}`
  return p.erro || 'erro'
}

function EmAndamento({ periodos, aoMudar, aoErro }) {
  if (!periodos.length) return null
  async function excluir(id) {
    try {
      await api.post('/api/saidas/periodo/excluir', { id })
      aoMudar()
    } catch (e) {
      aoErro(e.message)
    }
  }
  return (
    <div className="busca-pedidos">
      <h4 className="busca-subtitulo-menor">Em andamento</h4>
      <ul className="busca-saidas-lista">
        {periodos.map((p) => (
          <li key={p.id}>
            <span>
              {p.nome} · {intervaloDeMeses(p.de, p.ate)}
              {p.serie !== '1' ? ` · série ${p.serie}` : ''}
            </span>
            <span className={p.situacao === 'erro' ? 'busca-erro' : 'apagado'}>{situacaoDoPedido(p)}</span>
            <BotaoIcone icone="fa-xmark" dica="Excluir" perigo onClick={() => excluir(p.id)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

// "última achada: nº 705" (série 1) ou "série 2: nº 30" para as outras.
function ultimaAchada(series) {
  return series
    .filter((s) => s.ultimo_numero > 0)
    .map((s) => (s.serie === '1' ? `última achada: nº ${inteiro(s.ultimo_numero)}` : `série ${s.serie}: nº ${inteiro(s.ultimo_numero)}`))
    .join(' · ')
}

function NotasDeSaida({ aoAdicionar, aoTerminar, pendentesNaFila }) {
  const saidas = useApi('/api/saidas')
  const lista = saidas.dados?.clientes || []
  const periodos = saidas.dados?.periodos || []
  const { recarregar } = saidas
  // Atualiza enquanto há busca rodando ou pedido esperando a vez.
  const rodando = !!saidas.dados?.rodando || periodos.some((p) => p.situacao === 'na-espera' || (p.situacao === 'procurando' && !p.erro))
  useEffect(() => {
    if (!rodando) return undefined
    const t = setInterval(recarregar, 3000)
    return () => clearInterval(t)
  }, [rodando, recarregar])
  // A busca acabou: as chaves achadas já estão na fila, que precisa aparecer sem recarregar a página.
  const rodavaAntes = useRef(false)
  useEffect(() => {
    if (rodavaAntes.current && !rodando) aoTerminar()
    rodavaAntes.current = rodando
  }, [rodando, aoTerminar])
  async function ligar(cnpj, ligado) {
    try {
      await api.post('/api/saidas/ligar', { cnpj, ligado })
      recarregar()
    } catch (e) {
      aoAdicionar(null, e.message)
    }
  }
  const aoErro = (m) => aoAdicionar(null, m)

  if (saidas.dados && !lista.length) return <p className="apagado">Nenhuma empresa com certificado no prazo de estado atendido pela SVRS.</p>
  return (
    <div className="busca-saidas">
      <section className="busca-passo">
        <h3 className="busca-subtitulo">1. Notas de um período</h3>
        <NotasDoPeriodo
          clientes={lista}
          janela={saidas.dados?.janela}
          pendentesNaFila={pendentesNaFila}
          aoMudar={(texto) => {
            recarregar()
            if (texto) aoAdicionar(texto)
          }}
          aoErro={aoErro}
        />
        <EmAndamento periodos={periodos} aoMudar={recarregar} aoErro={aoErro} />
      </section>
      <section className="busca-passo">
        <h3 className="busca-subtitulo">2. Notas novas, sozinho</h3>
        <p className="apagado">Depois de cada captura, o app procura as saídas novas das empresas ligadas.</p>
        <ul className="busca-saidas-lista">
          {lista.map((c) => (
            <li key={c.cnpj}>
              <Interruptor ligado={c.ligado} onChange={(v) => ligar(c.cnpj, v)} rotulo={c.nome} />
              <span className="busca-saidas-series">
                {ultimaAchada(c.series)}
                {c.series.filter((s) => s.ultimo_erro).map((s) => (
                  <small key={s.serie} className="busca-erro">
                    {s.ultimo_erro}
                  </small>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

// ---------- pastas ----------

function estadoDaEmpresa(c) {
  if (c.pausada) return 'Pausado'
  if (!c.pendentes) return 'Concluído'
  return c.daVez ? 'Baixando' : 'Na fila'
}

function BotaoPausaEmpresa({ c, aoMudar }) {
  if (!c.pendentes && !c.pausada) return null
  const mudar = async (pausada) => {
    try {
      await api.post('/api/busca-antiga/cliente-pausa', { cnpj: c.cnpj, pausada })
      aoMudar()
    } catch (e) {
      aoMudar(e.message)
    }
  }
  return c.pausada ? (
    <button type="button" className="botao botao-verde" onClick={() => mudar(false)}>
      Continuar
    </button>
  ) : (
    <button type="button" className="botao botao-claro" onClick={() => mudar(true)}>
      Pausar
    </button>
  )
}

function Empresas({ clientes, aoMudar }) {
  if (!clientes.length) return <p className="apagado">Nenhuma chave na fila.</p>
  return (
    <div className="tabela-moldura">
      <table className="tabela busca-empresas">
        <tbody>
          {clientes.map((c) => (
            <tr key={c.cnpj}>
              <td>
                <Pasta para={`${BASE}/${c.cnpj}`}>{c.nome}</Pasta>
              </td>
              <td className="busca-col-barra">
                <Barra feito={c.total - c.pendentes} total={c.total} />
              </td>
              <td className="sem-quebra busca-col-conta">
                {inteiro(c.total - c.pendentes)} de {inteiro(c.total)}
                {c.problemas > 0 && <span className="busca-erro"> · {plural(c.problemas, 'problema', 'problemas')}</span>}
              </td>
              <td className={`sem-quebra busca-col-estado busca-estado-${estadoDaEmpresa(c).toLowerCase().replace(/\s/g, '-')}`}>{estadoDaEmpresa(c)}</td>
              <td className="busca-col-acao">
                <BotaoPausaEmpresa c={c} aoMudar={aoMudar} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Direcoes({ c }) {
  return (
    <div className="tabela-moldura">
      <table className="tabela busca-empresas">
        <tbody>
          {Object.entries(DIRECOES).map(([direcao, rotulo]) => {
            const d = c.direcoes[direcao]
            return (
              <tr key={direcao}>
                <td>
                  <Pasta para={d.total ? `${BASE}/${c.cnpj}/${direcao}` : undefined}>{rotulo}</Pasta>
                </td>
                <td className="busca-col-barra">{d.total > 0 && <Barra feito={d.total - d.pendentes} total={d.total} />}</td>
                <td className="sem-quebra busca-col-conta">
                  {d.total ? `${inteiro(d.total - d.pendentes)} de ${inteiro(d.total)}` : 'nenhuma'}
                  {d.problemas > 0 && <span className="busca-erro"> · {plural(d.problemas, 'problema', 'problemas')}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const FILTROS = [
  ['', 'Todas'],
  ['fila', 'Na fila'],
  ['baixadas', 'Baixadas'],
  ['problemas', 'Problemas'],
  ['outro-estado', 'Outro estado'],
]

function Notas({ cnpj, direcao, pausada, d, recarregarEstado }) {
  const [filtro, setFiltro] = useState('')
  const [linhas, setLinhas] = useState([])
  const [maisDe, setMaisDe] = useState(0)
  const [acabou, setAcabou] = useState(false)
  const [marcadas, setMarcadas] = useState(() => new Set())
  const [erro, setErro] = useState('')

  // Troca de filtro ou de pasta muda a geração: a resposta de um pedido antigo é descartada.
  const geracao = useRef(0)
  const mostradas = useRef(0)
  async function carregar(de = 0, quantas = 200) {
    const minha = geracao.current
    try {
      const r = await api.get(`/api/busca-antiga?cnpj=${cnpj}&direcao=${direcao}${filtro ? `&situacao=${filtro}` : ''}&de=${de}&limite=${quantas}`)
      if (minha !== geracao.current) return
      setErro('')
      setLinhas((atual) => {
        const vistas = new Set(atual.map((l) => l.id))
        const nova = de ? [...atual, ...r.linhas.filter((l) => !vistas.has(l.id))] : r.linhas
        mostradas.current = nova.length
        return nova
      })
      setAcabou(r.linhas.length < quantas)
      setMaisDe(de + r.linhas.length)
    } catch (e) {
      if (minha === geracao.current) setErro(e.message)
    }
  }
  // Recarrega com o filtro e, enquanto houver fila, a cada 5 s (sem sair do lugar na lista).
  useEffect(() => {
    geracao.current++
    carregar(0)
  }, [cnpj, direcao, filtro]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d.pendentes) return undefined
    const t = setInterval(() => carregar(0, Math.max(200, mostradas.current)), 5000)
    return () => clearInterval(t)
  }, [d.pendentes, cnpj, direcao, filtro]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pausada) setMarcadas(new Set())
  }, [pausada])

  async function acao(caminho, corpo) {
    setErro('')
    try {
      await api.post(caminho, corpo)
      setMarcadas(new Set())
      await carregar(0, Math.max(200, mostradas.current))
      recarregarEstado()
    } catch (e) {
      setErro(e.message)
    }
  }
  const alternar = (id) =>
    setMarcadas((m) => {
      const n = new Set(m)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const contagem = { '': d.total, fila: d.pendentes, baixadas: d.baixadas, problemas: d.problemas, 'outro-estado': d.outroEstado || 0 }

  return (
    <>
      <div className="busca-filtros">
        <Segmentado
          rotulo="Filtrar por situação"
          valor={filtro}
          onChange={setFiltro}
          opcoes={FILTROS.map(([v, r]) => ({ valor: v, rotulo: contagem[v] != null ? `${r} ${inteiro(contagem[v])}` : r }))}
        />
        {pausada && (
          <button type="button" className="botao botao-claro" disabled={!marcadas.size} onClick={() => acao('/api/busca-antiga/excluir', { ids: [...marcadas] })}>
            Excluir marcadas{marcadas.size ? ` (${marcadas.size})` : ''}
          </button>
        )}
      </div>
      {erro && <div className="faixa faixa-erro" role="alert">{erro}</div>}
      {!linhas.length ? (
        <p className="apagado">Nenhuma nota aqui.</p>
      ) : (
        <ul className={`busca-lista${pausada ? ' busca-lista-marcar' : ''}`}>
          {linhas.map((l) => (
            <li key={l.id}>
              {pausada && <input type="checkbox" aria-label={`Marcar a chave ${l.chave}`} checked={marcadas.has(l.id)} onChange={() => alternar(l.id)} />}
              <div className="busca-nota">
                <div className="busca-nota-linha1">
                  {l.numero ? (
                    <span>
                      nº {l.numero} · {data(l.data_emissao)} · {dinheiro(l.valor_total)}
                      {l.outra_nome && ` · ${direcao === 'saida' ? 'para' : 'de'} ${l.outra_nome}`}
                    </span>
                  ) : (
                    <span>
                      {daChave(l.chave)}
                      {direcao === 'entrada' && ` · de ${formatarCnpj(l.chave.slice(6, 20))}`}
                    </span>
                  )}
                </div>
                <div className="busca-nota-chave mono">{emBlocos(l.chave)}</div>
              </div>
              <span className={`busca-situacao antigas-${l.situacao}`} title={l.mensagem || undefined}>
                {SITUACOES[l.situacao] || l.situacao}
                {l.mensagem && PROBLEMA.has(l.situacao) && <small>{l.situacao === 'nao-envolvido' ? 'o certificado não é de quem participou da nota' : l.mensagem}</small>}
                {l.situacao === 'outro-estado' && <small>peça o XML ao fornecedor ou ao cliente</small>}
              </span>
              <span className="busca-acoes">
                {l.nota_id && <BotaoIcone icone="fa-file-lines" dica="Abrir nota" to={`/notas/${cnpj}/nota/${l.nota_id}`} />}
                {PROBLEMA.has(l.situacao) && <BotaoIcone icone="fa-rotate-right" dica="Tentar de novo" onClick={() => acao('/api/busca-antiga/tentar-de-novo', { ids: [l.id] })} />}
                <BotaoIcone icone="fa-xmark" dica="Excluir da fila" perigo onClick={() => acao('/api/busca-antiga/excluir', { ids: [l.id] })} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {!acabou && linhas.length > 0 && (
        <div className="antigas-acoes">
          <button type="button" className="botao botao-claro" onClick={() => carregar(maisDe)}>
            Mostrar mais
          </button>
        </div>
      )}
    </>
  )
}

// ---------- tela ----------

export default function BuscaPorChave() {
  const { cnpj, direcao } = useParams()
  const clientes = useApi('/api/clientes')
  // Só o estado (o resumo por empresa): a lista de notas é carregada dentro da pasta.
  const fila = useApi('/api/busca-antiga?de=999999999')
  const [aba, setAba] = useState('entrada')
  const [erro, setErro] = useState('')
  const [aviso, setAviso] = useState('')
  const [agora, setAgora] = useState(() => new Date())
  const estado = fila.dados?.estado
  const pendentes = estado?.pendentes || 0
  const { recarregar } = fila

  useEffect(() => {
    if (!pendentes) return undefined
    const lista = setInterval(recarregar, 5000)
    const relogio = setInterval(() => setAgora(new Date()), 1000)
    return () => {
      clearInterval(lista)
      clearInterval(relogio)
    }
  }, [pendentes, recarregar])

  function aoAdicionar(texto, mensagemDeErro) {
    if (mensagemDeErro) return setErro(mensagemDeErro)
    setErro('')
    setAviso(texto)
    recarregar()
  }
  const aoMudarEmpresa = (mensagemDeErro) => (mensagemDeErro ? setErro(mensagemDeErro) : recarregar())
  const acaoGeral = async (caminho) => {
    try {
      await api.post(`/api/busca-antiga/${caminho}`, {})
      recarregar()
    } catch (e) {
      setErro(e.message)
    }
  }

  const comCertificado = (clientes.dados?.clientes || []).filter((c) => c.temCertificado && !c.escritorio)
  const empresas = estado?.clientes || []
  const empresa = cnpj ? empresas.find((c) => c.cnpj === cnpj) : null
  const trilha = cnpj
    ? [
        { rotulo: 'Fila de downloads', para: BASE },
        { rotulo: empresa?.nome || formatarCnpj(cnpj), para: direcao ? `${BASE}/${cnpj}` : undefined },
        ...(direcao ? [{ rotulo: DIRECOES[direcao] || direcao }] : []),
      ]
    : undefined

  return (
    <Pagina
      titulo="Busca por chave"
      subtitulo="NF-e pela SVRS, uma por minuto"
      acoes={<Andamento estado={estado} agora={agora} aoPausar={() => acaoGeral('pausar')} aoContinuar={() => acaoGeral('continuar')} />}
      trilha={trilha}
      erro={erro || fila.erro}
      aoFecharErro={() => setErro('')}
      aviso={aviso}
    >
      {!cnpj && (
        <section className="cartao busca-adicionar">
          <Segmentado
            rotulo="Tipo de nota"
            valor={aba}
            onChange={setAba}
            opcoes={[
              { valor: 'entrada', rotulo: 'NF-e de entrada' },
              { valor: 'saida', rotulo: 'NF-e de saída' },
            ]}
          />
          {aba === 'entrada' && <NotasDeEntrada clientes={comCertificado} aoAdicionar={aoAdicionar} />}
          {aba === 'saida' && <NotasDeSaida aoAdicionar={aoAdicionar} aoTerminar={recarregar} pendentesNaFila={pendentes} />}
        </section>
      )}

      <Progresso estado={estado} agora={agora} />

      {!cnpj && (
        <>
          <h2 className="busca-titulo">Fila de downloads</h2>
          <Empresas clientes={empresas} aoMudar={aoMudarEmpresa} />
        </>
      )}
      {cnpj && (
        <div className="busca-pasta">
          {empresa && (
            <div className="busca-empresa-topo">
              <span>
                {estadoDaEmpresa(empresa)} · {inteiro(empresa.total - empresa.pendentes)} de {inteiro(empresa.total)}
              </span>
              <BotaoPausaEmpresa c={empresa} aoMudar={aoMudarEmpresa} />
            </div>
          )}
          {!empresa && <p className="apagado">Nenhuma chave desta empresa na fila.</p>}
          {empresa && !direcao && <Direcoes c={empresa} />}
          {empresa && direcao && <Notas cnpj={cnpj} direcao={direcao} pausada={empresa.pausada || estado?.pausada} d={empresa.direcoes[direcao] || { total: 0, pendentes: 0, baixadas: 0, problemas: 0 }} recarregarEstado={recarregar} />}
        </div>
      )}
    </Pagina>
  )
}
