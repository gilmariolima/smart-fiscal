import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Interruptor from '../componentes/Interruptor.jsx'
import SeloCertificado from '../componentes/SeloCertificado.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura, useResumo } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { explicarSefaz, resumoDaCaptura } from '../mensagensSefaz.js'
import { nomeDe } from '../useCliente.js'
import { useSelecao } from '../useSelecao.js'
import { cnpj as formatarCnpj, hora, inteiro, plural, quando, rotuloDaCaptura } from '../formato.js'

const INTERVALO_CAPTURANDO = 5000

// Um card por tipo de documento, cada um na sua cor.
export const MODELOS = {
  nfe: { rotulo: 'NF-e', icone: 'fa-file-invoice', cor: 'azul' },
  nfse: { rotulo: 'NFS-e', icone: 'fa-file-signature', cor: 'roxo' },
  cte: { rotulo: 'CT-e', icone: 'fa-truck', cor: 'laranja' },
}

// Dados da captura de um modelo: a NF-e fica na raiz do cliente, a NFS-e em `nfse` e o CT-e em `cte`.
const capturaDo = (c, modelo) => {
  if (modelo === 'nfse') return { ...c.nfse, bloqueadoAte: null }
  if (modelo === 'cte') return c.cte || {}
  return c
}

// Desativado não entra; bloqueado pelo 656 (NF-e e CT-e, cada um com o seu) fica de fora.
const marcavel = (c, modelo) => c.ativo && c.temCertificado && !capturaDo(c, modelo).bloqueadoAte

// Cada serviço pede 1 hora entre consultas do mesmo CNPJ; a captura pula quem ainda está esperando.
const liberadoEm = (c, modelo) => {
  const x = capturaDo(c, modelo)
  return x.proximaConsulta || x.bloqueadoAte || null
}

function situacao(x) {
  const explicacao = x.ultimoErro ? explicarSefaz({ erro: x.ultimoErro }) : null
  if (x.bloqueadoAte)
    return (
      <Etiqueta cor="vermelha" titulo={`Liberado ${quando(x.bloqueadoAte)}. Nenhuma nota se perde.`}>
        Bloqueado até {hora(x.bloqueadoAte)} (656)
      </Etiqueta>
    )
  // Toda captura que esvazia a fila termina com 1 h de espera: o resultado dela vale mais que um erro antigo.
  if (x.ultimoErro && !(x.proximaConsulta && x.ultimoRecebido))
    return (
      <Etiqueta cor={explicacao?.cor || 'vermelha'} titulo={explicacao?.dica || x.ultimoErro}>
        {explicacao?.titulo || 'Erro'}
      </Etiqueta>
    )
  if (x.ultimoRecebido) {
    const r = resumoDaCaptura({ cStat: 138, ...x.ultimoRecebido })
    return (
      <Etiqueta cor={r.cor} titulo={r.detalhe}>
        {r.titulo}
      </Etiqueta>
    )
  }
  if (x.ultimaConsulta) return <Etiqueta cor="verde">Sucesso</Etiqueta>
  return null
}

// Notas que chegaram na última captura do modelo (tela NotasNovas).
function VerNotasNovas({ cnpj, modelo }) {
  return (
    <Link className="ver-novas" to={`/capturar/${modelo}/novas/${cnpj}`}>
      Ver notas
    </Link>
  )
}

const TODOS = 'todos'

function UltimaCaptura({ c, modelo, capturandoAgora, fila }) {
  if (capturandoAgora === c.cnpj) return <Etiqueta cor="ambar">Capturando…</Etiqueta>
  if (fila.includes(c.cnpj)) return <Etiqueta cor="cinza">Na fila</Etiqueta>
  const x = capturaDo(c, modelo)
  const etiqueta = situacao(x)
  if (!etiqueta) return <span className="apagado">Nunca capturado</span>
  return (
    <>
      {etiqueta}
      {x.ultimaConsulta && <span className="secundario">Consulta {quando(x.ultimaConsulta)}</span>}
      {x.ultimoRecebido?.notas > 0 && <VerNotasNovas cnpj={c.cnpj} modelo={modelo} />}
    </>
  )
}

