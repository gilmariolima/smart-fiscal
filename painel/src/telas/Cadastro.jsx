import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { api } from '../api.js'
import { arquivoBase64 } from '../arquivoBase64.js'
import { useApi } from '../useApi.js'
import { nomeDe } from '../useCliente.js'
import { cnpj as formatarCnpj, data, plural } from '../formato.js'

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']

const VOLTAR = <Link to="/clientes">Voltar para Clientes</Link>

function Recibo({ r, titulo, escritorio, novo }) {
  return (
    <section className="recibo recibo-cadastro" aria-label={titulo}>
      <strong className="recibo-titulo">{titulo}</strong>
      <dl className="ficha">
        <dt>{escritorio ? 'Escritório' : 'Cliente'}</dt>
        <dd>{escritorio ? r.razaoSocial : r.apelido || r.razaoSocial}</dd>
        <dt>CNPJ</dt>
        <dd className="mono">{formatarCnpj(r.cnpj)}</dd>
        {r.semCertificado ? (
          <>
            <dt>Certificado</dt>
            <dd>Sem certificado</dd>
          </>
        ) : (
          <>
            <dt>Titular do certificado</dt>
            <dd>{r.titular || '—'}</dd>
            <dt>CNPJ do certificado</dt>
            <dd className="mono">{formatarCnpj(r.cnpjCertificado) || '—'}</dd>
            <dt>Válido até</dt>
            <dd>{data(r.validade) || '—'}</dd>
          </>
        )}
      </dl>
      {!!r.avisos?.length && (
        <ul className="recibo-avisos">
          {r.avisos.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      {novo && (
        <p>
          {r.semCertificado
            ? 'A empresa fica desativada, sem entrar nas capturas. As notas de saída que chegarem pelo escritório ficam nela. Ao adicionar o certificado em Clientes, ela é ativada.'
            : escritorio
            ? 'O escritório entra na próxima captura e passa a receber as notas de saída em que os clientes o indicarem no autXML.'
            : 'O cliente entra na próxima captura automática. Para consultar agora, marque-o em Clientes e clique em Capturar selecionados.'}
        </p>
      )}
      {VOLTAR}
    </section>
  )
}

// Arquivo e senha do certificado. A senha fica só no campo (sem estado) e é apagada depois do envio.
function CamposCertificado({ arquivo, senha }) {
  return (
    <>
      <label className="campo">
        <span>Certificado A1 (.pfx ou .p12)</span>
        <input ref={arquivo} type="file" accept=".pfx,.p12" required />
      </label>
      <label className="campo">
        <span>Senha do certificado</span>
        <input ref={senha} type="password" required autoComplete="off" />
      </label>
    </>
  )
}

// Envio comum: valida, lê o certificado e manda o POST. Senha e arquivo só são limpos depois de o POST ter saído.
function useEnvioDeCertificado() {
  const arquivo = useRef(null)
  const senha = useRef(null)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [recibo, setRecibo] = useState(null)
  const { recarregar: recarregarResumo } = useResumo()

  // `semArquivo`: cadastro sem certificado, só com os dados da empresa.
  async function enviar(evento, montar, validar, semArquivo = false) {
    evento.preventDefault()
    setErro(null)
    setEnviando(true)
    let postEnviado = false
    try {
      validar?.()
      if (semArquivo) {
        setRecibo(await montar({ semCertificado: true }))
      } else {
        const f = arquivo.current.files[0]
        if (!f) throw new Error('Escolha o arquivo do certificado.')
        const pfx = await arquivoBase64(f)
        postEnviado = true
        setRecibo(await montar({ pfx, senha: senha.current.value }))
      }
      recarregarResumo()
    } catch (e) {
      setErro(e.message)
    } finally {
      if (postEnviado) {
        if (senha.current) senha.current.value = ''
        if (arquivo.current) arquivo.current.value = ''
      }
      setEnviando(false)
    }
  }

  return { arquivo, senha, enviando, erro, setErro, recibo, enviar }
}

const NOTA_SEGURANCA =
  'Ao cadastrar, o sistema abre o certificado e confere a senha, a validade e se ele é da mesma empresa do CNPJ. O arquivo é copiado para a pasta do sistema e a senha fica guardada criptografada.'

function FormNovo({ escritorio }) {
  const envio = useEnvioDeCertificado()
  const [campos, setCampos] = useState({ cnpj: '', razao: '', uf: '', apelido: '' })
  const [semCertificado, setSemCertificado] = useState(false)
  const mudar = (nome) => (e) => setCampos((c) => ({ ...c, [nome]: e.target.value }))
  const cnpj = campos.cnpj.replace(/\D/g, '')
  const titulo = escritorio ? 'Cadastrar escritório' : 'Novo cliente'

  const enviar = (e) =>
    envio.enviar(
      e,
      async (cert) => {
        const corpo = { cnpj, razao: campos.razao.trim(), uf: campos.uf, ...cert }
        return escritorio ? api.post('/api/escritorio', corpo) : api.post('/api/clientes', { ...corpo, apelido: campos.apelido.trim() })
      },
      () => {
        if (cnpj.length !== 14) throw new Error('O CNPJ precisa ter 14 dígitos.')
        if (!campos.razao.trim()) throw new Error('Informe a razão social.')
        if (!campos.uf) throw new Error('Escolha a UF.')
      },
      semCertificado,
    )

  return (
    <Pagina
      titulo={titulo}
      subtitulo={escritorio ? 'O certificado do escritório recebe as notas de saída dos clientes pelo autXML.' : 'A empresa, com ou sem o certificado A1 dela.'}
      trilha={[{ rotulo: 'Clientes', para: '/clientes' }, { rotulo: titulo }]}
      erro={envio.erro}
      aoFecharErro={() => envio.setErro(null)}
    >
      {envio.recibo ? (
        <Recibo r={envio.recibo} titulo={escritorio ? 'Escritório cadastrado' : 'Cliente cadastrado'} escritorio={escritorio} novo />
      ) : (
        <form className="formulario" onSubmit={enviar}>
          <label className="campo">
            <span>CNPJ</span>
            <input value={campos.cnpj} onChange={mudar('cnpj')} required inputMode="numeric" placeholder="00.000.000/0000-00" autoComplete="off" />
          </label>
          <label className="campo">
            <span>Razão social</span>
            <input value={campos.razao} onChange={mudar('razao')} required autoComplete="off" />
          </label>
          <div className="linha-campos">
            <label className="campo campo-uf">
              <span>UF</span>
              <select value={campos.uf} onChange={mudar('uf')} required>
                <option value="">Escolha</option>
                {UFS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            {!escritorio && (
              <label className="campo">
                <span>Apelido (opcional)</span>
                <input value={campos.apelido} onChange={mudar('apelido')} maxLength={40} placeholder="Ex.: Padaria" autoComplete="off" />
              </label>
            )}
          </div>
          {!escritorio && (
            <label className="campo-marcar">
              <input type="checkbox" checked={semCertificado} onChange={(e) => setSemCertificado(e.target.checked)} />
              <span>Cadastrar sem certificado</span>
            </label>
          )}
          {semCertificado ? (
            <p className="formulario-nota">Sem o certificado, a empresa fica desativada e não entra nas capturas. As notas de saída que chegarem pelo escritório ficam nela. Ao adicionar o certificado depois, em Clientes, ela é ativada.</p>
          ) : (
            <>
              <CamposCertificado arquivo={envio.arquivo} senha={envio.senha} />
              <p className="formulario-nota">{NOTA_SEGURANCA}</p>
            </>
          )}
          <div className="formulario-acoes">
            <button type="submit" className="botao botao-azul" disabled={envio.enviando}>
              {envio.enviando ? (semCertificado ? 'Cadastrando…' : 'Conferindo o certificado…') : 'Cadastrar'}
            </button>
            {VOLTAR}
          </div>
        </form>
      )}
      {escritorio && !envio.recibo && <Procurador />}
    </Pagina>
  )
}

function FormTroca({ alvo, escritorio, aoSalvar, aoExcluir }) {
  const envio = useEnvioDeCertificado()
  const nome = escritorio ? alvo.razaoSocial : nomeDe(alvo)
  const titulo = escritorio ? 'Certificado do escritório' : `Certificado de ${nome}`
  const validade =
    alvo.certDias === null || alvo.certDias === undefined
      ? '—'
      : alvo.certDias < 0
        ? `vencido em ${data(alvo.certValidade)}`
        : `válido até ${data(alvo.certValidade)} (${plural(alvo.certDias, 'dia', 'dias')})`

  const enviar = (e) =>
    envio.enviar(e, (cert) => api.post(escritorio ? '/api/escritorio/certificado' : `/api/clientes/${alvo.cnpj}/certificado`, cert))

  return (
    <Pagina
      titulo={titulo}
      subtitulo="Na renovação anual, escolha o arquivo do certificado novo e digite a senha dele."
      trilha={[{ rotulo: 'Clientes', para: '/clientes' }, { rotulo: escritorio ? 'Escritório' : nome }, { rotulo: 'Certificado' }]}
      erro={envio.erro}
      aoFecharErro={() => envio.setErro(null)}
    >
      {envio.recibo ? (
        <Recibo r={envio.recibo} titulo="Certificado trocado" escritorio={escritorio} />
      ) : (
        <form className="formulario" onSubmit={enviar}>
          <dl className="ficha">
            <dt>Razão social</dt>
            <dd>{alvo.razaoSocial}</dd>
            <dt>CNPJ</dt>
            <dd className="mono">{formatarCnpj(alvo.cnpj)}</dd>
            <dt>Certificado atual</dt>
            <dd>{validade}</dd>
            <dt>Situação</dt>
            <dd>{alvo.ativo ? 'Ativo' : 'Desativado'}</dd>
          </dl>
          <CamposCertificado arquivo={envio.arquivo} senha={envio.senha} />
          <div className="formulario-acoes">
            <button type="submit" className="botao botao-azul" disabled={envio.enviando}>
              {envio.enviando ? 'Conferindo o certificado…' : 'Trocar certificado'}
            </button>
            {VOLTAR}
          </div>
        </form>
      )}
      {escritorio && !envio.recibo && <DadosDoEscritorio alvo={alvo} aoSalvar={aoSalvar} aoExcluir={aoExcluir} />}
      {escritorio && <Procurador />}
    </Pagina>
  )
}

// Certificado procurador: e-CPF (ou e-CNPJ) com procuração no portal nacional, para puxar a NFS-e de
// clientes sem certificado próprio. Fica na tela Escritório, mas é um certificado à parte.
function Procurador() {
  const { dados, recarregar } = useApi('/api/procurador')
  const envio = useEnvioDeCertificado()
  const [removendo, setRemovendo] = useState(false)
  const proc = dados?.procurador
  const salvar = (e) =>
    envio.enviar(e, async (cert) => {
      const r = await api.post('/api/procurador/certificado', cert)
      recarregar()
      return r.procurador
    })
  async function remover() {
    setRemovendo(true)
    try {
      await api.post('/api/procurador/remover')
      recarregar()
    } finally {
      setRemovendo(false)
    }
  }
  const aviso = proc && (proc.diasParaVencer < 0 ? ' (vencido)' : proc.diasParaVencer < 30 ? ` (vence em ${plural(proc.diasParaVencer, 'dia', 'dias')})` : '')
  return (
    <section className="cartao cartao-procurador" aria-label="Certificado procurador">
      <h2>Certificado procurador</h2>
      <p className="apagado">Para puxar a NFS-e de clientes sem certificado, cadastre aqui o certificado com procuração no portal nacional. Ele vale só para a NFS-e desses clientes.</p>
      {proc && (
        <p>
          Titular: <strong>{proc.titular || '—'}</strong> · válido até {data(proc.validade)}
          {aviso}
        </p>
      )}
      {envio.erro && <div className="faixa faixa-erro" role="alert">{envio.erro}</div>}
      <form className="formulario" onSubmit={salvar}>
        <CamposCertificado arquivo={envio.arquivo} senha={envio.senha} />
        <div className="formulario-acoes">
          <button type="submit" className="botao botao-azul" disabled={envio.enviando}>
            {envio.enviando ? 'Conferindo o certificado…' : proc ? 'Trocar certificado' : 'Cadastrar procurador'}
          </button>
          {proc && (
            <button type="button" className="botao botao-claro" onClick={remover} disabled={removendo}>
              Remover
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

// Razão social e UF do escritório, e a exclusão. O CNPJ não muda: para outro CNPJ, exclua e cadastre de novo.
function DadosDoEscritorio({ alvo, aoSalvar, aoExcluir }) {
  const [campos, setCampos] = useState({ razao: alvo.razaoSocial, uf: alvo.uf })
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const { recarregar } = useResumo()

  async function executar(acao) {
    setEnviando(true)
    setErro(null)
    setAviso(null)
    try {
      await acao()
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
    }
  }

  const salvar = (e) => {
    e.preventDefault()
    executar(async () => {
      const r = await api.post('/api/escritorio/dados', { razao: campos.razao.trim(), uf: campos.uf })
      setAviso(r.mensagem)
      aoSalvar({ razaoSocial: r.razaoSocial, uf: r.uf })
      recarregar()
    })
  }

  const excluir = () => {
    const pergunta = `Excluir o escritório ${alvo.razaoSocial}?

O cadastro e o certificado dele saem do Smart Fiscal e as notas de saída pelo autXML param de chegar. Os XMLs já recebidos continuam nas pastas.`
    if (!window.confirm(pergunta)) return
    executar(async () => {
      await api.post('/api/escritorio/excluir', {})
      recarregar()
      aoExcluir()
    })
  }

  return (
    <form className="formulario" onSubmit={salvar} aria-label="Dados do escritório">
      <strong className="formulario-titulo">Dados do escritório</strong>
      {erro && <p className="faixa faixa-erro" role="alert">{erro}</p>}
      {aviso && <p className="faixa faixa-ok" role="status">{aviso}</p>}
      <label className="campo">
        <span>Razão social</span>
        <input value={campos.razao} onChange={(e) => setCampos((c) => ({ ...c, razao: e.target.value }))} required autoComplete="off" />
      </label>
      <div className="linha-campos">
        <label className="campo campo-uf">
          <span>UF</span>
          <select value={campos.uf} onChange={(e) => setCampos((c) => ({ ...c, uf: e.target.value }))} required>
            {UFS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="formulario-nota">O CNPJ é o do certificado e não muda. Para usar outro CNPJ, exclua o escritório e cadastre de novo.</p>
      <div className="formulario-acoes">
        <button type="submit" className="botao botao-azul" disabled={enviando}>
          Salvar dados
        </button>
        <button type="button" className="botao botao-perigo" onClick={excluir} disabled={enviando}>
          Excluir escritório
        </button>
      </div>
    </form>
  )
}

// Todos os dados do cliente, menos o certificado, que tem a sua tela.
function FormEdicao({ alvo }) {
  const [cnpjSalvo, setCnpjSalvo] = useState(alvo.cnpj)
  const [campos, setCampos] = useState({ cnpj: formatarCnpj(alvo.cnpj), razao: alvo.razaoSocial, uf: alvo.uf, apelido: alvo.apelido || '' })
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [salvo, setSalvo] = useState(null)
  const { recarregar } = useResumo()
  const mudar = (nome) => (e) => setCampos((c) => ({ ...c, [nome]: e.target.value }))
  const [nome, setNome] = useState(alvo.apelido || alvo.razaoSocial)
  const titulo = `Editar ${nome}`

  async function salvar(e) {
    e.preventDefault()
    setEnviando(true)
    setErro(null)
    setSalvo(null)
    try {
      const r = await api.post(`/api/clientes/${cnpjSalvo}/editar`, { cnpj: campos.cnpj.replace(/\D/g, ''), razao: campos.razao.trim(), uf: campos.uf, apelido: campos.apelido.trim() })
      setCnpjSalvo(r.cnpj)
      setNome(campos.apelido.trim() || campos.razao.trim())
      setSalvo(r)
      recarregar()
    } catch (x) {
      setErro(x.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Pagina
      titulo={titulo}
      subtitulo="Dados da empresa. Mudar o nome também renomeia a pasta dela."
      trilha={[{ rotulo: 'Clientes', para: '/clientes' }, { rotulo: nome }, { rotulo: 'Editar' }]}
      erro={erro}
      aoFecharErro={() => setErro(null)}
      aviso={salvo ? [salvo.mensagem, ...salvo.avisos].join(' ') : null}
    >
      <form className="formulario" onSubmit={salvar}>
        <label className="campo">
          <span>CNPJ</span>
          <input value={campos.cnpj} onChange={mudar('cnpj')} required inputMode="numeric" autoComplete="off" />
        </label>
        <label className="campo">
          <span>Razão social</span>
          <input value={campos.razao} onChange={mudar('razao')} required autoComplete="off" />
        </label>
        <div className="linha-campos">
          <label className="campo campo-uf">
            <span>UF</span>
            <select value={campos.uf} onChange={mudar('uf')} required>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label className="campo">
            <span>Apelido (opcional)</span>
            <input value={campos.apelido} onChange={mudar('apelido')} maxLength={40} autoComplete="off" />
          </label>
        </div>
        <p className="formulario-nota">
          O CNPJ só muda em cliente sem notas e, com certificado, para matriz ou filial da mesma empresa.{' '}
          <Link to={`/clientes/${cnpjSalvo}/certificado`}>{alvo.temCertificado ? 'Trocar o certificado' : 'Adicionar o certificado'}</Link>
        </p>
        <div className="formulario-acoes">
          <button type="submit" className="botao botao-azul" disabled={enviando}>
            {enviando ? 'Salvando…' : 'Salvar'}
          </button>
          {VOLTAR}
        </div>
      </form>
    </Pagina>
  )
}

function EdicaoDoCliente({ cnpj }) {
  const { dados, erro } = useApi('/api/clientes')
  if (!dados) return <Pagina titulo="Editar cliente" subtitulo={erro ? '' : 'Carregando…'} erro={erro} />
  const cliente = dados.clientes.find((c) => c.cnpj === cnpj)
  if (!cliente) return <Pagina titulo="Editar cliente" subtitulo="Cliente não encontrado." trilha={[{ rotulo: 'Clientes', para: '/clientes' }, { rotulo: 'Editar' }]} />
  return <FormEdicao alvo={cliente} />
}

function CertificadoDoCliente({ cnpj }) {
  const { dados, erro } = useApi('/api/clientes')
  if (!dados) return <Pagina titulo="Certificado" subtitulo={erro ? '' : 'Carregando…'} erro={erro} />
  const cliente = dados.clientes.find((c) => c.cnpj === cnpj)
  if (!cliente) return <Pagina titulo="Certificado" subtitulo="Cliente não encontrado." trilha={[{ rotulo: 'Clientes', para: '/clientes' }]} />
  return <FormTroca alvo={cliente} />
}

function Escritorio() {
  const { dados, erro, carregando } = useApi('/api/escritorio')
  // O formulário escolhido na abertura fica: depois de cadastrar, o recibo não vira a tela de troca.
  const [existia, setExistia] = useState(undefined)
  if (existia === undefined && !carregando && !erro) setExistia(dados)
  if (existia === undefined) return <Pagina titulo="Escritório" subtitulo={erro ? '' : 'Carregando…'} erro={erro} />
  return existia ? <FormTroca alvo={existia} escritorio aoSalvar={(d) => setExistia((e) => ({ ...e, ...d }))} aoExcluir={() => setExistia(null)} /> : <FormNovo escritorio />
}

// Rotas #/clientes/novo, #/clientes/:cnpj/certificado e #/escritorio. Fora do computador do Smart Fiscal, só o aviso.
export default function Cadastro({ modo }) {
  const { resumo } = useResumo()
  const { cnpj } = useParams()
  if (!resumo) return <Pagina titulo="Cadastro" subtitulo="Carregando…" />
  if (!resumo.cadastroLiberado)
    return (
      <Pagina titulo="Cadastro" subtitulo="O cadastro só pode ser feito no computador onde o Smart Fiscal está instalado.">
        <p className="vazio">Por segurança, o certificado e a senha não passam pela rede. {VOLTAR}</p>
      </Pagina>
    )
  if (modo === 'escritorio') return <Escritorio />
  if (modo === 'certificado') return <CertificadoDoCliente key={cnpj} cnpj={cnpj} />
  if (modo === 'editar') return <EdicaoDoCliente key={cnpj} cnpj={cnpj} />
  return <FormNovo />
}
