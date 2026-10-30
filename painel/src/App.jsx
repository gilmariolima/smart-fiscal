import { createHashRouter, Navigate, Outlet, RouterProvider } from 'react-router'
import FaixaErro from './componentes/FaixaErro.jsx'
import MenuLateral from './layout/MenuLateral.jsx'
import { ResumoProvider, useResumo } from './layout/ResumoProvider.jsx'
import Anos from './telas/Anos.jsx'
import Cadastro from './telas/Cadastro.jsx'
import Capturar from './telas/Capturar.jsx'
import NotasNovas from './telas/NotasNovas.jsx'
import Clientes from './telas/Clientes.jsx'
import Execucoes from './telas/Execucoes.jsx'
import Backup from './telas/Backup.jsx'
import Pastas from './telas/Pastas.jsx'
import Inicio from './telas/Inicio.jsx'
import Mes from './telas/Mes.jsx'
import Meses from './telas/Meses.jsx'
import Modelos from './telas/Modelos.jsx'
import Nota from './telas/Nota.jsx'
import NotasRaiz from './telas/NotasRaiz.jsx'
import Pendentes from './telas/Pendentes.jsx'
import PendentesClientes from './telas/PendentesClientes.jsx'
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
      { path: 'capturar', element: <Capturar /> },
      { path: 'capturar/:modelo', element: <Capturar /> },
      { path: 'capturar/:modelo/novas/:cnpj', element: <NotasNovas /> },
      // Tipo (NF-e | NFS-e | CT-e | XMLs não baixados) → cliente → ano → mês → Entradas | Saídas
      { path: 'notas', element: <Modelos /> },
      { path: 'notas/nf-e', element: <NotasRaiz key="nf-e" slug="nf-e" /> },
      { path: 'notas/nfs-e', element: <NotasRaiz key="nfs-e" slug="nfs-e" /> },
      { path: 'notas/pendentes', element: <PendentesClientes /> },
      // Pasta de um cliente só (botão "Ver as notas" em Clientes)
      { path: 'notas/:cnpj', element: <Modelos /> },
      { path: 'notas/:cnpj/nota/:id', element: <Nota /> },
      { path: 'notas/:cnpj/pendentes', element: <Pendentes /> },
      { path: 'notas/:cnpj/:modelo', element: <Anos /> },
      { path: 'notas/:cnpj/:modelo/:ano', element: <Meses /> },
      // Entradas e saídas juntas na lista do mês; os caminhos antigos das pastas caem nela.
      { path: 'notas/:cnpj/:modelo/:ano/:mes', element: <Mes /> },
      { path: 'notas/:cnpj/:modelo/:ano/:mes/*', element: <Navigate to=".." relative="path" replace /> },
      { path: 'pendentes', element: <Navigate to="/notas/pendentes" replace /> },
      { path: 'clientes', element: <Clientes /> },
      { path: 'clientes/novo', element: <Cadastro key="novo" modo="novo" /> },
      { path: 'clientes/:cnpj/certificado', element: <Cadastro key="certificado" modo="certificado" /> },
      { path: 'escritorio', element: <Cadastro key="escritorio" modo="escritorio" /> },
      // A exportação agora é pelo "Exportar mês" de cada mês.
      { path: 'exportar', element: <Navigate to="/notas" replace /> },
      { path: 'execucoes', element: <Execucoes /> },
      { path: 'backup', element: <Backup /> },
      { path: 'pastas', element: <Pastas /> },
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
