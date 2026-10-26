import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import MenuNota from '../componentes/MenuNota.jsx'
import Paginacao from '../componentes/Paginacao.jsx'
import SituacaoNota from '../componentes/SituacaoNota.jsx'
import Tabela from '../componentes/Tabela.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura, useResumo } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { cnpj as formatarCnpj, data, dinheiro, inteiro } from '../formato.js'

const ORDEM_PADRAO = 'emissao-desc'

const SITUACOES = [
  ['sem_xml', 'Todas sem XML'],
  ['resumo', 'Aguardando ciência do cliente'],
  ['aguardando_xml', 'Aguardando XML'],
  ['esgotada', 'Esgotada'],
  ['ciencia_erro', 'Erro na ciência'],
]

// Notas sem XML completo de todos os clientes (canceladas ficam de fora: a SEFAZ não entrega o XML delas).
export default function Pendentes() {
  const [params, setParams] = useSearchParams()
  const { recarregar: recarregarResumo } = useResumo()
  const status = SITUACOES.some(([v]) => v === params.get('status')) ? params.get('status') : 'sem_xml'
  const ordem = params.get('ordem') || ORDEM_PADRAO
  const pagina = Math.max(1, Number.parseInt(params.get('pagina'), 10) || 1)

  const consulta = new URLSearchParams({ status, ordem, pagina })
  const { dados, erro: erroLista, carregando, recarregar } = useApi(`/api/notas?${consulta}`)
  useAoTerminarCaptura(recarregar)

  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  useEffect(() => {
    setErro(null)
    setAviso(null)
  }, [status])

  function mudar(alteracoes) {
    setParams((atual) => {
      const p = new URLSearchParams(atual)
      for (const [k, v] of Object.entries(alteracoes)) {
        if (!v) p.delete(k)
        else p.set(k, String(v))
      }
      if (!('pagina' in alteracoes)) p.delete('pagina')
      return p
    })
  }

  async function reprocessar(n) {
    setOcupado(true)
    setErro(null)
    setAviso(null)
    try {
      setAviso((await api.post(`/api/notas/${n.id}/reprocessar`)).mensagem)
      recarregar()
      recarregarResumo()
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(false)
    }
  }

  const limite = dados?.limiteTentativas
  const colunas = [
    {
      chave: 'cliente',
      titulo: 'Cliente',
      classe: 'nome',
      render: (n) => <Link to={`/notas/${n.cliente_cnpj}`}>{n.cliente_nome}</Link>,
    },
    { chave: 'numero', titulo: 'Número', ordem: 'numero', classe: 'mono', render: (n) => <Link to={`/notas/${n.cliente_cnpj}/nota/${n.id}`}>{n.numero || '—'}</Link> },
    { chave: 'emissao', titulo: 'Emissão', ordem: 'emissao', classe: 'sem-quebra', render: (n) => data(n.data_emissao) },
    { chave: 'emitente_cnpj', titulo: 'CNPJ Emitente', ordem: 'emitente_cnpj', classe: 'mono sem-quebra', render: (n) => formatarCnpj(n.emitente_cnpj) },
    { chave: 'emitente_nome', titulo: 'Nome Emitente', ordem: 'emitente_nome', classe: 'nome', render: (n) => n.emitente_nome || '—' },
    { chave: 'valor', titulo: 'Valor', ordem: 'valor', classe: 'num sem-quebra', render: (n) => dinheiro(n.valor_total) },
    { chave: 'situacao', titulo: 'Situação', classe: 'sem-quebra', render: (n) => <SituacaoNota nota={n} limite={limite} /> },
    {
      chave: 'acoes',
      titulo: 'Ações',
      classe: 'sem-quebra',
      render: (n) => <MenuNota nota={n} cnpj={n.cliente_cnpj} limite={limite} onReprocessar={reprocessar} ocupado={ocupado} />,
    },
  ]

  let conteudo
  if (!dados) conteudo = carregando && <p className="vazio">Carregando…</p>
  else if (!dados.total)
    conteudo = <p className="vazio">{status === 'sem_xml' ? 'Nenhuma nota sem XML. Todas as notas estão completas.' : 'Nenhuma nota nessa situação.'}</p>
  else {
    const inicio = (dados.pagina - 1) * dados.porPagina + 1
    const fim = Math.min(dados.pagina * dados.porPagina, dados.total)
    conteudo = (
      <>
        <Tabela colunas={colunas} linhas={dados.notas} ordem={ordem} onOrdenar={(o) => mudar({ ordem: o === ORDEM_PADRAO ? '' : o })} />
        <div className="rodape-notas">
          <p className="rodape-tabela">
            Mostrando {inteiro(inicio)} até {inteiro(fim)} de {inteiro(dados.total)}
          </p>
          <Paginacao pagina={dados.pagina} total={dados.total} porPagina={dados.porPagina} onIr={(p) => mudar({ pagina: p > 1 ? p : '' })} />
        </div>
      </>
    )
  }

  return (
    <Pagina
      titulo="XMLs não baixados"
      subtitulo="Notas de todos os clientes que ainda não têm o XML completo. Canceladas ficam de fora."
      erro={erro || erroLista}
      aoFecharErro={erro ? () => setErro(null) : undefined}
      aviso={aviso}
    >
      <div className="barra-notas">
        <label className="campo-situacao">
          <span>Situação</span>
          <select value={status} onChange={(e) => mudar({ status: e.target.value === 'sem_xml' ? '' : e.target.value })}>
            {SITUACOES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {conteudo}
    </Pagina>
  )
}
