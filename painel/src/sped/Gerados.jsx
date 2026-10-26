import { useCallback, useEffect, useRef, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import { baixar, milhar, sped } from './api.js'
import Modal from './Modal.jsx'
import { useSped } from './SpedProvider.jsx'

// Só o nome do arquivo: na lista ele vem com a pasta da empresa e do mês (CNPJ_Empresa/AAAA-MM/...).
const nomeDe = (arquivo) => arquivo.split('/').pop()

function Pasta({ aoMudar }) {
  const { aviso } = useSped()
  const [pasta, setPasta] = useState(null)
  const [texto, setTexto] = useState('')
  const [trocando, setTrocando] = useState(false)
  const carregar = useCallback(() => sped('/api/pasta').then((p) => {
    if (p.erro) return
    setPasta(p)
    setTexto(p.pasta_saida)
  }), [])
  useEffect(() => { carregar() }, [carregar])

  async function salvar(valor) {
    const r = await sped('/api/pasta', { method: 'POST', json: { pasta_saida: valor } })
    if (r.erro) return aviso(r.erro, 'erro')
    aviso(r.eh_padrao ? 'Voltou para a pasta padrão' : 'Pasta dos arquivos gerados salva')
    setPasta(r)
    setTexto(r.pasta_saida)
    setTrocando(false)
    aoMudar()
  }

  if (!pasta) return null
  const nota = !pasta.acessivel
    ? 'A pasta não está acessível agora (rede desligada ou pasta apagada): os arquivos não aparecem e o SPED não pode ser gerado até ela voltar.'
    : trocando && !pasta.eh_padrao ? 'Os próximos arquivos vão para a pasta nova. Os gerados antes continuam na pasta anterior.' : ''
  return (
    <form className="cartao pasta-saida" autoComplete="off" onSubmit={(e) => { e.preventDefault(); salvar(texto) }}>
      {trocando ? (
        <>
          <label htmlFor="pastaSaida" className="rot">Nova pasta para os arquivos gerados</label>
          <div className="pasta-linha">
            <div className="campo-busca pasta-campo">
              <i className="fa-solid fa-folder" />
              <input id="pastaSaida" className="entrada" spellCheck={false} placeholder="C:\Fiscal\SPED ou \\servidor\fiscal\SPED"
                value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus />
            </div>
            <button type="submit" className="botao botao-azul">Salvar</button>
            {!pasta.eh_padrao && <button type="button" className="botao botao-claro" onClick={() => salvar('')}>Usar a pasta padrão</button>}
            <button type="button" className="botao botao-claro" onClick={() => { setTexto(pasta.pasta_saida); setTrocando(false) }}>Cancelar</button>
          </div>
        </>
      ) : (
        <div className="pasta-linha">
          <p className="pasta-atual">
            <i className="fa-solid fa-folder" /> Cada empresa tem a sua pasta, separada por mês do inventário, em{' '}
            <span className="mono" title={pasta.pasta_saida}>{pasta.pasta_saida}</span>
          </p>
          <button type="button" className="botao botao-claro" onClick={() => setTrocando(true)}>Trocar pasta</button>
        </div>
      )}
      {nota && <p className={`pasta-nota${pasta.acessivel ? '' : ' pasta-erro'}`}>{nota}</p>}
    </form>
  )
}

function MenuArquivo({ g, ancora, aoVer, aoExcluir, aoFechar }) {
  const caixa = useRef(null)
  const [pos, setPos] = useState({ top: -9999, left: -9999 })
  useEffect(() => {
    const p = ancora.getBoundingClientRect()
    const largura = caixa.current?.offsetWidth || 220
    setPos({ top: p.bottom + 6, left: Math.max(12, p.right - largura) })
    const fora = (e) => !caixa.current?.contains(e.target) && !ancora.contains(e.target) && aoFechar()
    const tecla = (e) => e.key === 'Escape' && aoFechar()
    document.addEventListener('mousedown', fora)
    window.addEventListener('keydown', tecla)
    window.addEventListener('scroll', aoFechar, true)
    return () => {
      document.removeEventListener('mousedown', fora)
      window.removeEventListener('keydown', tecla)
      window.removeEventListener('scroll', aoFechar, true)
    }
  }, [ancora, aoFechar])
  return (
    <div ref={caixa} className="menu-nota" style={pos} role="menu">
      <button type="button" role="menuitem" onClick={aoVer}><i className="fa-solid fa-eye" /> Ver arquivo</button>
      {g.dominio && <a role="menuitem" href={baixar(g.dominio)} onClick={aoFechar}><i className="fa-solid fa-file-export" /> Baixar para o Domínio</a>}
      {g.pendencias && <a role="menuitem" href={baixar(g.pendencias)} onClick={aoFechar}><i className="fa-solid fa-file-csv" /> Baixar pendências</a>}
      <button type="button" role="menuitem" className="perigo" onClick={aoExcluir}><i className="fa-solid fa-trash" /> Excluir</button>
    </div>
  )
}

function VerArquivo({ nome, aoFechar }) {
  const { aviso } = useSped()
  const [linhas, setLinhas] = useState([])
  const [total, setTotal] = useState(0)
  const carregar = useCallback(async (de) => {
    const r = await sped(`/api/ver/${encodeURIComponent(nome)}?de=${de}`)
    if (r.erro) return aviso(r.erro, 'erro')
    setLinhas((l) => (de === 0 ? r.linhas : [...l, ...r.linhas]))
    setTotal(r.total)
  }, [nome, aviso])
  useEffect(() => { carregar(0) }, [carregar])
  const resto = total - linhas.length
  return (
    <Modal titulo={nomeDe(nome)} aoFechar={aoFechar} classe="modal-ver">
      <div className="ver-txt">
        {linhas.map((l, n) => <div key={n}><span>{n + 1}</span>{l}</div>)}
      </div>
      {resto > 0 && <button type="button" className="mais" onClick={() => carregar(linhas.length)}>Mostrar mais linhas (faltam {milhar(resto)})</button>}
    </Modal>
  )
}

export default function Gerados() {
  const { aviso } = useSped()
  const [gerados, setGerados] = useState(null)
  const [menu, setMenu] = useState(null)
  const [ver, setVer] = useState(null)
  const [erro, setErro] = useState('')
  const carregar = useCallback(async () => {
    const r = await sped('/api/gerados')
    if (r.erro) return setErro(r.erro)
    setErro('')
    setGerados(r)
  }, [])
  useEffect(() => { carregar() }, [carregar])

  async function abrirPasta() {
    const r = await sped('/api/abrir-pasta', { method: 'POST' })
    if (r.erro) aviso(r.erro, 'erro')
  }
  async function excluir(g) {
    setMenu(null)
    if (!window.confirm(`Excluir ${nomeDe(g.arquivo)}?`)) return
    const r = await sped(`/api/gerado/${encodeURIComponent(g.arquivo)}`, { method: 'DELETE' })
    if (r.erro) return aviso(r.erro, 'erro')
    aviso('Arquivo excluído')
    carregar()
  }

  const n = gerados?.length || 0
  return (
    <Pagina
      titulo="Arquivos gerados"
      subtitulo={gerados ? (n ? `${n} ${n > 1 ? 'arquivos' : 'arquivo'} na pasta` : 'Nenhum arquivo gerado') : ''}
      erro={erro}
      acoes={<button type="button" className="botao botao-claro" onClick={abrirPasta}><i className="fa-solid fa-folder-open" />Abrir pasta</button>}
    >
      <Pasta aoMudar={carregar} />
      <div className="tabela-moldura">
        <table className="tabela">
          <thead>
            <tr>
              <th>Inventário</th><th>Empresa</th><th className="col-larga">CNPJ</th><th className="num">Itens</th><th className="num">Total</th>
              <th className="col-larga">Gerado em</th><th />
            </tr>
          </thead>
          <tbody>
            {n ? gerados.map((g) => (
              <tr key={g.arquivo}>
                <td>
                  {g.inventario || '—'}
                  <span className="secundario" title={g.arquivo}>{nomeDe(g.arquivo).replace(/^SPED_/, '').replace(/\.txt$/, '')}</span>
                </td>
                <td>{g.nome}</td>
                <td className="col-larga mono">{g.cnpj}</td>
                <td className="num">{milhar(g.itens)}</td>
                <td className="num">{milhar(g.total)}</td>
                <td className="col-larga">{g.data}</td>
                <td>
                  <div className="acoes-linha">
                    <a className="botao botao-verde botao-pequeno" href={baixar(g.arquivo)}>Baixar</a>
                    <button type="button" className="botao-icone" title="Mais" aria-haspopup="menu"
                      onClick={(e) => { const a = e.currentTarget; setMenu((m) => (m?.g === g ? null : { g, ancora: a })) }}>
                      <i className="fa-solid fa-ellipsis" />
                    </button>
                  </div>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="vazio-lista"><i className="fa-solid fa-box-open" /><br />Os arquivos gerados aparecem aqui</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {menu && (
        <MenuArquivo g={menu.g} ancora={menu.ancora} aoFechar={() => setMenu(null)}
          aoVer={() => { setVer(menu.g.arquivo); setMenu(null) }} aoExcluir={() => excluir(menu.g)} />
      )}
      {ver && <VerArquivo nome={ver} aoFechar={() => setVer(null)} />}
    </Pagina>
  )
}
