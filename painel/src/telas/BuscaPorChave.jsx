import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import Pagina from '../layout/Pagina.jsx'
import Pasta from '../componentes/Pasta.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import Interruptor from '../componentes/Interruptor.jsx'
import BotaoIcone from '../componentes/BotaoIcone.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { bytesBase64 } from '../arquivoBase64.js'
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

// ---------- adicionar: colar, SPED, saídas ----------

function ColarChaves({ clientes, aoAdicionar }) {
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
      <label className="campo">
        <span>Cliente</span>
        <select value={cnpj} onChange={(e) => setCnpj(e.target.value)} required>
          <option value="">Escolha o cliente</option>
          {clientes.map((c) => (
            <option key={c.cnpj} value={c.cnpj}>
              {c.apelido || c.razaoSocial}
            </option>
          ))}
        </select>
      </label>
      <label className="campo">
        <span>Cole as chaves de acesso (uma por linha ou como vierem)</span>
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

function ArquivoSped({ aoAdicionar }) {
  const entrada = useRef(null)
  const [arquivos, setArquivos] = useState(null)
  const [resumo, setResumo] = useState(null)
  const [trabalhando, setTrabalhando] = useState(false)
  const [arrastando, setArrastando] = useState(false)
  async function ler(lista) {
    const escolhidos = [...lista]
    if (!escolhidos.length) return
    setTrabalhando(true)
    try {
      const corpo = await Promise.all(escolhidos.map(async (a) => ({ nome: a.name, base64: await bytesBase64(a) })))
      const r = await api.post('/api/busca-antiga/sped', { arquivos: corpo })
      setArquivos(corpo)
      setResumo(r.arquivos)
    } catch (e) {
      aoAdicionar(null, e.message)
    } finally {
      setTrabalhando(false)
      if (entrada.current) entrada.current.value = ''
    }
  }
  async function confirmar() {
    setTrabalhando(true)
    try {
      const r = await api.post('/api/busca-antiga/sped', { arquivos, confirmar: true })
      setArquivos(null)
      setResumo(null)
      aoAdicionar(resumoDaAdicao(r))
    } catch (e) {
      aoAdicionar(null, e.message)
    } finally {
      setTrabalhando(false)
    }
  }
  const validos = (resumo || []).filter((a) => !a.erro)
  return (
    <div className="busca-sped">
      <button
        type="button"
        className={`cartao importar-area${arrastando ? ' importar-area-ativa' : ''}`}
        disabled={trabalhando}
        onClick={() => entrada.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setArrastando(true)
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault()
          setArrastando(false)
          ler(e.dataTransfer.files)
        }}
      >
        <i className="fa-solid fa-file-lines" aria-hidden="true" />
        <span>{trabalhando ? 'Lendo…' : 'Solte aqui o SPED Fiscal do cliente (.txt), ou clique para escolher'}</span>
      </button>
      <input ref={entrada} type="file" multiple accept=".txt" hidden onChange={(e) => ler(e.target.files)} />
      {resumo && (
        <div className="busca-sped-resumo">
          <ul>
            {resumo.map((a) => (
              <li key={a.nome} className={a.erro ? 'busca-erro' : undefined}>
                <strong>{a.cliente || a.nome}</strong>
                <span>
                  {a.periodo && `${a.periodo.slice(5)}/${a.periodo.slice(0, 4)} · `}
                  {a.erro || `${plural(a.saidas + a.entradas, 'chave', 'chaves')} (${plural(a.saidas, 'saída', 'saídas')}, ${plural(a.entradas, 'entrada', 'entradas')})`}
                </span>
              </li>
            ))}
          </ul>
          <div className="antigas-acoes">
            <button type="button" className="botao botao-claro" onClick={() => setResumo(null)} disabled={trabalhando}>
              Cancelar
            </button>
            <button type="button" className="botao botao-azul" onClick={confirmar} disabled={trabalhando || !validos.length}>
              Colocar na fila
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function InicioDaSerie({ cnpj, aoSalvar }) {
  const [chave, setChave] = useState('')
  const [erro, setErro] = useState('')
  async function salvar(e) {
    e.preventDefault()
    setErro('')
    try {
      await api.post('/api/saidas/inicio', { cnpj, chave })
      setChave('')
      aoSalvar()
    } catch (e2) {
      setErro(e2.message)
    }
  }
  return (
    <form className="busca-inicio" onSubmit={salvar}>
      <input className="entrada" value={chave} onChange={(e) => setChave(e.target.value)} placeholder="cole a chave de uma saída recente para começar" spellCheck={false} />
      <button type="submit" className="botao botao-claro" disabled={!chave.trim()}>
        Usar
      </button>
      {erro && <span className="busca-erro">{erro}</span>}
    </form>
  )
}

function SaidasPeloCertificado({ aoAdicionar }) {
  const saidas = useApi('/api/saidas')
  const lista = saidas.dados?.clientes || []
  const rodando = !!saidas.dados?.rodando
  const { recarregar } = saidas
  useEffect(() => {
    if (!rodando) return undefined
    const t = setInterval(recarregar, 3000)
    return () => clearInterval(t)
  }, [rodando, recarregar])
  async function ligar(cnpj, ligado) {
    try {
      await api.post('/api/saidas/ligar', { cnpj, ligado })
      recarregar()
    } catch (e) {
      aoAdicionar(null, e.message)
    }
  }
  async function procurar() {
    try {
      await api.post('/api/saidas/procurar', {})
      recarregar()
    } catch (e) {
      aoAdicionar(null, e.message)
    }
  }
  return (
    <div className="busca-saidas">
      <p className="apagado">O app acha as NF-e de saída pelo número na SEFAZ (últimos 6 meses) e põe na fila. Roda depois de cada captura.</p>
      {!lista.length && <p>Nenhum cliente com certificado no prazo de estado atendido pela SVRS.</p>}
      <ul className="busca-saidas-lista">
        {lista.map((c) => (
          <li key={c.cnpj}>
            <Interruptor ligado={c.ligado} onChange={(v) => ligar(c.cnpj, v)} rotulo={c.nome} />
            <span className="busca-saidas-series">
              {c.series.length
                ? c.series.map((s) => (
                    <span key={s.serie} className={s.ultimo_erro ? 'busca-erro' : undefined} title={s.ultimo_erro || undefined}>
                      Série {s.serie}: último nº {inteiro(s.ultimo_numero)}
                      {s.achadas ? ` · ${plural(s.achadas, 'chave achada', 'chaves achadas')}` : ''}
                      {s.ultimo_erro ? ' · com aviso' : ''}
                    </span>
                  ))
                : c.ligado && <InicioDaSerie cnpj={c.cnpj} aoSalvar={recarregar} />}
            </span>
          </li>
        ))}
      </ul>
      <div className="antigas-acoes">
        <button type="button" className="botao botao-azul" onClick={procurar} disabled={rodando || !lista.some((c) => c.ligado)}>
          {rodando ? 'Procurando…' : 'Procurar agora'}
        </button>
      </div>
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
    await api.post('/api/busca-antiga/cliente-pausa', { cnpj: c.cnpj, pausada })
    aoMudar()
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

  async function carregar(de = 0) {
    try {
      const r = await api.get(`/api/busca-antiga?cnpj=${cnpj}&direcao=${direcao}${filtro ? `&situacao=${filtro}` : ''}&de=${de}`)
      setLinhas((atual) => (de ? [...atual, ...r.linhas] : r.linhas))
      setAcabou(r.linhas.length < 200)
      setMaisDe(de + r.linhas.length)
    } catch (e) {
      setErro(e.message)
    }
  }
  // Recarrega com o filtro e, enquanto houver fila, a cada 5 s (sem sair do lugar na lista).
  useEffect(() => {
    carregar(0)
  }, [cnpj, direcao, filtro]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d.pendentes) return undefined
    const t = setInterval(() => carregar(0), 5000)
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
      await carregar(0)
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
  const [aba, setAba] = useState('colar')
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
            rotulo="Como adicionar chaves"
            valor={aba}
            onChange={setAba}
            opcoes={[
              { valor: 'colar', rotulo: 'Colar chaves' },
              { valor: 'sped', rotulo: 'Arquivo SPED' },
              { valor: 'saidas', rotulo: 'Saídas pelo certificado' },
            ]}
          />
          {aba === 'colar' && <ColarChaves clientes={comCertificado} aoAdicionar={aoAdicionar} />}
          {aba === 'sped' && <ArquivoSped aoAdicionar={aoAdicionar} />}
          {aba === 'saidas' && <SaidasPeloCertificado aoAdicionar={aoAdicionar} />}
        </section>
      )}

      <Progresso estado={estado} agora={agora} />

      {!cnpj && (
        <>
          <h2 className="busca-titulo">Fila de downloads</h2>
          <Empresas clientes={empresas} aoMudar={recarregar} />
        </>
      )}
      {cnpj && (
        <div className="busca-pasta">
          {empresa && (
            <div className="busca-empresa-topo">
              <span>
                {estadoDaEmpresa(empresa)} · {inteiro(empresa.total - empresa.pendentes)} de {inteiro(empresa.total)}
              </span>
              <BotaoPausaEmpresa c={empresa} aoMudar={recarregar} />
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
