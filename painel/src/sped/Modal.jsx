import { useEffect } from 'react'

// Janela por cima da tela: fecha no X, no Esc ou clicando fora.
export default function Modal({ titulo, aoFechar, classe = '', children }) {
  useEffect(() => {
    const tecla = (e) => e.key === 'Escape' && aoFechar()
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [aoFechar])
  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <div className={`modal-caixa ${classe}`} role="dialog" aria-modal="true">
        <div className="modal-tit">
          <span>{titulo}</span>
          <button type="button" className="fechar-x" aria-label="Fechar" onClick={aoFechar}><i className="fa-solid fa-xmark" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