function Cards({ escolhido }) {
  const navegar = useNavigate()
  return (
    <ul className="cards-captura">
      {Object.entries(MODELOS).map(([chave, m]) => (
        <li key={chave}>
          <button
            type="button"
            className={`card-captura card-${m.cor}${escolhido === chave ? ' escolhido' : ''}`}
            aria-pressed={escolhido === chave}
            disabled={m.emBreve}
            onClick={() => navegar(`/capturar/${chave}`)}
          >
            <i className={`fa-solid ${m.icone}`} aria-hidden="true" />
            <span>
              <strong>
                {m.rotulo}
                {m.emBreve && <Etiqueta cor="cinza">Em breve</Etiqueta>}
              </strong>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// Andamento da captura: quantos clientes já passaram e quem está sendo consultado agora.
function BarraDaCaptura({ progresso, pulados }) {
  const porcento = progresso ? Math.round((progresso.posicao / progresso.total) * 100) : 0
  return (
    <div className="barra-captura" role="status">
      <div className="barra-captura-texto">
        <strong>{progresso ? `Capturando ${progresso.nome}` : 'Iniciando a captura'}</strong>
        <span>{progresso ? `${inteiro(progresso.posicao)} de ${inteiro(progresso.total)}` : ''}</span>
      </div>
      <div className="barra-captura-trilho" role="progressbar" aria-label="Andamento da captura" aria-valuemin={0} aria-valuemax={100} aria-valuenow={porcento}>
        <div className="barra-captura-preenchido" style={{ width: `${porcento}%` }} />
      </div>
      {pulados && <p className="barra-captura-nota">{pulados}</p>}
    </div>
  )
}

function ListaDeClientes({ modelo }) {
  const { resumo, recarregar: recarregarResumo } = useResumo()
  const { dados, erro: erroLista, recarregar } = useApi('/api/clientes')
  const selecao = useSelecao(`captura-${modelo}`)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [pulados, setPulados] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [busca, setBusca] = useState('')
  const [trocando, setTrocando] = useState(null)

  useAoTerminarCaptura(recarregar)

  const lista = dados?.clientes || []
  const capturandoAgora = dados?.capturandoAgora || null
  const fila = dados?.filaCaptura || []
  const capturando = !!(resumo?.capturaEmAndamento || capturandoAgora || fila.length)

  // Ao abrir cada tipo de nota, ninguém vem marcado: quem captura escolhe (ou usa Marcar todos).

  // Durante a captura, a lista recarrega a cada 5 s para mostrar quem está sendo capturado e quem está na fila.
  useEffect(() => {
    if (!capturando) return undefined
    const t = setInterval(recarregar, INTERVALO_CAPTURANDO)
    return () => clearInterval(t)
  }, [capturando])

  // Sem certificado não há o que capturar: fica só na tela Clientes.
  const ativos = lista.filter((c) => c.ativo && c.temCertificado)
  const semCertificado = lista.filter((c) => !c.temCertificado).length
  const termo = busca.trim().toLowerCase()
  const digitos = termo.replace(/\D/g, '')
  const visiveis = ativos.filter(
    (c) => !termo || nomeDe(c).toLowerCase().includes(termo) || (c.razaoSocial || '').toLowerCase().includes(termo) || (digitos && c.cnpj.includes(digitos)),
  )
  const marcados = ativos.filter((c) => marcavel(c, modelo) && selecao.ids.has(c.cnpj))
  const rotulo = MODELOS[modelo].rotulo

  async function capturar() {
    setEnviando(true)
    setErro(null)
    setAviso(null)
    setPulados(null)
    try {
      const esperando = marcados.filter((c) => liberadoEm(c, modelo))
      if (esperando.length === marcados.length) {
        const primeiro = esperando.map((c) => liberadoEm(c, modelo)).sort()[0]
        setAviso(`Nada para consultar agora: ${esperando.length === 1 ? 'o cliente marcado foi consultado' : 'os clientes marcados foram consultados'} há menos de 1 hora. Libera às ${hora(primeiro)}.`)
        return
      }
      await api.post('/api/captura', { cnpjs: marcados.map((c) => c.cnpj), modelos: [modelo] })
      if (esperando.length) setPulados(`${plural(esperando.length, 'cliente consultado', 'clientes consultados')} há menos de 1 hora fica${esperando.length === 1 ? '' : 'm'} para depois.`)
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
      recarregarResumo()
      recarregar()
    }
  }

  // Liga/desliga o cliente nos horários da busca automática deste tipo de nota; o botão Capturar não muda.
  async function alternarAutomatica(c, ligado) {
    setTrocando(c.cnpj)
    setErro(null)
    try {
      await api.post(`/api/clientes/${c.cnpj}/automatica`, { modelo, ligado })
      recarregar()
    } catch (e) {
      setErro(e.message)
    } finally {
      setTrocando(null)
    }
  }

  // Vale para quem está na lista (com a busca, só os encontrados) e só neste tipo de nota.
  const automaticaLigada = (c) => c.automatica?.[modelo] !== false
  async function alternarTodas(ligado) {
    setTrocando(TODOS)
    setErro(null)
    try {
      await api.post('/api/clientes/automatica', { modelo, ligado, cnpjs: visiveis.filter((c) => automaticaLigada(c) !== ligado).map((c) => c.cnpj) })
      recarregar()
    } catch (e) {
      setErro(e.message)
    } finally {
      setTrocando(null)
    }
  }

  let conteudo
  if (!dados) conteudo = !erroLista && <p className="vazio">Carregando…</p>
  else if (!ativos.length)
    conteudo = (
      <p className="vazio">
        Nenhum cliente ativo. Cadastre ou reative em <Link to="/clientes">Clientes</Link>.
      </p>
    )
  else if (!visiveis.length) conteudo = <p className="vazio">Nenhum cliente encontrado para essa busca.</p>
  else
    conteudo = (
      <div className="tabela-moldura">
        <table className="tabela tabela-clientes tabela-captura">
          <thead>
            <tr>
              <th scope="col" className="marcar">
                <span className="so-leitor">Capturar</span>
              </th>
              <th scope="col">Cliente</th>
              <th scope="col" className="col-cnpj">CNPJ</th>
              <th scope="col" className="col-certificado">Certificado</th>
              <th scope="col" className="col-ultima">Última captura de {rotulo}</th>
              <th scope="col" className="col-automatica" title={`Desligado: o cliente fica fora dos horários da busca automática de ${rotulo}, mas continua podendo ser capturado pelo botão.`}>
                Automática
              </th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((c) => {
              const pode = marcavel(c, modelo)
              const marcado = pode && selecao.ids.has(c.cnpj)
              return (
                <tr key={c.cnpj} className={marcado ? 'selecionada' : undefined}>
                  <td className="marcar">
                    <input
                      type="checkbox"
                      aria-label={`Capturar ${nomeDe(c)}`}
                      title={c.ativo && !pode ? `Consulta de ${rotulo} bloqueada pela SEFAZ até ${hora(capturaDo(c, modelo).bloqueadoAte)} (656).` : undefined}
                      checked={marcado}
                      disabled={!pode}
                      onChange={() => selecao.alternar(c.cnpj)}
                    />
                  </td>
                  <td className="nome-cliente">
                    {nomeDe(c)}
                    {c.apelido && <span className="secundario">{c.razaoSocial}</span>}
                    {c.escritorio && <span className="secundario">Escritório</span>}
                  </td>
                  <td className="mono sem-quebra">{formatarCnpj(c.cnpj)}</td>
                  <td className="sem-quebra">
                    <SeloCertificado c={c} />
                  </td>
                  <td>
                    <UltimaCaptura c={c} modelo={modelo} capturandoAgora={capturandoAgora} fila={fila} />
                  </td>
                  <td className="sem-quebra">
                    <Interruptor
                      ligado={c.automatica?.[modelo] !== false}
                      onChange={(ligado) => alternarAutomatica(c, ligado)}
                      desabilitado={trocando === c.cnpj || trocando === TODOS}
                      rotulo={c.automatica?.[modelo] !== false ? 'Ligada' : 'Desligada'}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )

  return (
    <section className="lista-captura" aria-label={`Clientes para capturar ${rotulo}`}>
      {erro && (
        <div className="faixa faixa-erro" role="alert">
          {erro}
        </div>
      )}
      {aviso && (
        <div className="faixa faixa-ok" role="status">
          {aviso}
        </div>
      )}
      {(capturando || enviando) && <BarraDaCaptura progresso={resumo?.capturaProgresso} pulados={pulados} />}
      {erroLista && (
        <div className="faixa faixa-erro" role="alert">
          {erroLista}
        </div>
      )}
      {!!ativos.length && (
        <div className="barra-notas">
          <div className="grupo-botoes">
            <button
              type="button"
              className="botao botao-claro"
              onClick={() => selecao.marcar(visiveis.filter((c) => marcavel(c, modelo)).map((c) => c.cnpj))}
              disabled={!ativos.some((c) => marcavel(c, modelo))}
            >
              Marcar todos
            </button>
            <button type="button" className="botao botao-claro" onClick={selecao.limpar} disabled={!marcados.length}>
              Desmarcar todos
            </button>
          </div>
          <div className="grupo-botoes grupo-automatica" role="group" aria-label={`Busca automática de ${rotulo}`}>
            <span className="grupo-rotulo">Busca automática</span>
            <button
              type="button"
              className="botao botao-claro"
              onClick={() => alternarTodas(true)}
              disabled={!!trocando || visiveis.every(automaticaLigada)}
              title={`Liga a busca automática de ${rotulo} em todos os clientes da lista`}
            >
              Ligar todos
            </button>
            <button
              type="button"
              className="botao botao-claro"
              onClick={() => alternarTodas(false)}
              disabled={!!trocando || !visiveis.some(automaticaLigada)}
              title={`Desliga a busca automática de ${rotulo} em todos os clientes da lista. O botão Capturar continua valendo.`}
            >
              Desligar todos
            </button>
          </div>
          <button
            type="button"
            className="botao botao-verde"
            onClick={capturar}
            disabled={!marcados.length || capturando || enviando || !!resumo?.pastaPendente}
            title={resumo?.pastaPendente ? 'Escolha a pasta principal' : undefined}
          >
            {capturando || enviando ? rotuloDaCaptura(resumo?.capturaProgresso) : `⟳ Capturar ${rotulo} (${inteiro(marcados.length)})`}
          </button>
        </div>
      )}
      {!!ativos.length && (
        <div className="busca">
          <label htmlFor="busca-captura">Buscar cliente</label>
          <input id="busca-captura" type="search" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome ou CNPJ" autoComplete="off" />
        </div>
      )}
      {conteudo}
      {semCertificado > 0 && (
        <p className="rodape-tabela">
          {plural(semCertificado, 'cliente sem certificado não aparece', 'clientes sem certificado não aparecem')} aqui. Adicione o certificado em <Link to="/clientes">Clientes</Link>.
        </p>
      )}
    </section>
  )
}

// Horários do dia em que a busca automática roda (valem na hora, sem reiniciar).
// Quem entra em cada horário é a chave de cada cliente na lista.
function BuscaAutomatica({ aoErrar }) {
  const { resumo, recarregar } = useResumo()
  const [novo, setNovo] = useState('')
  const [enviando, setEnviando] = useState(false)
  if (!resumo) return null
  const horarios = resumo.agendador?.horarios || []

  async function enviar(corpo) {
    setEnviando(true)
    aoErrar(null)
    try {
      await api.post('/api/automacao', corpo)
      return true
    } catch (e) {
      aoErrar(e.message)
      return false
    } finally {
      setEnviando(false)
      recarregar()
    }
  }

  async function adicionar(e) {
    e.preventDefault()
    if (!novo || horarios.includes(novo)) return setNovo('')
    if (await enviar({ horarios: [...horarios, novo] })) setNovo('')
  }

  return (
    <div className="automacao">
      <span className="grupo-rotulo">Horários da busca automática</span>
      <div className="horarios" role="group" aria-label="Horários da busca automática">
        {horarios.map((h) => (
          <span key={h} className="horario">
            {h}
            <button
              type="button"
              aria-label={`Tirar ${h}`}
              title="Tirar"
              disabled={enviando}
              onClick={() => enviar({ horarios: horarios.filter((x) => x !== h) })}
            >
              ×
            </button>
          </span>
        ))}
        <form className="horario-novo" onSubmit={adicionar}>
          <input type="time" aria-label="Novo horário" value={novo} onChange={(e) => setNovo(e.target.value)} disabled={enviando} />
          <button type="submit" className="botao botao-claro" disabled={!novo || enviando}>
            Adicionar
          </button>
        </form>
      </div>
    </div>
  )
}

export default function Capturar() {
  const { modelo } = useParams()
  const [erro, setErro] = useState(null)
  // Abre já com a NF-e escolhida e a lista de clientes na tela.
  const escolhido = MODELOS[modelo] && !MODELOS[modelo].emBreve ? modelo : 'nfe'
  return (
    <Pagina
      titulo="Capturar"
      subtitulo={`Clientes para capturar ${MODELOS[escolhido].rotulo}`}
      acoes={<BuscaAutomatica aoErrar={setErro} />}
      erro={erro}
      aoFecharErro={() => setErro(null)}
    >
      <Cards escolhido={escolhido} />
      <ListaDeClientes key={escolhido} modelo={escolhido} />
    </Pagina>
  )
}
