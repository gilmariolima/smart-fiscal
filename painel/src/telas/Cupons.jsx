import { useCallback, useEffect, useRef, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import Segmentado from '../componentes/Segmentado.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { cnpj as formatarCnpj, inteiro, NOMES_DOS_MESES, plural } from '../formato.js'

// CF-e (cupom do SAT/MFE) que os clientes emitem: o escritório recebe os XMLs (soltos ou em ZIP),
// importa aqui e confere o mês antes de exportar.

const moeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
const rotuloMes = (c) => {
  const [ano, mes] = c.split('-')
  const nome = NOMES_DOS_MESES[Number(mes) - 1]
  return nome ? `${nome} de ${ano}` : c
}

async function enviarArquivo(arquivo) {
  let r
  try {
    r = await fetch(`/api/cupons/importar?nome=${encodeURIComponent(arquivo.name)}`, {
      method: 'POST', headers: { 'X-Painel': '1', 'Content-Type': 'application/octet-stream' }, body: arquivo,
    })
  } catch {
    throw new Error('Sem conexão com o Smart Fiscal. Ele está aberto?')
  }
  const dados = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(dados.erro || `Falha ao importar ${arquivo.name} (${r.status}).`)
  return dados
}

// Soma os resultados de cada arquivo enviado num só
function somar(a, b) {
  if (!a) return b
  const fora = new Map(a.foraDaCarteira.map((f) => [f.cnpj, { ...f }]))
  for (const f of b.foraDaCarteira) fora.set(f.cnpj, { ...f, cupons: (fora.get(f.cnpj)?.cupons || 0) + f.cupons })
  const porCliente = new Map(a.porCliente.map((c) => [c.cnpj, { ...c }]))
  for (const c of b.porCliente) {
    const atual = porCliente.get(c.cnpj)
    porCliente.set(c.cnpj, atual ? { ...atual, competencias: [...new Set([...atual.competencias, ...c.competencias])] } : c)
  }
  return {
    lidos: a.lidos + b.lidos, importados: a.importados + b.importados, cancelamentos: a.cancelamentos + b.cancelamentos,
    repetidos: a.repetidos + b.repetidos, invalidos: [...a.invalidos, ...b.invalidos],
    foraDaCarteira: [...fora.values()], porCliente: [...porCliente.values()],
  }
}

function Importacao({ r, aoFechar }) {
  return (
    <section className="cartao recibo-cupons" aria-label="Resultado da importação">
      <div className="cartao-tit">
        <h2>Importação</h2>
        <button type="button" className="fechar-x" aria-label="Fechar" onClick={aoFechar}><i className="fa-solid fa-xmark" /></button>
      </div>
      <div className="recibo-corpo">
        <p>
          <strong>{plural(r.importados, 'cupom importado', 'cupons importados')}</strong>
          {r.cancelamentos > 0 && <>, {plural(r.cancelamentos, 'cancelamento', 'cancelamentos')}</>}
          {r.repetidos > 0 && <>, {plural(r.repetidos, 'já estava', 'já estavam')} no Smart Fiscal</>}
          {' '}· {plural(r.lidos, 'XML lido', 'XMLs lidos')}
        </p>
        {r.porCliente.length > 0 && (
          <p className="secundario-linha">
            {r.porCliente.map((c) => `${c.nome}: ${c.competencias.sort().map(rotuloMes).join(', ')}`).join(' · ')}
          </p>
        )}
        {(r.foraDaCarteira.length > 0 || r.invalidos.length > 0) && (
          <div className="avisos-sped">
            {r.foraDaCarteira.map((f) => (
              <p key={f.cnpj}>
                <i className="fa-solid fa-triangle-exclamation" />
                <span>{plural(f.cupons, 'cupom', 'cupons')} de {formatarCnpj(f.cnpj)} ({f.nome}): não é cliente cadastrado, não entrou. Cadastre em Clientes e importe de novo.</span>
              </p>
            ))}
            {r.invalidos.slice(0, 10).map((x, n) => (
              <p key={n}><i className="fa-solid fa-triangle-exclamation" /><span>{x.arquivo}: {x.erro}</span></p>
            ))}
            {r.invalidos.length > 10 && <p><span>e mais {r.invalidos.length - 10} arquivo(s) que não são CF-e</span></p>}
          </div>
        )}
      </div>
    </section>
  )
}

function Kpi({ icone, rotulo, valor, classe = '' }) {
  return (
    <div className={`kpi ${classe}`}>
      <i className={`fa-solid ${icone}`} />
      <div><span>{rotulo}</span><b>{valor}</b></div>
    </div>
  )
}

export default function Cupons() {
  const { dados: dadosClientes } = useApi('/api/clientes')
  const clientes = dadosClientes?.clientes || []
  const [cnpj, setCnpj] = useState('')
  const [competencias, setCompetencias] = useState([])
  const [competencia, setCompetencia] = useState('')
  const [mes, setMes] = useState(null)
  const [vista, setVista] = useState('cupons')
  const [erro, setErro] = useState(null)
  const [importando, setImportando] = useState('')
  const [resultado, setResultado] = useState(null)
  const [arrastando, setArrastando] = useState(false)
  const escolher = useRef(null)

  const carregarCompetencias = useCallback(async (c, preferida) => {
    if (!c) return setCompetencias([])
    try {
      const lista = await api.get(`/api/cupons/competencias?cnpj=${c}`)
      setCompetencias(lista)
      setCompetencia((atual) => (preferida && lista.some((x) => x.competencia === preferida) ? preferida
        : lista.some((x) => x.competencia === atual) ? atual : lista[0]?.competencia || ''))
    } catch (e) {
      setErro(e.message)
    }
  }, [])

  useEffect(() => { carregarCompetencias(cnpj) }, [cnpj, carregarCompetencias])

  const carregarMes = useCallback(async () => {
    if (!cnpj || !competencia) return setMes(null)
    try {
      setMes(await api.get(`/api/cupons?cnpj=${cnpj}&competencia=${competencia}`))
    } catch (e) {
      setErro(e.message)
    }
  }, [cnpj, competencia])
  useEffect(() => { carregarMes() }, [carregarMes])

  const importar = useCallback(async (lista) => {
    const arquivos = [...lista]
    if (!arquivos.length) return
    setErro(null)
    let total = null
    try {
      for (const [n, a] of arquivos.entries()) {
        setImportando(arquivos.length > 1 ? `Importando ${n + 1} de ${arquivos.length}: ${a.name}` : `Importando ${a.name}…`)
        total = somar(total, await enviarArquivo(a))
      }
    } catch (e) {
      setErro(e.message)
    } finally {
      setImportando('')
    }
    if (!total) return
    setResultado(total)
    // Um cliente só no que veio: já mostra o mês mais recente dele
    if (total.porCliente.length === 1) {
      const c = total.porCliente[0]
      const ultima = [...c.competencias].sort().pop()
      if (c.cnpj === cnpj) {
        await carregarCompetencias(c.cnpj, ultima)
        carregarMes()
      } else {
        setCompetencia(ultima)
        setCnpj(c.cnpj)
        carregarCompetencias(c.cnpj, ultima)
      }
    } else if (cnpj) {
      carregarCompetencias(cnpj)
      carregarMes()
    }
  }, [cnpj, carregarCompetencias, carregarMes])

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
      if (e.dataTransfer?.files.length) importar(e.dataTransfer.files)
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
  }, [importar])

  const conf = mes?.conferencia
  const nFaltando = conf ? conf.faltando.reduce((s, f) => s + f.numeros.length, 0) : 0

  return (
    <Pagina
      titulo="Cupons fiscais (CF-e)"
      subtitulo="Cupons do SAT/MFE emitidos pelos clientes: importe os XMLs e confira o mês"
      erro={erro}
      aoFecharErro={() => setErro(null)}
      acoes={<button type="button" className="botao botao-claro" onClick={() => escolher.current.click()}>Importar XMLs</button>}
    >
      <input ref={escolher} type="file" multiple hidden accept=".xml,.zip" onChange={(e) => { importar(e.target.files); e.target.value = '' }} />
      <button type="button" className={`solta${mes ? ' compacta' : ''}${arrastando ? ' arrastando' : ''}`} onClick={() => escolher.current.click()}>
        <i className="fa-solid fa-receipt" />
        <b>Solte aqui os XMLs de CF-e</b>
        <span>XMLs soltos, uma pasta inteira ou um ZIP: cada cupom vai para o cliente do CNPJ emitente</span>
      </button>
      {resultado && <Importacao r={resultado} aoFechar={() => setResultado(null)} />}

      <div className="cartao filtros-cupons">
        <label className="campo">
          <span>Cliente</span>
          <select value={cnpj} onChange={(e) => { setCnpj(e.target.value); setMes(null) }}>
            <option value="">Escolha o cliente</option>
            {clientes.map((c) => <option key={c.cnpj} value={c.cnpj}>{c.apelido || c.razaoSocial} · {formatarCnpj(c.cnpj)}</option>)}
          </select>
        </label>
        <label className="campo">
          <span>Mês</span>
          <select value={competencia} onChange={(e) => setCompetencia(e.target.value)} disabled={!competencias.length}>
            {!competencias.length && <option value="">{cnpj ? 'Nenhum cupom importado' : 'Escolha o cliente'}</option>}
            {competencias.map((c) => <option key={c.competencia} value={c.competencia}>{rotuloMes(c.competencia)} ({inteiro(c.cupons)})</option>)}
          </select>
        </label>
      </div>

      {conf && (
        <>
          <div className="kpis">
            <Kpi icone="fa-receipt" rotulo="Cupons válidos" valor={inteiro(conf.validos)} />
            <Kpi icone="fa-sack-dollar" rotulo="Total vendido" valor={moeda(conf.valor)} />
            <Kpi icone="fa-ban" rotulo="Cancelados" valor={`${inteiro(conf.cancelados)}${conf.cancelados ? ` · ${moeda(conf.valorCancelado)}` : ''}`} classe={conf.cancelados ? 'k-erro' : ''} />
            <Kpi icone={nFaltando ? 'fa-triangle-exclamation' : 'fa-circle-check'} rotulo="Números faltando" valor={inteiro(nFaltando)} classe={nFaltando ? 'k-pend' : 'k-ok'} />
          </div>
          {conf.avisos.length > 0 && (
            <div className="avisos-sped avisos-cupons">
              {conf.avisos.map((a) => <p key={a}><i className="fa-solid fa-triangle-exclamation" /><span>{a}</span></p>)}
            </div>
          )}
          <section className="tabela-moldura">
            <div className="itens-barra">
              <Segmentado rotulo="Ver" valor={vista} onChange={setVista} opcoes={[
                { valor: 'cupons', rotulo: <>Cupons <b className="contagem">{inteiro(mes.cupons.length)}</b></> },
                { valor: 'dias', rotulo: <>Por dia <b className="contagem">{inteiro(conf.porDia.length)}</b></> },
              ]} />
            </div>
            {vista === 'cupons' ? (
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Número</th><th>Equipamento</th><th>Data</th><th className="col-larga">Hora</th>
                    <th className="col-larga">Consumidor</th><th className="num">Valor</th><th>Situação</th><th />
                  </tr>
                </thead>
                <tbody>
                  {mes.cupons.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.numero}</td>
                      <td className="mono">{c.equipamento}{c.caixa && <span className="secundario">caixa {c.caixa}</span>}</td>
                      <td>{dataBr(c.data_emissao)}</td>
                      <td className="col-larga">{(c.data_emissao || '').slice(11, 16)}</td>
                      <td className="col-larga">{c.destinatario_nome || (c.destinatario_doc ? c.destinatario_doc : <span className="secundario">não informado</span>)}</td>
                      <td className="num">{moeda(c.valor_total)}</td>
                      <td>{c.cancelado ? <span className="etiqueta etiqueta-vermelha">Cancelado</span> : <span className="etiqueta etiqueta-verde">Normal</span>}</td>
                      <td>
                        <div className="acoes-linha">
                          <a className="botao-icone" href={`/api/cupons/${c.id}/xml`} title="Baixar o XML do cupom" download><i className="fa-solid fa-file-code" /></a>
                          {c.cancelado && (
                            <a className="botao-icone perigo" href={`/api/cupons/${c.id}/xml?cancelamento=1`} title="Baixar o XML do cancelamento" download><i className="fa-solid fa-file-circle-xmark" /></a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!mes.cupons.length && (
                    <tr><td colSpan={8} className="vazio-lista">Só cancelamentos neste mês: importe os XMLs de venda</td></tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="tabela">
                <thead><tr><th>Dia</th><th className="num">Cupons válidos</th><th className="num">Total vendido</th></tr></thead>
                <tbody>
                  {conf.porDia.map((d) => (
                    <tr key={d.dia}><td>{dataBr(d.dia)}</td><td className="num">{inteiro(d.cupons)}</td><td className="num">{moeda(d.valor)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <p className="rodape-tabela">Os cupons entram no pacote do mês em Exportar (pasta cupons e cupons.csv), junto com as NF-e.</p>
        </>
      )}
      {cnpj && competencias.length === 0 && !importando && (
        <p className="vazio">Nenhum cupom importado deste cliente ainda. Solte os XMLs acima.</p>
      )}
      {importando && (
        <div className="processando" role="status"><div><span className="spin" />{importando}</div></div>
      )}
    </Pagina>
  )
}
