import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import BotaoIcone from '../componentes/BotaoIcone.jsx'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura, useResumo } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { explicarSefaz, resumoDasCapturas } from '../mensagensSefaz.js'
import { nomeDe } from '../useCliente.js'
import { useSelecao } from '../useSelecao.js'
import { cnpj as formatarCnpj, data, hora, inteiro, mesAno, plural, quando } from '../formato.js'

const INTERVALO_CAPTURANDO = 5000

// Escolha ao lado do botão: as duas (padrão) ou só uma.
const MODELOS_CAPTURA = {
  nfe: { rotulo: 'NF-e', modelos: ['nfe'], aviso: 'de NF-e' },
  nfse: { rotulo: 'NFS-e', modelos: ['nfse'], aviso: 'de NFS-e' },
  ambos: { rotulo: 'Ambos', modelos: ['nfe', 'nfse'], aviso: 'de NF-e e NFS-e' },
}

// Desativado não entra na captura; bloqueado pelo 656 só fica de fora quando a captura inclui NF-e.
const marcavel = (c, oQue = '') => c.ativo && (oQue === 'nfse' || !c.bloqueadoAte)

function Certificado({ c }) {
  if (c.certDias === null || c.certDias === undefined) return '—'
  if (c.certDias < 0)
    return (
      <Etiqueta cor="vermelha" titulo={`Venceu em ${data(c.certValidade)}`}>
        Vencido
      </Etiqueta>
    )
  if (c.certDias < 30)
    return (
      <Etiqueta cor="ambar" titulo={`Válido até ${data(c.certValidade)}`}>
        {c.certDias === 0 ? 'Vence hoje' : `Vence em ${plural(c.certDias, 'dia', 'dias')}`}
      </Etiqueta>
    )
  return (
    <Etiqueta cor="verde" titulo={`Válido até ${data(c.certValidade)}`}>
      No prazo
    </Etiqueta>
  )
}

// Resumo do balão da Última captura: o que houve, quando, o que a SEFAZ respondeu e o que acontece agora.
function ResumoCaptura({ titulo, c, dica, depois }) {
  return (
    <>
      <strong>{titulo}</strong>
      {c.ultimaConsulta && <span>Última consulta {quando(c.ultimaConsulta)}.</span>}
      {c.ultimoErro && <span className="dica-sefaz">Resposta da SEFAZ: {c.ultimoErro}</span>}
      {dica && <span>{dica}</span>}
      {depois && <span>{depois}</span>}
    </>
  )
}

// Erro só da NFS-e: uma linha no balão, sem esconder o resultado da NF-e.
const erroNfse = (c) => (c.nfse?.ultimoErro ? `NFS-e: ${explicarSefaz({ erro: c.nfse.ultimoErro })?.titulo || c.nfse.ultimoErro}` : null)

function UltimaCaptura({ c, capturandoAgora, fila }) {
  if (capturandoAgora === c.cnpj) return <Etiqueta cor="ambar">Capturando…</Etiqueta>
  if (fila.includes(c.cnpj)) return <Etiqueta cor="cinza">Na fila</Etiqueta>
  const explicacao = c.ultimoErro ? explicarSefaz({ erro: c.ultimoErro }) : null
  if (c.bloqueadoAte)
    return (
      <Etiqueta
        cor="vermelha"
        titulo={
          <>
            <strong>{explicacao?.titulo || 'Bloqueio temporário da SEFAZ (656)'}</strong>
            <span>Liberado {quando(c.bloqueadoAte)}. Nenhuma nota se perde.</span>
          </>
        }
      >
        Bloqueado até {hora(c.bloqueadoAte)} (656)
      </Etiqueta>
    )
  // Toda captura que esvazia a fila da SEFAZ termina com 1 h de espera: é o normal, não um problema.
  if (c.proximaConsulta) {
    const r = resumoDasCapturas(c.ultimoRecebido, c.nfse?.ultimoRecebido)
    return (
      <>
        <Etiqueta cor={r.cor} titulo={<ResumoCaptura titulo={r.titulo} c={c} dica={r.linha} depois={erroNfse(c)} />}>
          {r.titulo}
        </Etiqueta>
        <span className="secundario">
          Consulta {quando(c.ultimaConsulta)} · próxima às {hora(c.proximaConsulta)}
        </span>
      </>
    )
  }
  if (c.ultimoErro && explicacao)
    return (
      <Etiqueta cor={explicacao.cor} titulo={<ResumoCaptura titulo={explicacao.titulo} c={c} dica={explicacao.dica} />}>
        {explicacao.titulo}
      </Etiqueta>
    )
  if (c.ultimoErro)
    return (
      <span className="captura-erro" title={c.ultimoErro}>
        <Etiqueta cor="vermelha">Erro</Etiqueta> {c.ultimoErro}
      </span>
    )
  if (c.ultimaConsulta && c.ultimoRecebido) {
    const r = resumoDasCapturas(c.ultimoRecebido, c.nfse?.ultimoRecebido)
    return (
      <>
        <Etiqueta cor={r.cor} titulo={<ResumoCaptura titulo={r.titulo} c={c} dica={r.linha} depois={erroNfse(c)} />}>
          {r.titulo}
        </Etiqueta>
        <span className="secundario">Consulta {quando(c.ultimaConsulta)}</span>
      </>
    )
  }
  if (c.ultimaConsulta)
    return (
      <span className="sem-quebra">
        <Etiqueta cor="verde">Sucesso</Etiqueta> {quando(c.ultimaConsulta)}
      </span>
    )
  return <span className="apagado">Nunca capturado</span>
}

