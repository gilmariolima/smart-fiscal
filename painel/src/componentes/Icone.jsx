// Ícones de traço (24×24, cor do texto) dos atalhos do Início.
const DESENHOS = {
  notas: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M8 13h8M8 16h5" />
    </>
  ),
  clientes: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18 13.8c1.8.7 3 2.6 3 5.2" />
    </>
  ),
  novoCliente: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <path d="M19 8v6M16 11h6" />
    </>
  ),
  exportar: (
    <>
      <path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  pendentes: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v4M12 18h.01" />
    </>
  ),
  execucoes: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  escritorio: (
    <>
      <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
      <path d="M16 9h2a2 2 0 0 1 2 2v10M2.5 21h19" />
      <path d="M8 7h4M8 11h4M8 15h4" />
    </>
  ),
  capturar: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  certificado: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
      <path d="M8 7h8M8 10.5h5" />
      <circle cx="8.5" cy="16" r="2.8" />
      <path d="m7 18.4-.8 3.1 2.3-1.1 2.3 1.1-.8-3.1" />
    </>
  ),
}

export default function Icone({ nome }) {
  return (
    <svg className="icone" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {DESENHOS[nome]}
    </svg>
  )
}
