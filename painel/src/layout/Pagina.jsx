import FaixaErro from '../componentes/FaixaErro.jsx'
import Trilha from './Trilha.jsx'

// Moldura de toda tela: erro no topo, título e subtítulo com as ações à direita (centralizadas nos dois), trilha e o conteúdo.
export default function Pagina({ titulo, subtitulo, trilha, acoes, erro, aoFecharErro, aviso, children }) {
  return (
    <div className="pagina">
      <FaixaErro mensagem={erro} aoFechar={aoFecharErro} />
      {aviso && (
        <div className="faixa faixa-ok" role="status">
          {aviso}
        </div>
      )}
      <header className="pagina-cabecalho">
        <div className="pagina-titulos">
          <h1>{titulo}</h1>
          <p className="pagina-subtitulo">{subtitulo || ' '}</p>
        </div>
        {acoes && <div className="pagina-acoes">{acoes}</div>}
      </header>
      <Trilha partes={trilha} />
      {children}
    </div>
  )
}
