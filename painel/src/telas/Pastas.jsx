import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api.js'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { useApi } from '../useApi.js'
import { inteiro, plural } from '../formato.js'

const INTERVALO_ANDAMENTO = 5000
const SEM_NUMEROS = { feitos: 0, total: 0, fase: 'copiando' }
// Troca cujo resultado ainda não apareceu: sobrevive a sair desta tela e voltar.
let resultadoPendente = false

function Barra({ rotulo, feitos, total }) {
  const porcento = total ? Math.min(100, Math.round((feitos / total) * 100)) : 0
  return (
    <div className="barra-captura-trilho" role="progressbar" aria-label={rotulo} aria-valuemin={0} aria-valuemax={100} aria-valuenow={porcento}>
      <div className="barra-captura-preenchido" style={{ width: `${porcento}%` }} />
    </div>
  )
}

// Andamento da troca de pasta: primeiro copia, depois apaga da pasta antiga.
function AndamentoDaTroca({ troca }) {
  const { feitos, total, fase } = troca
  return (
    <div className="barra-captura" role="status">
      <div className="barra-captura-texto">
        <strong>{total ? `Trocando de pasta: ${inteiro(feitos)} de ${inteiro(total)}` : 'Trocando de pasta…'}</strong>
      </div>
      <Barra rotulo="Andamento da troca de pasta" feitos={feitos} total={total} />
      <p className="barra-captura-nota">{fase === 'apagando' ? 'Tirando os arquivos da pasta antiga.' : 'Copiando os arquivos para a pasta nova.'}</p>
    </div>
  )
}

// Andamento da organização da pasta, nas classes da barra da captura.
function AndamentoDaPasta({ organizacao }) {
  const { situacao, feitos, total, atual, falhas, ultimoErro } = organizacao
  if (situacao === 'parada' && !falhas) return null
  return (
    <div className="barra-captura" role="status">
      {situacao === 'organizando' && (
        <>
          <div className="barra-captura-texto">
            <strong>{`Organizando a pasta: ${inteiro(feitos)} de ${inteiro(total)}`}</strong>
          </div>
          <Barra rotulo="Andamento da organização" feitos={feitos} total={total} />
          {atual && <p className="barra-captura-nota">{atual}</p>}
        </>
      )}
      {situacao === 'conferindo' && (
        <>
          <div className="barra-captura-texto">
            <strong>{`Conferindo a pasta: ${inteiro(feitos)} de ${inteiro(total)}`}</strong>
          </div>
          <Barra rotulo="Andamento da conferência" feitos={feitos} total={total} />
        </>
      )}
      {situacao === 'indisponivel' && <p className="barra-captura-nota">Pasta indisponível. A organização continua na próxima captura ou abertura do app.</p>}
      {!!falhas && (
        <p className="barra-captura-nota">
          {plural(falhas, 'mês ficou', 'meses ficaram')} para depois.{ultimoErro ? ` Último erro: ${ultimoErro}` : ''}
        </p>
      )}
    </div>
  )
}

// #/pastas: o escritório escolhe a pasta onde ficam as empresas e as notas.
export default function Pastas() {
  const { dados: estado, erro: erroCarga, recarregar } = useApi('/api/pastas')
  const { dados: backup } = useApi('/api/backup')
  const { resumo, recarregar: recarregarResumo } = useResumo()
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  // Fora do app instalado não há janela de pastas: vale digitar o endereço.
  const [texto, setTexto] = useState(null)
  const telaAberta = useRef(false)
  const respostaNaTela = useRef(false)
  const soNoPc = resumo && !resumo.cadastroLiberado

  // Atualiza o andamento só enquanto há o que mostrar; recarregar mantém os dados na tela.
  const trocando = !!estado?.movendo
  const emAndamento = ocupado || trocando || ['organizando', 'conferindo'].includes(estado?.organizacao?.situacao)
  useEffect(() => {
    if (!emAndamento) return undefined
    const timer = setInterval(recarregar, INTERVALO_ANDAMENTO)
    return () => clearInterval(timer)
  }, [emAndamento, recarregar])

  useEffect(() => {
    telaAberta.current = true
    return () => {
      telaAberta.current = false
    }
  }, [])

  // Troca que terminou sem a resposta do POST nesta tela (a pessoa saiu e voltou): quem conta o resultado é o estado.
  const ultimaTroca = estado?.ultimaTroca
  useEffect(() => {
    if (trocando && !respostaNaTela.current) resultadoPendente = true
    if (!trocando && !ocupado) respostaNaTela.current = false
    if (trocando || ocupado || !resultadoPendente || !ultimaTroca) return
    resultadoPendente = false
    if (ultimaTroca.ok) setAviso([ultimaTroca.mensagem, ...ultimaTroca.avisos].join(' '))
    else setErro(ultimaTroca.mensagem)
    recarregarResumo()
  }, [trocando, ocupado, ultimaTroca, recarregarResumo])

  async function salvar(pasta) {
    resultadoPendente = true
    setOcupado(true)
    setErro(null)
    setAviso(null)
    // Saiu da tela antes da resposta: o resultado continua pendente para quando voltar.
    const respondeu = () => {
      respostaNaTela.current = true
      if (telaAberta.current) resultadoPendente = false
    }
    try {
      const r = await api.post('/api/pastas/principal', { pasta })
      respondeu()
      setAviso(r.mensagem)
      setTexto(null)
    } catch (e) {
      respondeu()
      setErro(e.message)
    } finally {
      setOcupado(false)
      recarregar()
      recarregarResumo()
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
  const movendo = ocupado || trocando
  const troca = estado.movendo || (ocupado ? SEM_NUMEROS : null)

  return (
    <Pagina titulo="Pastas" subtitulo="Escolha a pasta onde ficam as empresas e as notas." erro={erro || erroCarga} aoFecharErro={() => setErro(null)} aviso={aviso}>
      <section className="formulario" aria-label="Pasta principal">
        <strong className="formulario-titulo">Pasta principal</strong>
        <p className="formulario-nota">
          Pode ser em outro disco ou na rede. Ao trocar, o que já existe vai junto. Empresa, ano, mês e tipo, com XML, PDF, relatórios e ZIP.
        </p>
        {!atual && <p className="formulario-nota">{soNoPc ? 'A pasta é escolhida no computador do escritório.' : 'Escolha a pasta principal para começar a capturar.'}</p>}
        {troca && <AndamentoDaTroca troca={troca} />}
        {atual && !troca && estado.organizacao && <AndamentoDaPasta organizacao={estado.organizacao} />}
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
            {atual && (
              <p className="pasta-atual pasta-principal">
                <i className="fa-solid fa-folder" /> <span className="mono">{atual}</span>
              </p>
            )}
            <div className="formulario-acoes">
              {!soNoPc && (
                <button type="button" className="botao botao-azul" onClick={escolher} disabled={movendo}>
                  {movendo ? 'Movendo…' : atual ? 'Trocar pasta' : 'Escolher pasta'}
                </button>
              )}
              {atual && (
                <button type="button" className="botao botao-claro" onClick={abrir} disabled={soNoPc}>
                  <i className="fa-solid fa-folder-open" /> Abrir
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
