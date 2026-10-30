import { useEffect, useId, useRef, useState } from 'react'

// O que vai no ZIP do "Exportar mês".
export const OPCOES_EXPORTAR = [
  { incluir: ['xml', 'excel', 'pdf'], rotulo: 'Pacote completo (XMLs, planilha e relatório)' },
  { incluir: ['xml'], rotulo: 'Arquivos XML' },
  { incluir: ['excel'], rotulo: 'Planilha (Excel)' },
  { incluir: ['pdf'], rotulo: 'Relatório (PDF)' },
]

// Botão "Exportar mês ▾": o menu fica em position: fixed, como o "Ações" das notas; fecha com Esc ou clique fora.
export default function MenuExportar({ onEscolher, ocupado, exportando, titulo }) {
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
    setPosicao({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 })
  }

  useEffect(() => {
    if (!posicao) return undefined
    menu.current?.querySelector('button')?.focus()
    const tecla = (e) => e.key === 'Escape' && fechar(true)
    const clique = (e) => !menu.current?.contains(e.target) && !botao.current?.contains(e.target) && fechar()
    window.addEventListener('keydown', tecla)
    document.addEventListener('mousedown', clique)
    window.addEventListener('scroll', fechar, true)
    window.addEventListener('resize', fechar)
    return () => {
      window.removeEventListener('keydown', tecla)
      document.removeEventListener('mousedown', clique)
      window.removeEventListener('scroll', fechar, true)
      window.removeEventListener('resize', fechar)
    }
  }, [posicao])

  return (
    <>
      <button
        ref={botao}
        type="button"
        className="botao botao-azul"
        aria-haspopup="true"
        aria-expanded={!!posicao}
        aria-controls={id}
        onClick={abrir}
        disabled={ocupado}
        title={titulo}
      >
        {exportando ? 'Exportando…' : 'Exportar mês'} <span aria-hidden="true">▾</span>
      </button>
      {posicao && (
        <div id={id} ref={menu} className="menu-nota" style={posicao}>
          {OPCOES_EXPORTAR.map((o) => (
            <button
              key={o.rotulo}
              type="button"
              onClick={() => {
                fechar()
                onEscolher(o.incluir)
              }}
            >
              {o.rotulo}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
