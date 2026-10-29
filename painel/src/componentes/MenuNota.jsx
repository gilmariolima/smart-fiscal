import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { podeReprocessar } from './SituacaoNota.jsx'

const LARGURA_MENU = 200
const ALTURA_MENU = 190

// Botão "Ações ▾" da linha da nota. O menu fica em position: fixed para não ser cortado pela
// tabela-moldura (overflow); fecha com Esc, clique fora ou rolagem.
export default function MenuNota({ nota: n, cnpj, limite, onReprocessar, ocupado }) {
  const id = useId()
  const botao = useRef(null)
  const menu = useRef(null)
  const [posicao, setPosicao] = useState(null)

  const fechar = (devolverFoco) => {
    setPosicao(null)
    if (devolverFoco) botao.current?.focus()
  }

  function abrir() {
    if (posicao) return fechar()
    const r = botao.current.getBoundingClientRect()
    const right = Math.max(8, window.innerWidth - r.right)
    setPosicao(r.bottom + ALTURA_MENU < window.innerHeight ? { right, top: r.bottom + 4 } : { right, bottom: window.innerHeight - r.top + 4 })
  }

  useEffect(() => {
    if (!posicao) return undefined
    menu.current?.querySelector('a, button')?.focus()
    const tecla = (e) => e.key === 'Escape' && fechar(true)
    const clique = (e) => !menu.current?.contains(e.target) && !botao.current?.contains(e.target) && fechar()
    const rolar = () => fechar()
    window.addEventListener('keydown', tecla)
    document.addEventListener('mousedown', clique)
    window.addEventListener('scroll', rolar, true)
    window.addEventListener('resize', rolar)
    return () => {
      window.removeEventListener('keydown', tecla)
      document.removeEventListener('mousedown', clique)
      window.removeEventListener('scroll', rolar, true)
      window.removeEventListener('resize', rolar)
    }
  }, [posicao])

  const ver = `/notas/${cnpj}/nota/${n.id}`
  return (
    <>
      <button ref={botao} type="button" className="botao-acoes" aria-haspopup="true" aria-expanded={!!posicao} aria-controls={id} onClick={abrir}>
        Ações <span aria-hidden="true">▾</span>
      </button>
      {posicao && (
        <div id={id} ref={menu} className="menu-nota" style={{ ...posicao, minWidth: LARGURA_MENU }} onClick={() => setTimeout(fechar)}>
          <Link to={ver}>Ver nota</Link>
          {!!n.tem_xml && (
            <>
              {/* Sem evento vem o .xml; com evento, um ZIP com a nota e os eventos (nome dado pelo servidor). */}
              <a href={`/api/notas/${n.id}/xml-eventos`} download>
                Baixar XML
              </a>
              {n.modelo === 'nfse' ? (
                <a href={`/api/notas/${n.id}/pdf`} download={`${n.chave}-nfse.pdf`}>
                  Baixar PDF (DANFSe)
                </a>
              ) : (
                <Link to={`${ver}?imprimir=1`}>Imprimir DANFE</Link>
              )}
            </>
          )}
          {podeReprocessar(n, limite) && (
            <button type="button" onClick={() => onReprocessar(n)} disabled={ocupado}>
              Reprocessar
            </button>
          )}
        </div>
      )}
    </>
  )
}