function Pendencias({ notas: n }) {
  const itens = [
    n.resumo > 0 && { texto: `${inteiro(n.resumo)} aguardando ciência do cliente` },
    n.ciencia > 0 && {
      texto: `${inteiro(n.ciencia)} sem XML`,
      titulo: n.esgotadas ? `${plural(n.esgotadas, 'esgotou', 'esgotaram')} as tentativas de download` : 'Ciência dada; o XML completo ainda não chegou.',
    },
    n.cienciaErro > 0 && { texto: plural(n.cienciaErro, 'erro na ciência', 'erros na ciência'), erro: true },
  ].filter(Boolean)
  if (!itens.length) return '—'
  return (
    <ul className="pendencias">
      {itens.map((i) => (
        <li key={i.texto} title={i.titulo} className={i.erro ? 'pendencia-erro' : undefined}>
          {i.texto}
        </li>
      ))}
    </ul>
  )
}

function Acoes({ c, cadastroLiberado, onAtivo, ocupado }) {
  return (
    <span className="acoes-cliente">
      {cadastroLiberado && <BotaoIcone icone="fa-id-card" dica="Trocar o certificado" to={`/clientes/${c.cnpj}/certificado`} />}
      {cadastroLiberado && (
        <BotaoIcone
          icone={c.ativo ? 'fa-power-off' : 'fa-rotate-left'}
          dica={c.ativo ? 'Desativar (fica fora das capturas)' : 'Reativar (volta a entrar nas capturas)'}
          onClick={() => onAtivo(c)}
          disabled={ocupado}
          perigo={c.ativo}
        />
      )}
      <BotaoIcone icone="fa-folder-open" dica="Ver as notas" to={`/notas/${c.cnpj}`} />
    </span>
  )
}

function situacaoDoEscritorio(e, capturandoAgora, fila) {
  if (!e.ativo) return 'desativado'
  if (capturandoAgora === e.cnpj) return 'capturando…'
  if (fila.includes(e.cnpj)) return 'na fila'
  if (e.bloqueadoAte) return `bloqueado até ${hora(e.bloqueadoAte)} (656)`
  if (e.ultimoErro) {
    const titulo = explicarSefaz({ erro: e.ultimoErro })?.titulo
    return titulo ? titulo[0].toLowerCase() + titulo.slice(1) : `erro: ${e.ultimoErro}`
  }
  return null
}

function certificadoDoEscritorio(e) {
  if (e.certDias === null || e.certDias === undefined) return 'sem certificado'
  if (e.certDias < 0) return `certificado vencido em ${data(e.certValidade)}`
  if (e.certDias < 30) return `certificado vence em ${plural(e.certDias, 'dia', 'dias')}`
  return `certificado no prazo até ${mesAno(e.certValidade)}`
}

// Linha do escritório no lugar do subtítulo (certificado próprio, recebe as notas de saída).
function LinhaEscritorio({ escritorio: e, cadastroLiberado, capturandoAgora, fila }) {
  if (!e) {
    return cadastroLiberado ? <Link to="/escritorio">Cadastrar escritório (para as notas de saída)</Link> : 'Escritório não cadastrado.'
  }
  const situacao = situacaoDoEscritorio(e, capturandoAgora, fila)
  return (
    <>
      Escritório: {e.razaoSocial} · {certificadoDoEscritorio(e)}
      {situacao && ` · ${situacao}`}
      {cadastroLiberado && (
        <>
          {' · '}
          <Link to="/escritorio">Trocar certificado</Link>
        </>
      )}
    </>
  )
}

