import { useEffect, useState } from 'react'
import { api } from '../api.js'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { useApi } from '../useApi.js'
import { quando } from '../formato.js'

const ORIGEM = {
  painel: 'Escolhida aqui.',
  env: 'Vem do PASTA_BACKUP do .env. Salvar uma pasta aqui passa a valer no lugar dela.',
}

function Situacao({ estado }) {
  if (estado.emAndamento) return <Etiqueta cor="azul">Fazendo backup…</Etiqueta>
  if (!estado.configurado) return <Etiqueta cor="vermelha">Desligado</Etiqueta>
  if (estado.alerta) return <Etiqueta cor="ambar">{estado.alerta}</Etiqueta>
  return <Etiqueta cor="verde">Em dia</Etiqueta>
}

// #/backup: pasta do backup automático, situação e backup na hora.
export default function Backup() {
  const { dados: estado, erro: erroCarga, recarregar } = useApi('/api/backup')
  const { resumo, recarregar: recarregarResumo } = useResumo()
  const [texto, setTexto] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [avisos, setAvisos] = useState([])

  if (estado && texto === null) setTexto(estado.pasta || '')

  // Enquanto o backup roda, confere a cada 2 s.
  useEffect(() => {
    if (!estado?.emAndamento) return undefined
    const t = setTimeout(recarregar, 2000)
    return () => clearTimeout(t)
  }, [estado, recarregar])

  async function enviar(acao) {
    setEnviando(true)
    setErro(null)
    setAviso(null)
    try {
      const r = await acao()
      setAviso(r.mensagem)
      setAvisos(r.avisos || [])
      if (r.estado && r.estado.pasta !== undefined) setTexto(r.estado.pasta || '')
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
      recarregar()
      recarregarResumo()
    }
  }

  const salvar = (e) => {
    e.preventDefault()
    enviar(() => api.post('/api/backup/pasta', { pasta: texto }))
  }
  const desligar = () => {
    if (!window.confirm('Desligar o backup automático? Os backups já feitos continuam na pasta.')) return
    enviar(() => api.post('/api/backup/pasta', { pasta: '' }))
  }
  const agora = () => enviar(() => api.post('/api/backup/agora', {}))

  if (!estado) return <Pagina titulo="Backup" subtitulo={erroCarga ? '' : 'Carregando…'} erro={erroCarga} />
  const soNoPc = resumo && !resumo.cadastroLiberado

  return (
    <Pagina
      titulo="Backup"
      subtitulo="Cópia automática dos dados do Smart Fiscal para outra pasta: ao abrir o app e a cada hora, uma cópia por dia."
      erro={erro}
      aoFecharErro={() => setErro(null)}
      aviso={aviso}
    >
      <form className="formulario" onSubmit={salvar} aria-label="Pasta do backup">
        <strong className="formulario-titulo">Pasta do backup</strong>
        {avisos.map((a) => (
          <p key={a} className="faixa faixa-ambar">
            {a}
          </p>
        ))}
        <label className="campo">
          <span>Endereço da pasta</span>
          <input
            value={texto ?? ''}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="D:\Backup Smart Fiscal ou \\servidor\backup\SmartFiscal"
            spellCheck={false}
            autoComplete="off"
            disabled={soNoPc}
          />
        </label>
        <p className="formulario-nota">
          {estado.origem ? `${ORIGEM[estado.origem]} ` : ''}
          Use uma pasta fora deste disco: outro disco, a rede do escritório ou uma pasta do OneDrive/Google Drive. O backup leva os
          certificados e a MASTER_KEY, então a pasta deve ser só sua, sem compartilhar.
        </p>
        {soNoPc ? (
          <p className="formulario-nota">A pasta só pode ser trocada no computador onde o Smart Fiscal está instalado.</p>
        ) : (
          <div className="formulario-acoes">
            <button type="submit" className="botao botao-azul" disabled={enviando || !(texto || '').trim()}>
              Salvar pasta
            </button>
            {estado.configurado && (
              <button type="button" className="botao botao-perigo" onClick={desligar} disabled={enviando}>
                Desligar backup
              </button>
            )}
          </div>
        )}
      </form>

      <section className="formulario" aria-label="Situação do backup">
        <strong className="formulario-titulo">Situação</strong>
        <dl className="ficha">
          <dt>Backup</dt>
          <dd>
            <Situacao estado={estado} />
          </dd>
          <dt>Último backup</dt>
          <dd>{estado.ultimoEm ? `${quando(estado.ultimoEm)}${estado.ultimoResumo ? ` · ${estado.ultimoResumo}` : ''}` : '—'}</dd>
          <dt>O que vai</dt>
          <dd>
            Banco (clientes e notas), certificados, .env (MASTER_KEY) e todos os XMLs
            {estado.incluiSped ? '; do SPED, as empresas, as correções, o contador e os arquivos gerados' : ''}.
          </dd>
          <dt>Quanto guarda</dt>
          <dd>Os XMLs nunca são apagados do backup; das cópias do dia ficam as dos últimos 30 dias.</dd>
        </dl>
        <div className="formulario-acoes">
          <button type="button" className="botao botao-claro" onClick={agora} disabled={enviando || !estado.configurado || estado.emAndamento}>
            <i className="fa-solid fa-floppy-disk" /> Fazer backup agora
          </button>
        </div>
      </section>
    </Pagina>
  )
}
