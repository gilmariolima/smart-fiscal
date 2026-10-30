import { useEffect, useId, useRef, useState } from 'react'

// O que o "Baixar selecionados" pode baixar das notas marcadas. Planilha e relatório saem soltos; o resto, em ZIP.
// O PDF de cada nota é o DANFE na NF-e e o DANFSe na NFS-e.
export function opcoesDeBaixar(modelo) {
  const pdfNota = modelo === 'nfse' ? { incluir: ['danfse'], rotulo: 'DANFSe' } : { incluir: ['danfe'], rotulo: 'DANFE' }
  return [
    { incluir: ['xml', ...pdfNota.incluir, 'excel', 'pdf'], rotulo: `Pacote completo (XMLs, ${pdfNota.rotulo}, planilha e PDF)` },
    { incluir: pdfNota.incluir, rotulo: `Arquivos ${pdfNota.rotulo}` },
    { incluir: ['xml'], rotulo: 'Arquivos XML' },
    { incluir: ['excel'], rotulo: 'Relatório em planilha (Excel)' },
    { incluir: ['pdf'], rotulo: 'Relatório em PDF' },
  ]
}

// Botão com menu ▾: o menu fica em position: fixed, como o "Ações" das notas; fecha com Esc ou clique fora.
export default function MenuBaixar({ rotulo, opcoes, onEscolher, desativado, className = 'botao botao-verde' }) {
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
      <button ref={botao} type="button" className={className} aria-haspopup="true" aria-expanded={!!posicao} aria-controls={id} onClick={abrir} disabled={desativado}>
        {rotulo} <span aria-hidden="true">▾</span>
      </button>
      {posicao && (
        <div id={id} ref={menu} className="menu-nota" style={posicao}>
          {opcoes.map((o) => (
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
