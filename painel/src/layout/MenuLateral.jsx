import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { api } from '../api.js'
import { inteiro } from '../formato.js'
import { useResumo } from './ResumoProvider.jsx'

// Seções do app: as notas (SEFAZ), o SPED Fiscal (inventário do bloco H) e os cadastros.
const GRUPOS = [
  {
    itens: [
      { para: '/', rotulo: 'Início', icone: 'fa-house', fim: true },
      { para: '/capturar', rotulo: 'Capturar', icone: 'fa-rotate' },
    ],
  },
  {
    titulo: 'Notas fiscais',
    itens: [
      { para: '/notas', rotulo: 'Notas', icone: 'fa-folder-open' },
      { para: '/pendentes', rotulo: 'XMLs não baixados', icone: 'fa-file-circle-exclamation' },
      { para: '/exportar', rotulo: 'Exportar', icone: 'fa-file-export' },
      { para: '/execucoes', rotulo: 'Execuções', icone: 'fa-clock-rotate-left' },
    ],
  },
  {
    titulo: 'SPED Fiscal',
    itens: [
      { para: '/sped', rotulo: 'Converter inventário', icone: 'fa-file-import', fim: true },
      { para: '/sped/gerados', rotulo: 'Arquivos gerados', icone: 'fa-box-archive' },
    ],
  },
  {
    titulo: 'Cadastros',
    itens: [
      { para: '/clientes', rotulo: 'Clientes', icone: 'fa-users' },
      { para: '/escritorio', rotulo: 'Escritório', icone: 'fa-building' },
      { para: '/sped/contador', rotulo: 'Contador do SPED', icone: 'fa-user-tie' },
      { para: '/pastas', rotulo: 'Pastas', icone: 'fa-folder-tree' },
      { para: '/backup', rotulo: 'Backup', icone: 'fa-shield-halved' },
    ],
  },
]

const SITUACOES_SEM_XML = [
  { chave: 'aguardandoCiencia', status: 'resumo', rotulo: 'Aguardando o cliente', dica: 'Notas só com resumo: o XML chega depois que o cliente der ciência' },
  { chave: 'aguardandoXml', status: 'aguardando_xml', rotulo: 'Aguardando XML' },
  { chave: 'esgotada', status: 'esgotada', rotulo: 'Esgotada' },
  { chave: 'cienciaErro', status: 'ciencia_erro', rotulo: 'Erro na ciência' },
]

// Notas sem XML completo (todos os meses, sem as canceladas), uma linha por situação.
function SemXml() {
  const { resumo } = useResumo()
  const contagem = resumo?.semXmlPorSituacao
  if (!contagem) return null
  return (
    <section className="sem-xml" aria-labelledby="sem-xml-titulo">
      <h2 id="sem-xml-titulo">
        <Link to="/pendentes">Notas sem XML</Link>
        <strong>{inteiro(resumo.notasSemXml)}</strong>
      </h2>
      <ul>
        {SITUACOES_SEM_XML.map((s) => (
          <li key={s.chave} className={contagem[s.chave] ? undefined : 'zerada'}>
            <Link to={`/pendentes?status=${s.status}`} title={s.dica}>
              {s.rotulo}
              <strong>{inteiro(contagem[s.chave])}</strong>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

// Texto ao lado do botão "Verificar atualizações", conforme a situação da atualização do app.
function textoDaAtualizacao(a) {
  switch (a?.situacao) {
    case 'procurando':
      return 'Procurando…'
    case 'atualizado':
      return 'Você está na versão mais nova.'
    case 'baixando':
      return `Baixando a versão ${a.versao || 'nova'}${a.progresso ? ` (${a.progresso}%)` : ''}…`
    case 'pronta':
      return `Versão ${a.versao} pronta: reinicie para instalar.`
    case 'erro':
      return 'Não deu para verificar agora (sem internet?).'
    case 'indisponivel':
      return 'A atualização só funciona no app instalado.'
    default:
      return ''
  }
}

// Rodapé do menu: a versão e o botão "Verificar atualizações". Enquanto baixa, confere a cada 2 s.
function Versao({ versao }) {
  const [atualizacao, setAtualizacao] = useState(null)
  const [mostrar, setMostrar] = useState(false)

  useEffect(() => {
    if (!mostrar || !['baixando', 'procurando'].includes(atualizacao?.situacao)) return undefined
    const t = setTimeout(() => api.get('/api/atualizacao').then(setAtualizacao, () => {}), 2000)
    return () => clearTimeout(t)
  }, [mostrar, atualizacao])

  async function verificar() {
    setMostrar(true)
    setAtualizacao({ situacao: 'procurando' })
    try {
      setAtualizacao(await api.post('/api/atualizacao/verificar', {}))
    } catch {
      setAtualizacao({ situacao: 'erro' })
    }
  }

  const ocupado = ['procurando', 'baixando'].includes(atualizacao?.situacao)
  return (
    <div className="menu-versao">
      <div className="menu-versao-linha">
        <span>Versão {versao}</span>
        <button type="button" className="botao-link menu-versao-botao" onClick={verificar} disabled={ocupado}>
          <i className={`fa-solid fa-rotate${ocupado ? ' fa-spin' : ''}`} aria-hidden="true" /> Verificar atualizações
        </button>
      </div>
      {mostrar && (
        <p className={`menu-versao-situacao situacao-${atualizacao?.situacao || 'nada'}`} role="status">
          {textoDaAtualizacao(atualizacao)}
        </p>
      )}
    </div>
  )
}

function Marca() {
  return (
    <div className="marca">
      <img src="/icone.svg" alt="" />
      <div>
        Smart Fiscal
        <small>Notas e SPED Fiscal</small>
      </div>
    </div>
  )
}

export default function MenuLateral() {
  const [aberto, setAberto] = useState(false)
  const local = useLocation()
  const { resumo } = useResumo()

  useEffect(() => setAberto(false), [local.pathname])

  useEffect(() => {
    if (!aberto) return undefined
    const tecla = (e) => e.key === 'Escape' && setAberto(false)
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [aberto])

  return (
    <>
      <div className="barra-movel">
        <button
          type="button"
          className="botao-menu"
          aria-expanded={aberto}
          aria-controls="menu-lateral"
          aria-label={aberto ? 'Fechar menu' : 'Abrir menu'}
          onClick={() => setAberto((a) => !a)}
        >
          ☰
        </button>
        <span className="marca">Smart Fiscal</span>
      </div>
      {aberto && <div className="menu-fundo" aria-hidden="true" onClick={() => setAberto(false)} />}
      <aside id="menu-lateral" className={`menu-lateral${aberto ? ' aberto' : ''}`}>
        <Marca />
        <nav aria-label="Seções">
          {GRUPOS.map((g, n) => (
            <div key={g.titulo || n} role="group" aria-label={g.titulo}>
              {g.titulo && <div className="menu-grupo">{g.titulo}</div>}
              {g.itens.map((item) => (
                <NavLink
                  key={item.para}
                  to={item.para}
                  end={item.fim}
                  className={({ isActive }) => `menu-item${isActive || local.pathname === item.tambem ? ' ativo' : ''}`}
                >
                  <i className={`fa-solid ${item.icone}`} aria-hidden="true" />
                  <span>{item.rotulo}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <SemXml />
        {resumo?.versao && <Versao versao={resumo.versao} />}
      </aside>
    </>
  )
}
