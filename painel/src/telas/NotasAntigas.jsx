import { useEffect, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { plural } from '../formato.js'

const SITUACOES = {
  fila: 'Na fila',
  baixada: 'Baixada',
  'ja-existia': 'Já estava no Smart Fiscal',
  'nao-envolvido': 'Certificado não é de envolvido',
  'nao-nfe': 'Não é NF-e',
  erro: 'Erro',
}

const emBlocos = (chave) => chave.match(/.{1,4}/g).join(' ')
const horaMinuto = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function Andamento({ estado, agora }) {
  if (!estado.total) return <p className="antigas-andamento">Nenhuma chave na fila.</p>
  let texto
  if (estado.pausada) texto = 'Pausado'
  else if (estado.voltaAs) texto = `SVRS pediu pausa: volta às ${horaMinuto(estado.voltaAs)}`
  else if (estado.motivo) texto = estado.motivo
  else if (!estado.pendentes) texto = 'Fila concluída'
  else if (estado.rodando) texto = 'Consultando a SVRS…'
  else if (estado.proximaEm) texto = `próxima em ${Math.max(0, Math.round((new Date(estado.proximaEm) - agora) / 1000))} s`
  else texto = 'Aguardando'
  return (
    <p className="antigas-andamento">
      <strong>
        {estado.total - estado.pendentes} de {estado.total}
      </strong>{' '}
      · {texto}
    </p>
  )
}

export default function NotasAntigas() {
  const clientes = useApi('/api/clientes')
  const [situacao, setSituacao] = useState('')
  const fila = useApi(`/api/busca-antiga${situacao ? `?situacao=${situacao}` : ''}`)
  const [cnpj, setCnpj] = useState('')
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState('')
  const [aviso, setAviso] = useState('')
  const [agora, setAgora] = useState(() => new Date())

  const estado = fila.dados?.estado
  const pendentes = estado?.pendentes || 0
  const { recarregar } = fila

  // Enquanto há fila: lista a cada 5 s e o "próxima em" a cada segundo.
  useEffect(() => {
    if (!pendentes) return undefined
    const lista = setInterval(recarregar, 5000)
    const relogio = setInterval(() => setAgora(new Date()), 1000)
    return () => {
      clearInterval(lista)
      clearInterval(relogio)
    }
  }, [pendentes, recarregar])

  const comCertificado = (clientes.dados?.clientes || []).filter((c) => c.temCertificado && !c.escritorio)

  async function buscar(e) {
    e.preventDefault()
    setErro('')
    setAviso('')
    setEnviando(true)
    try {
      const r = await api.post('/api/busca-antiga', { cnpj, texto })
      const partes = [r.repetidas > 0 && plural(r.repetidas, 'repetida ignorada', 'repetidas ignoradas'), r.naoNfe > 0 && plural(r.naoNfe, 'não é NF-e', 'não são NF-e')].filter(Boolean)
      setAviso(`${plural(r.adicionadas, 'chave na fila', 'chaves na fila')}${partes.length ? ` (${partes.join(', ')})` : ''}`)
      setTexto('')
      recarregar()
    } catch (e2) {
      setErro(e2.message)
    } finally {
      setEnviando(false)
    }
  }

  async function acao(caminho) {
    setErro('')
    try {
      await api.post(`/api/busca-antiga/${caminho}`, {})
      recarregar()
    } catch (e) {
      setErro(e.message)
    }
  }

  const linhas = fila.dados?.linhas || []
  return (
    <Pagina titulo="Notas antigas" subtitulo="NF-e com mais de 90 dias, pela SVRS" erro={erro || fila.erro} aoFecharErro={() => setErro('')}>
      <form className="cartao antigas-form" onSubmit={buscar}>
        <label className="campo">
          <span>Cliente</span>
          <select value={cnpj} onChange={(e) => setCnpj(e.target.value)} required>
            <option value="">Escolha o cliente</option>
            {comCertificado.map((c) => (
              <option key={c.cnpj} value={c.cnpj}>
                {c.apelido || c.razaoSocial}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span>Cole as chaves de acesso (uma por linha ou como vierem)</span>
          <textarea className="antigas-chaves" rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} required spellCheck={false} />
        </label>
        <div className="antigas-acoes">
          {aviso && <span className="antigas-aviso">{aviso}</span>}
          <button type="submit" className="botao botao-azul" disabled={enviando || !cnpj || !texto.trim()}>
            {enviando ? 'Enviando…' : 'Buscar'}
          </button>
        </div>
      </form>

      {estado && (
        <div className="antigas-barra">
          <Andamento estado={estado} agora={agora} />
          <div className="antigas-botoes">
            <label className="campo-situacao">
              <select value={situacao} onChange={(e) => setSituacao(e.target.value)} aria-label="Filtrar por situação">
                <option value="">Todas</option>
                {Object.entries(SITUACOES).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="botao botao-claro" onClick={() => acao('limpar')}>
              Limpar concluídas
            </button>
            {estado.pausada ? (
              <button type="button" className="botao botao-verde" onClick={() => acao('continuar')}>
                Continuar
              </button>
            ) : (
              <button type="button" className="botao botao-claro" onClick={() => acao('pausar')}>
                Pausar
              </button>
            )}
          </div>
        </div>
      )}

      {linhas.length > 0 && (
        <div className="tabela-moldura">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">Chave</th>
                <th scope="col">Situação</th>
                <th scope="col">Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.id}>
                  <td>{l.nome}</td>
                  <td className="antigas-chave">{emBlocos(l.chave)}</td>
                  <td className={`antigas-situacao antigas-${l.situacao}`}>{SITUACOES[l.situacao] || l.situacao}</td>
                  <td className="antigas-mensagem">{l.mensagem || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Pagina>
  )
}
