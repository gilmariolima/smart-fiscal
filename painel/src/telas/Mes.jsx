import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import MenuNota from '../componentes/MenuNota.jsx'
import Paginacao from '../componentes/Paginacao.jsx'
import ReciboExportacao from '../componentes/ReciboExportacao.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import SituacaoNota from '../componentes/SituacaoNota.jsx'
import Tabela from '../componentes/Tabela.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { useSelecao } from '../useSelecao.js'
import { NOMES_DOS_MESES, cnpj as formatarCnpj, data, dinheiro, documento, inteiro } from '../formato.js'

const ORDEM_PADRAO = 'emissao-desc'
const LIMITE_ZIP = 2000
const AVISO_LIMITE = 'Selecione até 2.000 notas'

const SITUACOES = [
  ['', 'Todas as situações'],
  ['completa', 'XML completo'],
  ['sem_xml', 'Sem XML'],
  ['resumo', 'Aguardando ciência'],
  ['ciencia_erro', 'Erro na ciência'],
  ['esgotada', 'Esgotada'],
  ['cancelada', 'Cancelada'],
]

export default function Mes() {
  const { cnpj, ano, mes } = useParams()
  const [params, setParams] = useSearchParams()
  const nome = useNomeDoCliente(cnpj)
  const mes2 = String(mes).padStart(2, '0')
  const competencia = `${ano}-${mes2}`
  const nomeDoMes = NOMES_DOS_MESES[Number(mes) - 1] || mes

  const tipo = ['entrada', 'saida'].includes(params.get('tipo')) ? params.get('tipo') : ''
  const status = params.get('status') || ''
  const busca = (params.get('busca') || '').trim()
  const todas = params.get('todas') === '1'
  const ordem = params.get('ordem') || ORDEM_PADRAO
  const pagina = Math.max(1, Number.parseInt(params.get('pagina'), 10) || 1)

  const filtro = new URLSearchParams({ cnpj })
  if (!todas) filtro.set('competencia', competencia)
  if (tipo) filtro.set('tipo', tipo)
  if (status) filtro.set('status', status)
  if (busca) filtro.set('busca', busca)
  const chaveDoFiltro = filtro.toString()
  const consulta = new URLSearchParams(filtro)
  consulta.set('ordem', ordem)
  consulta.set('pagina', pagina)

  const { dados, erro: erroLista, carregando, recarregar } = useApi(`/api/notas?${consulta}`)
  useAoTerminarCaptura(recarregar)
  const selecao = useSelecao(chaveDoFiltro)

  // Ao trocar de página ou ordem, a tabela anterior fica na tela até chegar a nova.
  const anterior = useRef(null)
  if (dados) anterior.current = { chave: chaveDoFiltro, dados }
  const exibido = dados || (anterior.current?.chave === chaveDoFiltro ? anterior.current.dados : null)

  const [termo, setTermo] = useState(busca)
  useEffect(() => setTermo(busca), [busca])
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(null)
  const [recibo, setRecibo] = useState(null)

  useEffect(() => {
    setErro(null)
    setAviso(null)
  }, [chaveDoFiltro])

  // Filtro em vigor agora: respostas que chegam depois de o filtro mudar são descartadas.
  const chaveAtual = useRef(chaveDoFiltro)
  chaveAtual.current = chaveDoFiltro

  function mudar(alteracoes, { manterPagina = false, substituir = false } = {}) {
    setParams(
      (atual) => {
        const p = new URLSearchParams(atual)
        for (const [k, v] of Object.entries(alteracoes)) {
          if (v === '' || v === null || v === undefined || v === false) p.delete(k)
          else p.set(k, v === true ? '1' : String(v))
        }
        if (!manterPagina) p.delete('pagina')
        return p
      },
      { replace: substituir },
    )
  }

  // Página além da última (URL editada à mão ou filtro que encolheu): volta para a última que existe.
  useEffect(() => {
    if (!dados || dados.pagina <= 1) return
    const ultima = Math.max(1, Math.ceil(dados.total / dados.porPagina))
    if (dados.pagina > ultima) mudar({ pagina: ultima > 1 ? ultima : '' }, { manterPagina: true, substituir: true })
  }, [dados])

  // fn recebe vigente(): false se o filtro mudou durante a espera (aí o resultado não vale mais).
  async function executar(nomeAcao, fn) {
    const chave = chaveDoFiltro
    const vigente = () => chaveAtual.current === chave
    setOcupado(nomeAcao)
    setErro(null)
    setAviso(null)
    try {
      await fn(vigente)
    } catch (e) {
      if (vigente()) setErro(e.message)
    } finally {
      setOcupado(null)
    }
  }

  const marcarTodos = () =>
    executar('marcar', async (vigente) => {
      const ids = new URLSearchParams(filtro)
      ids.set('ordem', ordem)
      ids.set('somenteIds', '1')
      const r = await api.get(`/api/notas?${ids}`)
      if (!vigente()) return
      if (r.ids.length > LIMITE_ZIP) setErro(`${AVISO_LIMITE}. Este filtro tem mais de ${inteiro(LIMITE_ZIP)}; use a situação, o tipo ou a busca para reduzir.`)
      else selecao.marcar(r.ids)
    })

  const baixarSelecionados = () => {
    if (selecao.tamanho > LIMITE_ZIP) return setErro(`${AVISO_LIMITE}. Há ${inteiro(selecao.tamanho)} marcadas.`)
    executar('zip', () => api.baixar('/api/notas/zip', { ids: [...selecao.ids] }))
  }

  const exportarMes = () =>
    executar('exportar', async () => {
      const r = await api.post('/api/exportar', { cnpj, competencia })
      setRecibo({ ...r, competencia, cnpj })
    })

  const reprocessar = (n) =>
    executar('reprocessar', async (vigente) => {
      const r = await api.post(`/api/notas/${n.id}/reprocessar`)
      if (vigente()) setAviso(r.mensagem)
      recarregar()
    })

  const limite = exibido?.limiteTentativas
  const colunas = [
    { chave: 'tipo', titulo: 'Tipo', ordem: 'tipo', render: (n) => <span className="tipo-nota">{n.tipo === 'saida' ? 'Saída' : 'Entrada'}</span> },
    { chave: 'numero', titulo: 'Número', ordem: 'numero', classe: 'mono', render: (n) => <Link to={`/notas/${cnpj}/nota/${n.id}`}>{n.numero || '—'}</Link> },
    { chave: 'emissao', titulo: 'Emissão', ordem: 'emissao', classe: 'sem-quebra', render: (n) => data(n.data_emissao) },
    ...(todas
      ? [
          {
            chave: 'mes',
            titulo: 'Mês',
            classe: 'sem-quebra',
            render: (n) => {
              const [a, m] = (n.competencia || '').split('-')
              return a ? <Link to={`/notas/${cnpj}/${a}/${m}`}>{`${m}/${a}`}</Link> : '—'
            },
          },
        ]
      : []),
    { chave: 'emitente_cnpj', titulo: 'CNPJ Emitente', ordem: 'emitente_cnpj', classe: 'mono sem-quebra', render: (n) => formatarCnpj(n.emitente_cnpj) },
    { chave: 'emitente_nome', titulo: 'Nome Emitente', ordem: 'emitente_nome', classe: 'nome', render: (n) => n.emitente_nome || '—' },
    {
      chave: 'destinatario_cnpj',
      titulo: 'CNPJ Destinatário',
      ordem: 'destinatario_cnpj',
      classe: 'mono sem-quebra',
      render: (n) => documento(n.destinatario_cnpj) || '—',
    },
    { chave: 'valor', titulo: 'Valor', ordem: 'valor', classe: 'num sem-quebra', render: (n) => dinheiro(n.valor_total) },
    { chave: 'situacao', titulo: 'Situação', classe: 'sem-quebra', render: (n) => <SituacaoNota nota={n} limite={limite} /> },
    {
      chave: 'acoes',
      titulo: 'Ações',
      classe: 'sem-quebra',
      render: (n) => <MenuNota nota={n} cnpj={cnpj} limite={limite} onReprocessar={reprocessar} ocupado={!!ocupado} />,
    },
  ]

  const contagem = exibido?.contagemTipo || { entradas: 0, saidas: 0 }
  const filtrado = !!(tipo || status || busca)

  let conteudo
  if (!exibido) conteudo = carregando && <p className="vazio">Carregando…</p>
  else if (exibido.total && exibido.pagina > Math.ceil(exibido.total / exibido.porPagina)) conteudo = <p className="vazio">Carregando…</p>
  else if (!exibido.total)
    conteudo = (
      <p className="vazio">
        {todas ? 'Nenhuma nota encontrada para essa busca.' : filtrado ? 'Nenhuma nota com esses filtros.' : 'Nenhuma nota neste mês.'}
      </p>
    )
  else {
    const inicio = (exibido.pagina - 1) * exibido.porPagina + 1
    const fim = Math.min(exibido.pagina * exibido.porPagina, exibido.total)
    conteudo = (
      <>
        <Tabela
          colunas={colunas}
          linhas={exibido.notas}
          ordem={ordem}
          onOrdenar={(o) => mudar({ ordem: o === ORDEM_PADRAO ? '' : o })}
          selecao={selecao}
          rotuloDaLinha={(n) => `Marcar a nota ${n.numero || n.chave}`}
        />
        <div className="rodape-notas">
          <p className="rodape-tabela">
            Mostrando {inteiro(inicio)} até {inteiro(fim)} de {inteiro(exibido.total)}
          </p>
          <Paginacao pagina={exibido.pagina} total={exibido.total} porPagina={exibido.porPagina} onIr={(p) => mudar({ pagina: p }, { manterPagina: true })} />
        </div>
      </>
    )
  }

  const trilha = todas
    ? [
        { rotulo: 'Início', para: '/notas' },
        { rotulo: nome, para: `/notas/${cnpj}` },
        { rotulo: busca ? `Busca: "${busca}"` : 'Todas as pastas' },
      ]
    : [
        { rotulo: 'Início', para: '/notas' },
        { rotulo: nome, para: `/notas/${cnpj}` },
        { rotulo: ano, para: `/notas/${cnpj}/${ano}` },
        { rotulo: nomeDoMes },
      ]

  const acimaDoLimite = selecao.tamanho > LIMITE_ZIP
  const reciboAtual = !todas && recibo && recibo.cnpj === cnpj && recibo.competencia === competencia ? recibo : null

  return (
    <Pagina
      titulo="NF-es"
      subtitulo="Ordene clicando no cabeçalho. Marque as notas e baixe os XMLs num ZIP."
      trilha={trilha}
      erro={erro || erroLista}
      aoFecharErro={erro ? () => setErro(null) : undefined}
      aviso={aviso}
    >
      <div className="barra-notas">
        <Segmentado
          rotulo="Tipo de nota"
          valor={tipo}
          onChange={(v) => mudar({ tipo: v })}
          opcoes={[
            { valor: '', rotulo: `Todas (${inteiro(contagem.entradas + contagem.saidas)})` },
            { valor: 'entrada', rotulo: `Entradas (${inteiro(contagem.entradas)})` },
            { valor: 'saida', rotulo: `Saídas (${inteiro(contagem.saidas)})` },
          ]}
        />
        <div className="filtros-notas">
          <label className="campo-situacao">
            <span>Situação</span>
            <select value={status} onChange={(e) => mudar({ status: e.target.value })}>
              {SITUACOES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <form
            className="busca-notas"
            role="search"
            onSubmit={(e) => {
              e.preventDefault()
              mudar({ busca: termo.trim() })
            }}
          >
            <label className="caixa-todas">
              <input type="checkbox" checked={todas} onChange={(e) => mudar({ todas: e.target.checked })} />
              Buscar em todas as pastas
            </label>
            <span className="busca-campo">
              <input
                type="search"
                aria-label="Buscar notas"
                placeholder="CNPJ, nome ou número da nota"
                value={termo}
                onChange={(e) => setTermo(e.target.value)}
              />
              <button type="submit" className="botao botao-azul">
                Buscar
              </button>
            </span>
          </form>
        </div>
      </div>

      <div className="barra-notas">
        <div className="grupo-botoes">
          <button type="button" className="botao botao-claro" onClick={marcarTodos} disabled={!!ocupado || !exibido?.total}>
            {ocupado === 'marcar' ? 'Marcando…' : 'Marcar todos'}
          </button>
          <button type="button" className="botao botao-claro" onClick={selecao.limpar} disabled={!selecao.tamanho}>
            Desmarcar todos
          </button>
        </div>
        <div className="grupo-botoes">
          <button
            type="button"
            className="botao botao-azul"
            onClick={exportarMes}
            disabled={todas || !!ocupado}
            title={todas ? 'Desmarque "Buscar em todas as pastas" para exportar o mês.' : undefined}
          >
            {ocupado === 'exportar' ? 'Exportando…' : 'Exportar mês (Domínio/Fortes)'}
          </button>
          <button type="button" className="botao botao-verde" onClick={baixarSelecionados} disabled={!selecao.tamanho || !!ocupado}>
            {ocupado === 'zip' ? 'Montando ZIP…' : `⤓ Baixar selecionados (${inteiro(selecao.tamanho)})`}
          </button>
        </div>
      </div>
      {acimaDoLimite && (
        <p className="faixa faixa-ambar" role="status">
          {AVISO_LIMITE}: há {inteiro(selecao.tamanho)} marcadas.
        </p>
      )}
      {reciboAtual && <ReciboExportacao r={reciboAtual} aoFechar={() => setRecibo(null)} />}

      {conteudo}
    </Pagina>
  )
}
