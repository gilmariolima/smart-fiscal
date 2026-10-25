import { useEffect, useMemo, useRef, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import { baixar, milhar, TIPOS_ITEM } from './api.js'
import EditorItem from './EditorItem.jsx'
import { useSped } from './SpedProvider.jsx'

const POR_PAGINA = 300
const ACEITOS = '.txt,.fs,.FS,.xls,.xlsx,.xlsm,.csv'

function Campo({ nome, rotulo, dica, larga, children, ...props }) {
  const { campos, faltando, digitar } = useSped()
  return (
    <label className={larga ? 'larga' : undefined}>
      <span className="rot" title={dica}>{rotulo}</span>
      {children ? (
        <select className={`entrada${faltando.has(nome) ? ' falta' : ''}`} name={nome} value={campos[nome]} onChange={(e) => digitar(nome, e.target.value)}>
          {children}
        </select>
      ) : (
        <input className={`entrada${faltando.has(nome) ? ' falta' : ''}`} name={nome} value={campos[nome]} onChange={(e) => digitar(nome, e.target.value)} {...props} />
      )}
    </label>
  )
}

function Arquivos() {
  const { arquivos, principal, res, tirar, usarComoInventario } = useSped()
  const porNome = Object.fromEntries((res?.arquivos || []).map((i) => [i.nome, i]))
  return (
    <div className="tabela-moldura sped-arquivos">
      <table className="tabela">
        <thead>
          <tr>
            <th>Nº</th><th>Arquivo</th><th className="col-larga">Tipo</th><th className="num">Itens</th><th>Uso</th><th />
          </tr>
        </thead>
        <tbody>
          {arquivos.map((nome, n) => {
            const i = porNome[nome] || { nome }
            const ehPrincipal = nome === principal
            return (
              <tr key={nome}>
                <td className="num-linha">{String(n + 1).padStart(2, '0')}</td>
                <td><strong className="nome-arq">{nome}</strong></td>
                <td className="col-larga">
                  {i.tipo}
                  {i.valores === false && <span className="secundario">sem valores</span>}
                </td>
                <td className="num">{i.itens != null ? milhar(i.itens) : ''}</td>
                <td>
                  {i.erro ? (
                    <span className="etiqueta etiqueta-vermelha" title={i.erro}>Não lido</span>
                  ) : ehPrincipal ? (
                    <span className="etiqueta etiqueta-verde">Inventário</span>
                  ) : (
                    <span className="etiqueta etiqueta-azul" title="Completa descrição, NCM, tipo e custo dos itens do inventário">Complemento</span>
                  )}
                </td>
                <td>
                  <div className="acoes-linha">
                    {!i.erro && !ehPrincipal && (
                      <button type="button" className="botao-icone" title="Usar este arquivo como inventário" onClick={() => usarComoInventario(nome)}>
                        <i className="fa-solid fa-star" />
                      </button>
                    )}
                    <button type="button" className="botao-icone perigo" title="Tirar arquivo" onClick={() => tirar(nome)}>
                      <i className="fa-solid fa-xmark" />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Kpi({ icone, rotulo, valor, classe = '' }) {
  return (
    <div className={`kpi ${classe}`}>
      <i className={`fa-solid ${icone}`} />
      <div>
        <span>{rotulo}</span>
        <b>{valor}</b>
      </div>
    </div>
  )
}

function DadosEmpresa() {
  const { focar, limparFoco, converter } = useSped()
  const form = useRef(null)
  useEffect(() => {
    if (!focar) return
    form.current?.elements[focar]?.focus()
    limparFoco()
  }, [focar, limparFoco])
  return (
    <section className="cartao">
      <div className="cartao-tit">
        <h2>Dados da empresa</h2>
        <span className="secundario">Registros 0000, 0005 e 0150</span>
      </div>
      <form ref={form} className="form-sped" autoComplete="off" onSubmit={(e) => { e.preventDefault(); converter() }}>
        <fieldset className="grupo">
          <legend>Identificação</legend>
          <Campo nome="nome" rotulo="Nome empresarial" larga />
          <Campo nome="cnpj" rotulo="CNPJ" spellCheck={false} />
          <Campo nome="ie" rotulo="Inscrição estadual" />
          <Campo nome="uf" rotulo="UF" maxLength={2} />
          <Campo nome="cod_mun" rotulo="Município (IBGE)" dica="Código IBGE do município, 7 dígitos" inputMode="numeric" maxLength={7} />
        </fieldset>
        <fieldset className="grupo">
          <legend>Escrituração</legend>
          <Campo nome="data_inv" rotulo="Data do inventário" placeholder="31/12/2025" />
          <Campo nome="periodo" rotulo="Período (mês)" placeholder="automático"
            dica="Mês da EFD. Pelo Guia Prático, o inventário vai na EFD do segundo mês depois dele: o de 31/12 vai na de fevereiro." />
          <Campo nome="perfil" rotulo="Perfil"><option>A</option><option>B</option><option>C</option></Campo>
          <Campo nome="ind_ativ" rotulo="Atividade"><option value="1">Outros</option><option value="0">Industrial</option></Campo>
        </fieldset>
        <fieldset className="grupo">
          <legend>Endereço do estabelecimento</legend>
          <Campo nome="cep" rotulo="CEP" dica="CEP do estabelecimento (registro 0005)" inputMode="numeric" maxLength={9} />
          <Campo nome="end" rotulo="Endereço" dica="Logradouro do estabelecimento (registro 0005)" larga />
          <Campo nome="num" rotulo="Número" maxLength={10} />
          <Campo nome="compl" rotulo="Complemento" />
          <Campo nome="bairro" rotulo="Bairro" />
        </fieldset>
        <fieldset className="grupo">
          <legend>Itens</legend>
          <Campo nome="tipo_item" rotulo="Tipo do item (padrão)" dica="Usado quando o arquivo não informa o tipo do item" larga>
            {TIPOS_ITEM.map(([v, n]) => <option key={v} value={v}>{v} · {n}</option>)}
          </Campo>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </section>
  )
}

function Resumo() {
  const { res, converter, aviso } = useSped()
  const r = res?.erro ? null : res
  const linhas = []
  if (r) {
    linhas.push(['Total do inventário', milhar(r.resumo.total)])
    if (r.resumo.origem && r.resumo.origem !== r.resumo.total) linhas.push(['Total no arquivo do cliente', milhar(r.resumo.origem)])
    linhas.push(['Período', r.resumo.periodo], ['Leiaute', r.resumo.leiaute], ['Linhas do arquivo', milhar(r.resumo.linhas)])
    if (r.resumo.conteudo) linhas.push(['Conteúdo', r.resumo.conteudo])
  }
  const avisos = r ? r.gerais.map((g) => g.msg) : []
  if (r?.fora.length) avisos.push(`${r.fora.length} ${r.fora.length > 1 ? 'itens' : 'item'} fora do arquivo`)
  return (
    <aside className="cartao resumo-sped">
      <div className="cartao-tit"><h2>Resumo</h2></div>
      <div className="resumo-corpo">
        <div className="linhas">
          {linhas.map(([a, b]) => <p key={a}><span>{a}</span><span>{b}</span></p>)}
        </div>
        {avisos.length > 0 && (
          <div className="avisos-sped">
            {avisos.map((m, n) => <p key={n}><i className="fa-solid fa-triangle-exclamation" /><span>{m}</span></p>)}
          </div>
        )}
        <div className="resumo-pe">
          <button type="button" className="botao botao-azul" onClick={() => converter().then((x) => x && !x.erro && aviso('SPED gerado de novo'))}>Gerar de novo</button>
          {r?.pendencias && <a className="botao botao-claro" href={baixar(r.pendencias)}>Pendências (CSV)</a>}
        </div>
      </div>
    </aside>
  )
}

function Itens({ aoAbrir }) {
  const { res } = useSped()
  const [filtro, setFiltro] = useState('todos')
  const [busca, setBusca] = useState('')
  const [limite, setLimite] = useState(POR_PAGINA)
  const r = res && !res.erro ? res : { itens: [], fora: [] }
  const nPend = r.itens.filter((i) => i.p.length).length
  const filtroAtivo = filtro === 'fora' && !r.fora.length ? 'todos' : filtro
  const lista = useMemo(() => {
    const b = busca.trim().toUpperCase()
    // "Fora do arquivo": os itens do inventário que não entraram no SPED, com o motivo
    const fonte = filtroAtivo === 'fora' ? r.fora : r.itens
    return fonte.filter((i) => (filtroAtivo !== 'pend' || i.p.length) && (!b || i.c.toUpperCase().includes(b) || (i.d || '').toUpperCase().includes(b)))
  }, [r, filtroAtivo, busca])
  const mostra = lista.slice(0, limite)
  const resto = lista.length - mostra.length
  const opcoes = [
    { valor: 'todos', rotulo: <>Todos <b className="contagem">{milhar(r.itens.length)}</b></> },
    { valor: 'pend', rotulo: <>Com pendência <b className="contagem">{milhar(nPend)}</b></> },
    ...(r.fora.length ? [{ valor: 'fora', rotulo: <>Fora do arquivo <b className="contagem">{milhar(r.fora.length)}</b></> }] : []),
  ]
  const fora = filtroAtivo === 'fora'
  const selo = (i) => (fora ? <span className="etiqueta etiqueta-vermelha" title={i.p.join('\n')}>Fora</span>
    : i.p.length ? <span className="etiqueta etiqueta-ambar" title={i.p.join('\n')}>Pendência</span>
      : i.a.length ? <span className="etiqueta etiqueta-azul" title="Corrigido no painel">Corrigido</span>
        : <span className="etiqueta etiqueta-verde">OK</span>)
  return (
    <section className="tabela-moldura itens-sped">
      <div className="itens-barra">
        <Segmentado rotulo="Filtrar itens" opcoes={opcoes} valor={filtroAtivo} onChange={(v) => { setFiltro(v); setLimite(POR_PAGINA) }} />
        <div className="campo-busca">
          <i className="fa-solid fa-magnifying-glass" />
          <input className="entrada" type="search" placeholder="Código ou descrição" aria-label="Buscar itens" value={busca}
            onChange={(e) => { setBusca(e.target.value); setLimite(POR_PAGINA) }} />
        </div>
      </div>
      <table className="tabela">
        <thead>
          <tr>
            <th>Código</th><th>Descrição</th><th className="col-larga">NCM</th><th className="col-larga">Un.</th>
            <th className="num">Quantidade</th><th className="num col-larga">Unitário</th><th className="num">Total</th><th /><th />
          </tr>
        </thead>
        <tbody>
          {mostra.length ? mostra.map((i) => (
            <tr key={i.k + (fora ? 'f' : '')} className="editavel" title="Clique para corrigir" onClick={() => !window.getSelection().toString() && aoAbrir(i)}>
              <td><span className="codigo">{i.c}</span></td>
              <td className="d-col">
                {i.d}
                {/* Nos filtros de pendência e de fora, o motivo fica escrito embaixo da descrição */}
                {filtroAtivo !== 'todos' && i.p.map((m) => <span key={m} className="motivo">{m}</span>)}
              </td>
              <td className="col-larga">{i.n}</td>
              <td className="col-larga">{i.u}</td>
              <td className="num">{milhar(i.q)}</td>
              <td className="num col-larga">{milhar(i.vu)}</td>
              <td className="num">{milhar(i.vt)}</td>
              <td className="col-selo">{selo(i)}</td>
              <td className="col-editar"><button className="botao-icone" type="button" tabIndex={-1} aria-label="Corrigir"><i className="fa-solid fa-pen" /></button></td>
            </tr>
          )) : (
            <tr><td colSpan={9} className="vazio-lista"><i className="fa-solid fa-magnifying-glass" /><br />Nenhum item</td></tr>
          )}
        </tbody>
      </table>
      {resto > 0 && (
        <button type="button" className="mais" onClick={() => setLimite((l) => l + POR_PAGINA)}>
          Mostrar mais {milhar(Math.min(resto, POR_PAGINA))} de {milhar(resto)}
        </button>
      )}
    </section>
  )
}

export default function Converter() {
  const { arquivos, res, enviar, novoCliente } = useSped()
  const escolher = useRef(null)
  const [arrastando, setArrastando] = useState(false)
  const [item, setItem] = useState(null)

  // Arquivos soltos em qualquer lugar da tela
  useEffect(() => {
    let n = 0
    const entrar = (e) => { if (e.dataTransfer?.types.includes('Files')) { n++; setArrastando(true) } }
    const sair = () => { if (--n <= 0) { n = 0; setArrastando(false) } }
    const sobre = (e) => e.preventDefault()
    const soltar = (e) => {
      e.preventDefault()
      n = 0
      setArrastando(false)
      if (e.dataTransfer?.files.length) enviar(e.dataTransfer.files)
    }
    document.addEventListener('dragenter', entrar)
    document.addEventListener('dragleave', sair)
    document.addEventListener('dragover', sobre)
    document.addEventListener('drop', soltar)
    return () => {
      document.removeEventListener('dragenter', entrar)
      document.removeEventListener('dragleave', sair)
      document.removeEventListener('dragover', sobre)
      document.removeEventListener('drop', soltar)
    }
  }, [enviar])

  const ok = res && !res.erro
  const n = arquivos.length
  const subtitulo = !n ? 'Nenhum arquivo' : `${n} ${n > 1 ? 'arquivos' : 'arquivo'}` + (ok && res.campos?.data_inv ? ` · inventário em ${res.campos.data_inv}` : '')
  const nPend = ok ? res.itens.filter((i) => i.p.length).length : 0
  const mostrarResultado = ok || (res?.erro && res.campos)

  return (
    <Pagina
      titulo="Converter inventário"
      subtitulo={subtitulo}
      erro={res?.erro}
      acoes={(
        <>
          {n > 0 && <button type="button" className="botao botao-claro" onClick={novoCliente}>Novo cliente</button>}
          <button type="button" className="botao botao-claro" onClick={() => escolher.current.click()}>Adicionar arquivos</button>
          {ok && res.dominio && (
            <a className="botao botao-claro" href={baixar(res.dominio)} title="produtos.txt no leiaute da Planilha Modelo, para importar o inventário no Domínio">Baixar para o Domínio</a>
          )}
          {ok && <a className="botao botao-verde" href={baixar(res.arquivo)}><i className="fa-solid fa-download" />Baixar SPED</a>}
        </>
      )}
    >
      <input ref={escolher} type="file" multiple hidden accept={ACEITOS} onChange={(e) => { enviar(e.target.files); e.target.value = '' }} />
      <button type="button" className={`solta${n ? ' compacta' : ''}${arrastando ? ' arrastando' : ''}`} onClick={() => escolher.current.click()}>
        <i className="fa-solid fa-cloud-arrow-up" />
        <b>Solte aqui os arquivos do cliente</b>
        <span>Relatório de inventário, .FS da Fortes, bloco H ou planilha</span>
      </button>
      {n > 0 && <Arquivos />}
      {mostrarResultado && (
        <>
          {ok && (
            <div className="kpis">
              <Kpi icone="fa-boxes-stacked" rotulo="Itens no SPED" valor={milhar(res.itens.length)} />
              <Kpi icone="fa-sack-dollar" rotulo="Valor do estoque" valor={`R$ ${milhar(res.resumo.total)}`} />
              <Kpi icone={nPend ? 'fa-triangle-exclamation' : 'fa-circle-check'} rotulo="Com pendência" valor={milhar(nPend)} classe={nPend ? 'k-pend' : 'k-ok'} />
              <Kpi icone="fa-ban" rotulo="Fora do arquivo" valor={milhar(res.fora.length)} classe={res.fora.length ? 'k-erro' : ''} />
            </div>
          )}
          <div className="duas-sped">
            <DadosEmpresa />
            <Resumo />
          </div>
          <Itens aoAbrir={setItem} />
        </>
      )}
      {item && <EditorItem item={item} aoFechar={() => setItem(null)} />}
    </Pagina>
  )
}
