import { createHashRouter, Navigate, Outlet, RouterProvider } from 'react-router'
import FaixaErro from './componentes/FaixaErro.jsx'
import MenuLateral from './layout/MenuLateral.jsx'
import { ResumoProvider, useResumo } from './layout/ResumoProvider.jsx'
import Anos from './telas/Anos.jsx'
import Cadastro from './telas/Cadastro.jsx'
import Clientes from './telas/Clientes.jsx'
import Exportar from './telas/Exportar.jsx'
import Execucoes from './telas/Execucoes.jsx'
import Inicio from './telas/Inicio.jsx'
import Mes from './telas/Mes.jsx'
import Meses from './telas/Meses.jsx'
import Nota from './telas/Nota.jsx'
import NotasRaiz from './telas/NotasRaiz.jsx'
import Pendentes from './telas/Pendentes.jsx'
import Cupons from './telas/Cupons.jsx'
import Camadas from './sped/Camadas.jsx'
import Contador from './sped/Contador.jsx'
import Converter from './sped/Converter.jsx'
import Gerados from './sped/Gerados.jsx'
import { SpedProvider } from './sped/SpedProvider.jsx'

function FaixaAmbiente() {
  const { resumo } = useResumo()
  const ambiente = resumo?.ambiente
  if (!ambiente || (ambiente.producao && !ambiente.sefazSimulada)) return null
  return (
    <div className="faixa-ambiente" role="note">
      {ambiente.sefazSimulada
        ? 'SEFAZ simulada: as notas são de demonstração e nada é enviado à SEFAZ.'
        : 'Homologação: ambiente de testes da SEFAZ, as notas não têm valor fiscal.'}
    </div>
  )
}

function Estrutura() {
  const { erro } = useResumo()
  return (
    <div className="estrutura">
      <FaixaAmbiente />
      <div className="estrutura-corpo">
        <MenuLateral />
        <main className="conteudo">
          <FaixaErro mensagem={erro} />
          <Outlet />
        </main>
      </div>
      <Camadas />
    </div>
  )
}

const rotas = createHashRouter([
  {
    path: '/',
    element: <Estrutura />,
    children: [
      { index: true, element: <Inicio /> },
      { path: 'notas', element: <NotasRaiz /> },
      { path: 'notas/:cnpj', element: <Anos /> },
      { path: 'notas/:cnpj/:ano', element: <Meses /> },
      { path: 'notas/:cnpj/nota/:id', element: <Nota /> },
      { path: 'notas/:cnpj/:ano/:mes', element: <Mes /> },
      { path: 'pendentes', element: <Pendentes /> },
      { path: 'cupons', element: <Cupons /> },
      { path: 'clientes', element: <Clientes /> },
      { path: 'clientes/novo', element: <Cadastro key="novo" modo="novo" /> },
      { path: 'clientes/:cnpj/certificado', element: <Cadastro key="certificado" modo="certificado" /> },
      { path: 'escritorio', element: <Cadastro key="escritorio" modo="escritorio" /> },
      { path: 'exportar', element: <Exportar /> },
      { path: 'execucoes', element: <Execucoes /> },
      { path: 'sped', element: <Converter /> },
      { path: 'sped/gerados', element: <Gerados /> },
      { path: 'sped/contador', element: <Contador /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export default function App() {
  return (
    <ResumoProvider>
      <SpedProvider>
        <RouterProvider router={rotas} />
      </SpedProvider>
    </ResumoProvider>
  )
}
