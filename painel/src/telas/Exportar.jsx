import { useState } from 'react'
import ReciboExportacao from '../componentes/ReciboExportacao.jsx'
import Pagina from '../layout/Pagina.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { nomeDe } from '../useCliente.js'
import { NOMES_DOS_MESES, cnpj as formatarCnpj } from '../formato.js'


// "2026-10" → "Outubro de 2026"
function rotuloDaCompetencia(c) {
  const [ano, mes] = c.split('-')
  const nome = NOMES_DOS_MESES[Number(mes) - 1]?.toLowerCase()
  return nome ? `${nome[0].toUpperCase()}${nome.slice(1)} de ${ano}` : c
}

export default function Exportar() {
  const { dados: dadosClientes, erro: erroClientes } = useApi('/api/clientes')
  const { dados: competencias, erro: erroCompetencias } = useApi('/api/competencias')
  const [cnpj, setCnpj] = useState('')
  const [competencia, setCompetencia] = useState('')
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState(null)
  const [recibo, setRecibo] = useState(null)

  const clientes = dadosClientes?.clientes || []
  const lista = Array.isArray(competencias) ? competencias : []

  async function exportar(e) {
    e.preventDefault()
    setGerando(true)
    setErro(null)
    setRecibo(null)
    try {
      setRecibo(await api.post('/api/exportar', { cnpj, competencia }))
    } catch (err) {
      setErro(err.message)
    } finally {
      setGerando(false)
    }
  }

  return (
    <Pagina
      titulo="Exportar"
      subtitulo="Gera o pacote do mês (Domínio e Fortes) com os XMLs e o resumo.csv."
      erro={erro || erroClientes || erroCompetencias}
      aoFecharErro={erro ? () => setErro(null) : undefined}
    >
      <form className="formulario" onSubmit={exportar}>
        <label className="campo">
          <span>Cliente</span>
          <select
            value={cnpj}
            onChange={(e) => {
              setCnpj(e.target.value)
              setRecibo(null)
            }}
            required
          >
            <option value="">Escolha o cliente</option>
            {clientes.map((c) => (
              <option key={c.cnpj} value={c.cnpj}>
                {nomeDe(c)} · {formatarCnpj(c.cnpj)}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span>Competência</span>
          <select
            value={competencia}
            onChange={(e) => {
              setCompetencia(e.target.value)
              setRecibo(null)
            }}
            required
          >
            <option value="">Escolha o mês</option>
            {lista.map((c) => (
              <option key={c} value={c}>
                {rotuloDaCompetencia(c)}
              </option>
            ))}
          </select>
        </label>
        <div className="formulario-acoes">
          <button type="submit" className="botao botao-azul" disabled={gerando || !cnpj || !competencia}>
            {gerando ? 'Gerando…' : 'Exportar'}
          </button>
        </div>
      </form>
      {recibo && <ReciboExportacao r={recibo} aoFechar={() => setRecibo(null)} />}
    </Pagina>
  )
}
