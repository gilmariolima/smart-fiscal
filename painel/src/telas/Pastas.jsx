import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api.js'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { useApi } from '../useApi.js'

// #/pastas: o escritório escolhe um lugar só; nele ficam SMART FISCAL\Notas e SMART FISCAL\Arquivos SPED.
export default function Pastas() {
  const { dados: estado, erro: erroCarga, recarregar } = useApi('/api/pastas')
  const { dados: backup } = useApi('/api/backup')
  const { resumo } = useResumo()
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  // Fora do app instalado não há janela de pastas: vale digitar o endereço.
  const [texto, setTexto] = useState(null)
  const soNoPc = resumo && !resumo.cadastroLiberado

  async function salvar(pasta) {
    setOcupado(true)
    setErro(null)
    setAviso(null)
    try {
      const r = await api.post('/api/pastas/principal', { pasta })
      setAviso(r.mensagem)
      if (r.erroSped) setErro(r.erroSped)
      setTexto(null)
    } catch (e) {
      setErro(e.message)
    } finally {
      setOcupado(false)
      recarregar()
    }
  }

  async function escolher() {
    setErro(null)
    try {
      const r = await api.post('/api/pastas/escolher')
      if (r.indisponivel) setTexto('')
      else if (r.pasta) await salvar(r.pasta)
    } catch (e) {
      setErro(e.message)
    }
  }

  async function abrir() {
    setErro(null)
    try {
      await api.post('/api/pastas/abrir', { tipo: 'principal' })
    } catch (e) {
      setErro(e.message)
    }
  }

  if (!estado) return <Pagina titulo="Pastas" subtitulo={erroCarga ? '' : 'Carregando…'} erro={erroCarga} />

  const atual = estado.principal
  const movendo = ocupado || !!estado.movendo

  return (
    <Pagina titulo="Pastas" subtitulo="Escolha onde vai ficar a pasta SMART FISCAL, com as notas e os arquivos do SPED." erro={erro} aoFecharErro={() => setErro(null)} aviso={aviso}>
      <section className="formulario" aria-label="Pasta principal">
        <strong className="formulario-titulo">Pasta principal</strong>
        <p className="formulario-nota">
          Pode ser em outro disco ou na rede. Ao trocar, as notas e os arquivos do SPED que já existem vão junto. Dentro dela: <span className="mono">Notas</span>, por tipo, cliente, ano e mês, e{' '}
          <span className="mono">Arquivos SPED</span>.
        </p>
        {texto !== null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              salvar(texto)
            }}
          >
            <label className="campo">
              <span>Endereço da pasta</span>
              <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="D:\Contabilidade ou \\servidor\contabilidade" spellCheck={false} autoComplete="off" autoFocus />
            </label>
            <div className="formulario-acoes">
              <button type="submit" className="botao botao-azul" disabled={movendo || !texto.trim()}>
                {movendo ? 'Movendo…' : 'Salvar pasta'}
              </button>
              <button type="button" className="botao botao-claro" onClick={() => setTexto(null)} disabled={movendo}>
                Cancelar
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="pasta-atual pasta-principal">
              <i className="fa-solid fa-folder" /> {atual ? <span className="mono">{atual}</span> : 'Ainda na pasta de dados do Smart Fiscal (padrão)'}
            </p>
            <div className="formulario-acoes">
              {!soNoPc && (
                <button type="button" className="botao botao-azul" onClick={escolher} disabled={movendo}>
                  {movendo ? 'Movendo…' : 'Escolher pasta'}
                </button>
              )}
              <button type="button" className="botao botao-claro" onClick={abrir} disabled={soNoPc}>
                <i className="fa-solid fa-folder-open" /> Abrir
              </button>
              {!soNoPc && atual && (
                <button type="button" className="botao botao-claro" onClick={() => salvar('')} disabled={movendo}>
                  Usar a pasta padrão
                </button>
              )}
            </div>
          </>
        )}
      </section>
      <section className="formulario" aria-label="Backup">
        <strong className="formulario-titulo">Backup</strong>
        <p className="formulario-nota">
          {backup?.pasta ? (
            <>
              Vai para <span className="mono">{backup.pasta}</span>.{' '}
            </>
          ) : (
            'Desligado. '
          )}
          A pasta do backup se escolhe na tela <Link to="/backup">Backup</Link>.
        </p>
      </section>
      <section className="formulario" aria-label="Dados protegidos">
        <strong className="formulario-titulo">Banco, certificados e MASTER_KEY</strong>
        <p className="formulario-nota">
          Ficam sempre na pasta de dados do Smart Fiscal, protegida no perfil do Windows, e não mudam de lugar: é o que abre os
          certificados dos clientes. O backup leva uma cópia deles.
        </p>
      </section>
    </Pagina>
  )
}
