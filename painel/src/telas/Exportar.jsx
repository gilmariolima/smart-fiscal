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

const CONTEUDOS = [
  { valor: 'pdf', rotulo: 'PDF das notas' },
  { valor: 'xml', rotulo: 'XML das notas' },
  { valor: 'relatorio', rotulo: 'Relatório em PDF' },
  { valor: 'excel', rotulo: 'Relatório em Excel' },
]
const TUDO = 'tudo'

function alternar(lista, valor) {
  return lista.includes(valor) ? lista.filter((v) => v !== valor) : [...lista, valor]
}

// Acima disso, com PDF das notas, avisa antes de gerar. Cada PDF leva cerca de 0,1 s (174 notas em 18 s, com os dados reais).
const NOTAS_PARA_AVISAR = 1000
const SEGUNDOS_POR_NOTA = 0.1

const semAcento = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Empresas numa caixa de altura fixa, com rolagem própria: com 3 ou 500, o resto da tela fica no mesmo lugar.
function Empresas({ empresas, marcadas, aoMudar }) {
  const [busca, setBusca] = useState('')
  const texto = semAcento(busca.trim())
  const digitos = texto.replace(/\D/g, '')
  const visiveis = empresas.filter((e) => !texto || semAcento(e.nome).includes(texto) || (digitos && e.cnpj.includes(digitos)))
  const filtrando = visiveis.length < empresas.length

  return (
    <fieldset className="exportar-grupo exportar-clientes">
      <legend>Empresas ({inteiro(empresas.length)})</legend>
      <div className="exportar-empresas-topo">
        <input className="entrada" type="search" aria-label="Buscar empresa" placeholder="Buscar por nome ou CNPJ" autoComplete="off" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <span className="exportar-empresas-conta">
          {inteiro(marcadas.length)} de {inteiro(empresas.length)} marcadas
          {filtrando && ` · ${inteiro(visiveis.length)} na busca`}
        </span>
        <span className="exportar-empresas-acoes">
          {/* Com busca, soma às que já estão marcadas. */}
          <button type="button" className="botao botao-claro" disabled={!visiveis.length} onClick={() => aoMudar([...new Set([...marcadas, ...visiveis.map((e) => e.id)])])}>
            {!filtrando ? 'Marcar todas' : visiveis.length === 1 ? 'Marcar a da busca' : `Marcar as ${inteiro(visiveis.length)} da busca`}
          </button>
          <button type="button" className="botao botao-claro" disabled={!marcadas.length} onClick={() => aoMudar([])}>
            Desmarcar todas
          </button>
        </span>
      </div>
      <div className="exportar-empresas-lista">
        {visiveis.length ? (
          <div className="exportar-opcoes">
            {visiveis.map((e) => (
              <label key={e.id} className="exportar-opcao" title={e.nome}>
                <input type="checkbox" checked={marcadas.includes(e.id)} onChange={() => aoMudar(alternar(marcadas, e.id))} />
                <span>{e.nome}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="exportar-empresas-vazio">Nenhuma empresa encontrada para essa busca.</p>
        )}
      </div>
    </fieldset>
  )
}

// Bloco de caixas de marcar; o que não tem nota aparece apagado, para nada mudar de lugar na tela.
function Grupo({ titulo, opcoes, marcados, aoMudar, disponiveis, classe }) {
  return (
    <fieldset className={`exportar-grupo ${classe || ''}`}>
      <legend>{titulo}</legend>
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
  const [clientes, setClientes] = useState([])
  const [tipos, setTipos] = useState([])
  const [anos, setAnos] = useState([])
  const [meses, setMeses] = useState([])
  const [conteudos, setConteudos] = useState([])
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

  const minutos = Math.ceil((total * SEGUNDOS_POR_NOTA) / 60)
  const grande = total >= NOTAS_PARA_AVISAR && conteudos.includes('pdf')

  // "Tudo" marca e desmarca os outros; fica marcado sozinho quando os quatro estão marcados.
  const tudoMarcado = conteudos.length === CONTEUDOS.length
  function mudarConteudos(lista) {
    if (lista.includes(TUDO) !== tudoMarcado) return setConteudos(tudoMarcado ? [] : CONTEUDOS.map((c) => c.valor))
    setConteudos(lista.filter((v) => v !== TUDO))
  }

  async function exportar() {
    setGerando(true)
    setErro(null)
    try {
      await api.baixar('/api/exportacao/zip', { clientes, modelos: tipos, competencias, incluir: conteudos })
    } catch (e) {
      setErro(e.message)
    } finally {
      setGerando(false)
    }
  }

  return (
    <Pagina
      titulo="Exportar"
      subtitulo="Monte um ZIP separado por empresa, ano, mês e tipo."
      erro={erro || erroOpcoes}
      aoFecharErro={erro ? () => setErro(null) : undefined}
      acoes={
        <button type="button" className="botao botao-verde" disabled={!total || !conteudos.length || gerando} onClick={exportar}>
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
          <Empresas empresas={listaClientes} marcadas={clientes} aoMudar={setClientes} />
          <Grupo titulo="Ano" opcoes={listaAnos} marcados={anos} aoMudar={setAnos} />
          <Grupo titulo="Mês" classe="exportar-meses" opcoes={MESES} marcados={mesesValidos} aoMudar={setMeses} disponiveis={mesesComNota} />
          <Grupo titulo="Tipo de nota" opcoes={TIPOS} marcados={tipos} aoMudar={setTipos} disponiveis={new Set(notas.map((n) => n.modelo))} />
          <Grupo titulo="O que exportar" opcoes={[...CONTEUDOS, { valor: TUDO, rotulo: 'Tudo' }]} marcados={tudoMarcado ? [...conteudos, TUDO] : conteudos} aoMudar={mudarConteudos} />
        </div>
      )}
      {grande && (
        <div className="faixa faixa-ambar exportar-aviso" role="status">
          <span>
            Exportação grande: {plural(total, 'nota', 'notas')} com PDF podem levar cerca de {plural(minutos, 'minuto', 'minutos')}. Deixe o Smart Fiscal aberto até o ZIP baixar.
          </span>
        </div>
      )}
    </Pagina>
  )
}
