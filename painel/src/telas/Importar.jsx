import { useRef, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import { api } from '../api.js'
import { bytesBase64 } from '../arquivoBase64.js'
import { plural } from '../formato.js'

const MOTIVOS = {
  'cnpj-nao-cadastrado': 'CNPJ não cadastrado em Clientes',
  'nao-xml': 'não é XML',
  'nao-suportado': 'tipo não suportado (só NF-e, NFS-e e CT-e)',
  'sem-protocolo': 'nota sem autorização da SEFAZ',
  homologacao: 'nota de homologação (teste)',
  invalido: 'XML ilegível',
  'zip-invalido': 'ZIP corrompido',
  'arquivo-grande': 'grande demais para ser uma nota',
  'zip-grande-demais': 'ZIP grande demais: importe o resto em outra vez',
  'erro-gravacao': 'não foi possível gravar na pasta (veja o log)',
}

const TIPOS = [
  ['nfe', 'NF-e'],
  ['cte', 'CT-e'],
  ['nfse', 'NFS-e'],
]

// "NF-e: 120 entradas, 30 saídas" — só o que teve nota.
function linhaDoTipo(rotulo, q) {
  const partes = [
    q.entrada > 0 && plural(q.entrada, 'entrada', 'entradas'),
    q.saida > 0 && plural(q.saida, 'saída', 'saídas'),
    q.outro > 0 && `${q.outro} em Outros`,
  ].filter(Boolean)
  return partes.length ? `${rotulo}: ${partes.join(', ')}` : null
}

function Resultado({ r }) {
  const linhas = TIPOS.map(([tipo, rotulo]) => linhaDoTipo(rotulo, r.importadas[tipo] || {})).filter(Boolean)
  const nada = !linhas.length && !r.eventos && !r.semCliente
  return (
    <div className="cartao importar-resultado" role="status">
      {linhas.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {nada && <p>Nenhuma nota nova.</p>}
      {r.eventos > 0 && <p>{plural(r.eventos, 'evento', 'eventos')}</p>}
      {r.semCliente > 0 && <p>{r.semCliente} sem cliente cadastrado (vão para o cliente quando ele for cadastrado)</p>}
      {r.jaExistiam > 0 && <p>{plural(r.jaExistiam, 'já estava', 'já estavam')} no Smart Fiscal.</p>}
      {r.ignoradas.length > 0 && (
        <>
          <p>{plural(r.ignoradas.length, 'arquivo ignorado', 'arquivos ignorados')}:</p>
          <ul className="importar-ignoradas">
            {r.ignoradas.map((i, n) => (
              <li key={n}>
                <span className="importar-nome">{i.nome}</span> — {MOTIVOS[i.motivo] || i.motivo}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default function Importar() {
  const entrada = useRef(null)
  const [enviando, setEnviando] = useState(false)
  const [arrastando, setArrastando] = useState(false)
  const [erro, setErro] = useState('')
  const [resultado, setResultado] = useState(null)

  async function enviar(lista) {
    const arquivos = [...lista]
    if (!arquivos.length || enviando) return
    setErro('')
    setResultado(null)
    setEnviando(true)
    try {
      const corpo = { arquivos: await Promise.all(arquivos.map(async (a) => ({ nome: a.name, base64: await bytesBase64(a) }))) }
      setResultado(await api.post('/api/importar', corpo))
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
      if (entrada.current) entrada.current.value = ''
    }
  }

  return (
    <Pagina titulo="Importar XMLs" subtitulo="NF-e, NFS-e e CT-e obtidas fora do Smart Fiscal" erro={erro} aoFecharErro={() => setErro('')}>
      <p className="importar-texto">Solte aqui XMLs de NF-e, NFS-e ou CT-e, ou um ZIP com eles.</p>
      <button
        type="button"
        className={`cartao importar-area${arrastando ? ' importar-area-ativa' : ''}`}
        disabled={enviando}
        onClick={() => entrada.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setArrastando(true)
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault()
          setArrastando(false)
          enviar(e.dataTransfer.files)
        }}
      >
        <i className="fa-solid fa-file-arrow-up" aria-hidden="true" />
        <span>{enviando ? 'Importando…' : 'Arraste XMLs ou um ZIP aqui, ou clique para escolher'}</span>
      </button>
      <input ref={entrada} type="file" multiple accept=".xml,.zip" hidden onChange={(e) => enviar(e.target.files)} />
      {resultado && <Resultado r={resultado} />}
    </Pagina>
  )
}