export default function Clientes() {
  const { resumo, recarregar: recarregarResumo } = useResumo()
  const { dados, erro: erroLista, recarregar } = useApi('/api/clientes')
  const { dados: escritorio, recarregar: recarregarEscritorio } = useApi('/api/escritorio')
  const selecao = useSelecao('clientes')
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(null)
  const [oQue, setOQue] = useState('ambos')
  const [busca, setBusca] = useState('')

  useAoTerminarCaptura(() => {
    recarregar()
    recarregarEscritorio()
  })

  const lista = dados?.clientes || []
  const capturandoAgora = dados?.capturandoAgora || null
  const fila = dados?.filaCaptura || []
  const capturando = !!(resumo?.capturaEmAndamento || capturandoAgora || fila.length)
  const cadastroLiberado = !!resumo?.cadastroLiberado

  // Ao abrir, vêm marcados todos os ativos que não estão bloqueados.
  const marcouAoAbrir = useRef(false)
  useEffect(() => {
    if (!dados || marcouAoAbrir.current) return
    marcouAoAbrir.current = true
    selecao.marcar(dados.clientes.filter(marcavel).map((c) => c.cnpj))
  }, [dados])

  // Durante a captura, a lista recarrega a cada 5 s para mostrar quem está sendo capturado e quem está na fila.
  useEffect(() => {
    if (!capturando) return undefined
    const t = setInterval(() => {
      recarregar()
      recarregarEscritorio()
    }, INTERVALO_CAPTURANDO)
    return () => clearInterval(t)
  }, [capturando])

  // Ativos na ordem do servidor; desativados no fim.
  const ordenados = [...lista.filter((c) => c.ativo), ...lista.filter((c) => !c.ativo)]
  // Busca por nome, razão social ou CNPJ (com ou sem pontuação).
  const termo = busca.trim().toLowerCase()
  const digitos = termo.replace(/D/g, '')
  const visiveis = ordenados.filter(
    (c) => !termo || nomeDe(c).toLowerCase().includes(termo) || (c.razaoSocial || '').toLowerCase().includes(termo) || (digitos && c.cnpj.includes(digitos)),
  )
  const podeMarcar = (c) => marcavel(c, oQue)
  const marcados = lista.filter((c) => podeMarcar(c) && selecao.ids.has(c.cnpj)).map((c) => c.cnpj)

  async function executar(nome, fn) {
    setOcupado(nome)
    setErro(null)
    setAviso(null)
    try {
      await fn()
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(null)
    }
  }

  // Hora em que o cliente volta a ser consultado nos modelos escolhidos (null = já pode).
  // Cada serviço pede 1 hora entre consultas do mesmo CNPJ; a captura pula quem ainda está esperando.
  const liberadoEm = (c) => {
    const esperas = MODELOS_CAPTURA[oQue].modelos.map((m) => (m === 'nfse' ? c.nfse?.proximaConsulta : c.proximaConsulta || c.bloqueadoAte))
    return esperas.every(Boolean) ? esperas.sort().at(0) : null
  }

  const capturar = () =>
    executar('capturar', async () => {
      const marcadosLista = lista.filter((c) => marcados.includes(c.cnpj))
      const esperando = marcadosLista.filter(liberadoEm)
      if (esperando.length === marcadosLista.length) {
        const primeiro = esperando.map(liberadoEm).sort()[0]
        setAviso(`Nada para consultar agora: ${esperando.length === 1 ? 'o cliente marcado foi consultado' : 'os clientes marcados foram consultados'} há menos de 1 hora. Libera às ${hora(primeiro)}.`)
        return
      }
      try {
        await api.post('/api/captura', { cnpjs: marcados, modelos: MODELOS_CAPTURA[oQue].modelos })
        const pulados = esperando.length ? ` ${plural(esperando.length, 'cliente consultado', 'clientes consultados')} há menos de 1 hora fica${esperando.length === 1 ? '' : 'm'} para depois.` : ''
        setAviso(`Captura ${MODELOS_CAPTURA[oQue].aviso} de ${plural(marcados.length - esperando.length, 'cliente', 'clientes')} iniciada.${pulados} Acompanhe na coluna Última captura.`)
      } finally {
        recarregarResumo()
        recarregar()
      }
    })

  function alternarAtivo(c) {
    const nome = nomeDe(c)
    const pergunta = c.ativo
      ? `Desativar ${nome}? Ele fica fora das capturas até ser reativado. Nada é apagado.`
      : `Reativar ${nome}? Ele volta a entrar nas capturas.`
    if (!window.confirm(pergunta)) return
    executar('ativo', async () => {
      const r = await api.post(`/api/clientes/${c.cnpj}/ativo`, { ativo: !c.ativo })
      if (r.ativo) selecao.marcar([c.cnpj])
      else selecao.desmarcar([c.cnpj])
      setAviso(`${nome}: ${r.mensagem.charAt(0).toLowerCase()}${r.mensagem.slice(1)}`)
      recarregar()
      recarregarResumo()
    })
  }

  let conteudo
  if (!dados) conteudo = !erroLista && <p className="vazio">Carregando…</p>
  else if (!lista.length)
    conteudo = (
      <p className="vazio">
        Nenhum cliente cadastrado.{' '}
        {cadastroLiberado ? (
          <>
            Use <Link to="/clientes/novo">Novo cliente</Link> para cadastrar o primeiro, com o certificado A1 dele.
          </>
        ) : (
          'O cadastro de clientes é feito no computador onde o Smart Fiscal está instalado.'
        )}
      </p>
    )
  else if (!visiveis.length) conteudo = <p className="vazio">Nenhum cliente encontrado para essa busca.</p>
  else
    conteudo = (
      <div className="tabela-moldura">
        <table className="tabela tabela-clientes">
          <thead>
            <tr>
              <th scope="col" className="marcar">
                <span className="so-leitor">Capturar</span>
              </th>
              <th scope="col">Cliente</th>
              <th scope="col">CNPJ</th>
              <th scope="col">Certificado</th>
              <th scope="col">Última captura</th>
              <th scope="col">Pendências</th>
              <th scope="col" className="col-acoes">
                <span className="so-leitor">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((c) => {
              const marcado = podeMarcar(c) && selecao.ids.has(c.cnpj)
              return (
                <tr key={c.cnpj} className={!c.ativo ? 'inativo' : marcado ? 'selecionada' : undefined}>
                  <td className="marcar">
                    {c.ativo && (
                      <input
                        type="checkbox"
                        aria-label={`Capturar ${nomeDe(c)}`}
                        title={c.bloqueadoAte && !podeMarcar(c) ? `NF-e bloqueada pela SEFAZ até ${hora(c.bloqueadoAte)} (656). Dá para capturar só NFS-e.` : undefined}
                        checked={marcado}
                        disabled={!podeMarcar(c)}
                        onChange={() => selecao.alternar(c.cnpj)}
                      />
                    )}
                  </td>
                  <td className="nome-cliente">
                    {nomeDe(c)}
                    {c.apelido && <span className="secundario">{c.razaoSocial}</span>}
                    {!c.ativo && <span className="secundario">Desativado</span>}
                  </td>
                  <td className="mono sem-quebra">{formatarCnpj(c.cnpj)}</td>
                  <td className="sem-quebra">
                    <Certificado c={c} />
                  </td>
                  <td>{c.ativo ? <UltimaCaptura c={c} capturandoAgora={capturandoAgora} fila={fila} /> : '—'}</td>
                  <td>
                    <Pendencias notas={c.notas} />
                  </td>
                  <td className="sem-quebra">
                    <Acoes c={c} cadastroLiberado={cadastroLiberado} onAtivo={alternarAtivo} ocupado={!!ocupado} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )

  const algumMarcavel = lista.some(podeMarcar)

  return (
    <Pagina
      titulo="Clientes"
      subtitulo={<LinhaEscritorio escritorio={escritorio} cadastroLiberado={cadastroLiberado} capturandoAgora={capturandoAgora} fila={fila} />}
      acoes={
        cadastroLiberado && (
          <Link className="botao botao-azul" to="/clientes/novo">
            Novo cliente
          </Link>
        )
      }
      erro={erro || erroLista}
      aoFecharErro={erro ? () => setErro(null) : undefined}
      aviso={aviso}
    >
      {!!lista.length && (
        <div className="barra-notas">
          <div className="grupo-botoes">
            <button
              type="button"
              className="botao botao-claro"
              onClick={() => selecao.marcar(visiveis.filter(podeMarcar).map((c) => c.cnpj))}
              disabled={!algumMarcavel}
            >
              Marcar todos
            </button>
            <button type="button" className="botao botao-claro" onClick={selecao.limpar} disabled={!marcados.length}>
              Desmarcar todos
            </button>
          </div>
          <Segmentado
            rotulo="O que capturar"
            valor={oQue}
            onChange={setOQue}
            opcoes={Object.entries(MODELOS_CAPTURA).map(([valor, m]) => ({ valor, rotulo: m.rotulo }))}
          />
          <button type="button" className="botao botao-verde" onClick={capturar} disabled={!marcados.length || capturando || !!ocupado}>
            {capturando || ocupado === 'capturar' ? 'Capturando…' : `⟳ Capturar selecionados (${inteiro(marcados.length)})`}
          </button>
        </div>
      )}
      {!!lista.length && (
        <div className="busca">
          <label htmlFor="busca-clientes">Buscar cliente</label>
          <input
            id="busca-clientes"
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome ou CNPJ"
            autoComplete="off"
          />
        </div>
      )}
      {conteudo}
    </Pagina>
  )
}
