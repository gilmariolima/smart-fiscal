import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import BotaoIcone from '../componentes/BotaoIcone.jsx'
import Etiqueta from '../componentes/Etiqueta.jsx'
import SeloCertificado from '../componentes/SeloCertificado.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura, useResumo } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { explicarSefaz, resumoDasCapturas } from '../mensagensSefaz.js'
import { nomeDe } from '../useCliente.js'
import { cnpj as formatarCnpj, data, hora, inteiro, mesAno, plural, quando } from '../formato.js'

const INTERVALO_CAPTURANDO = 5000

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

// A consulta mais recente, da NF-e ou da NFS-e
const ultimaConsulta = (c) => [c.ultimaConsulta, c.nfse?.ultimaConsulta].filter(Boolean).sort().pop() || null

// Toda situação mostra embaixo quando foi a última consulta
function UltimaCaptura({ c, capturandoAgora, fila }) {
  if (capturandoAgora === c.cnpj) return <Etiqueta cor="ambar">Capturando…</Etiqueta>
  if (fila.includes(c.cnpj)) return <Etiqueta cor="cinza">Na fila</Etiqueta>
  const etiqueta = situacaoDaCaptura(c)
  if (!etiqueta) return <span className="apagado">Nunca capturado</span>
  const em = ultimaConsulta(c)
  return (
    <>
      {etiqueta}
      {em && <span className="secundario">Consulta {quando(em)}</span>}
    </>
  )
}

function situacaoDaCaptura(c) {
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
  if (c.proximaConsulta || (c.ultimaConsulta && c.ultimoRecebido)) {
    const r = resumoDasCapturas(c.ultimoRecebido, c.nfse?.ultimoRecebido)
    return (
      <Etiqueta cor={r.cor} titulo={<ResumoCaptura titulo={r.titulo} c={c} dica={r.linha} depois={erroNfse(c)} />}>
        {r.titulo}
      </Etiqueta>
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
  if (ultimaConsulta(c)) return <Etiqueta cor="verde">Sucesso</Etiqueta>
  return null
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
          dica={c.escritorio ? 'Tirar da lista de clientes' : c.ativo ? 'Desativar (fica fora das capturas)' : 'Reativar (volta a entrar nas capturas)'}
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
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(null)
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
  const digitos = termo.replace(/\D/g, '')
  const visiveis = ordenados.filter(
    (c) => !termo || nomeDe(c).toLowerCase().includes(termo) || (c.razaoSocial || '').toLowerCase().includes(termo) || (digitos && c.cnpj.includes(digitos)),
  )

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

  function alternarAtivo(c) {
    const nome = nomeDe(c)
    const pergunta = c.escritorio
      ? `Tirar ${nome} da lista de clientes? As notas do próprio escritório deixam de ser puxadas; as de saída dos clientes continuam. Nada é apagado.`
      : c.ativo
        ? `Desativar ${nome}? Ele fica fora das capturas até ser reativado. Nada é apagado.`
        : `Reativar ${nome}? Ele volta a entrar nas capturas.`
    if (!window.confirm(pergunta)) return
    executar('ativo', async () => {
      const r = await api.post(`/api/clientes/${c.cnpj}/ativo`, { ativo: !c.ativo })
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
            {visiveis.map((c) => (
                <tr key={c.cnpj} className={!c.ativo ? 'inativo' : undefined}>
                  <td className="nome-cliente">
                    {nomeDe(c)}
                    {c.apelido && <span className="secundario">{c.razaoSocial}</span>}
                    {c.escritorio && <span className="secundario">Escritório</span>}
                    {!c.ativo && <span className="secundario">Desativado</span>}
                  </td>
                  <td className="mono sem-quebra">{formatarCnpj(c.cnpj)}</td>
                  <td className="sem-quebra">
                    <SeloCertificado c={c} />
                  </td>
                  <td>{c.ativo ? <UltimaCaptura c={c} capturandoAgora={capturandoAgora} fila={fila} /> : '—'}</td>
                  <td>
                    <Pendencias notas={c.notas} />
                  </td>
                  <td className="sem-quebra">
                    <Acoes c={c} cadastroLiberado={cadastroLiberado} onAtivo={alternarAtivo} ocupado={!!ocupado} />
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>
    )

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
