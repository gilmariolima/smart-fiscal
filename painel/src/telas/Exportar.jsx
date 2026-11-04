import { useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import { api } from '../api.js'
import { NOMES_DOS_MESES, inteiro, plural } from '../formato.js'
import { useApi } from '../useApi.js'

const TIPOS = [
  { valor: 'nfe', rotulo: 'NF-e' },
  { valor: 'nfse', rotulo: 'NFS-e' },
  { valor: 'cte', rotulo: 'CT-e' },
]

const MESES = NOMES_DOS_MESES.map((rotulo, i) => ({ valor: String(i + 1).padStart(2, '0'), rotulo }))

function alternar(lista, valor) {
  return lista.includes(valor) ? lista.filter((v) => v !== valor) : [...lista, valor]
}

// Bloco de caixas de marcar; o que não tem nota aparece apagado, para nada mudar de lugar na tela.
function Grupo({ titulo, opcoes, marcados, aoMudar, disponiveis, acao, classe }) {
  return (
    <fieldset className={`exportar-grupo ${classe || ''}`}>
      <legend>{titulo}</legend>
      {acao}
      <div className="exportar-opcoes">
        {opcoes.map((o) => (
          <label key={o.valor} className={`exportar-opcao ${disponiveis && !disponiveis.has(o.valor) ? 'apagada' : ''}`}>
            <input type="checkbox" checked={marcados.includes(o.valor)} disabled={disponiveis && !disponiveis.has(o.valor)} onChange={() => aoMudar(alternar(marcados, o.valor))} />
            <span>{o.rotulo}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export default function Exportar() {
  const { dados, erro: erroOpcoes } = useApi('/api/exportacao/opcoes')
  const [tipos, setTipos] = useState([])
  const [anos, setAnos] = useState([])
  const [meses, setMeses] = useState([])
  const [clientes, setClientes] = useState([])
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState(null)

  const notas = dados?.notas || []
  const listaClientes = dados?.clientes || []
  const listaAnos = [...new Set(notas.map((n) => n.competencia.slice(0, 4)))].sort().reverse().map((a) => ({ valor: a, rotulo: a }))

  // Mês só fica disponível se tiver nota nos anos marcados (sem ano marcado, em qualquer ano).
  const mesesComNota = new Set(notas.filter((n) => !anos.length || anos.includes(n.competencia.slice(0, 4))).map((n) => n.competencia.slice(5, 7)))
  const mesesValidos = meses.filter((m) => mesesComNota.has(m))
  const competencias = anos.flatMap((a) => mesesValidos.map((m) => `${a}-${m}`))

  const total = notas
    .filter((n) => tipos.includes(n.modelo) && competencias.includes(n.competencia) && clientes.includes(n.clienteId))
    .reduce((soma, n) => soma + n.total, 0)

  const todosMarcados = listaClientes.length > 0 && clientes.length === listaClientes.length

  async function exportar() {
    setGerando(true)
    setErro(null)
    try {
      await api.baixar('/api/exportacao/zip', { modelos: tipos, competencias, clientes })
    } catch (e) {
      setErro(e.message)
    } finally {
      setGerando(false)
    }
  }

  return (
    <Pagina
      titulo="Exportar"
      subtitulo="Monte um ZIP com o PDF e o XML das notas: separado por tipo, ano, mês e cliente."
      erro={erro || erroOpcoes}
      aoFecharErro={erro ? () => setErro(null) : undefined}
      acoes={
        <button type="button" className="botao botao-verde" disabled={!total || gerando} onClick={exportar}>
          <i className="fa-solid fa-file-zipper" aria-hidden="true" /> {gerando ? 'Gerando o ZIP…' : `Exportar (${plural(total, 'nota', 'notas')})`}
        </button>
      }
    >
      {!dados ? (
        !erroOpcoes && <p className="vazio">Carregando…</p>
      ) : !notas.length ? (
        <p className="vazio">Ainda não há notas com XML para exportar.</p>
      ) : (
        <div className="cartao exportar">
          <Grupo titulo="Tipo de nota" opcoes={TIPOS} marcados={tipos} aoMudar={setTipos} disponiveis={new Set(notas.map((n) => n.modelo))} />
          <Grupo titulo="Ano" opcoes={listaAnos} marcados={anos} aoMudar={setAnos} />
          <Grupo titulo="Mês" classe="exportar-meses" opcoes={MESES} marcados={mesesValidos} aoMudar={setMeses} disponiveis={mesesComNota} />
          <Grupo
            titulo={`Clientes (${inteiro(listaClientes.length)})`}
            classe="exportar-clientes"
            opcoes={listaClientes.map((c) => ({ valor: c.id, rotulo: c.nome }))}
            marcados={clientes}
            aoMudar={setClientes}
            acao={
              <button type="button" className="botao botao-claro exportar-todos" onClick={() => setClientes(todosMarcados ? [] : listaClientes.map((c) => c.id))}>
                {todosMarcados ? 'Desmarcar todos' : 'Marcar todos'}
              </button>
            }
          />
        </div>
      )}
    </Pagina>
  )
}
