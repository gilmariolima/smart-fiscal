import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api.js'
import Pagina from '../layout/Pagina.jsx'
import { useResumo } from '../layout/ResumoProvider.jsx'
import { sped } from '../sped/api.js'
import { useApi } from '../useApi.js'

const EXPLICACAO = {
  xmls: 'Os XMLs baixados, por cliente, ano e mês, separados em NF-e e NFS-e, entradas e saídas (CNPJ_Cliente\\AAAA\\MM\\NF-e\\Entradas). Ao trocar, os XMLs já baixados vão junto.',
  exports: 'Os ZIPs criados na tela Exportar. Ao trocar, os ZIPs que já estão lá vão junto.',
  sped: 'Os arquivos do SPED, separados por empresa e mês do inventário. Ao trocar, os próximos vão para a pasta nova; os de antes ficam onde estão.',
}

// Uma pasta: onde está, Abrir e Trocar (com o campo para o endereço novo).
function Pasta({ titulo, explicacao, pasta, ehPadrao, soNoPc, ocupado, aoAbrir, aoSalvar }) {
  const [texto, setTexto] = useState(null)
  const trocando = texto !== null
  const salvar = async (valor) => {
    if (await aoSalvar(valor)) setTexto(null)
  }
  return (
    <section className="formulario" aria-label={titulo}>
      <strong className="formulario-titulo">{titulo}</strong>
      <p className="formulario-nota">{explicacao}</p>
      {trocando ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            salvar(texto)
          }}
        >
          <label className="campo">
            <span>Endereço da pasta nova</span>
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="D:\Fiscal ou \\servidor\fiscal"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="formulario-acoes">
            <button type="submit" className="botao botao-azul" disabled={ocupado || !texto.trim()}>
              {ocupado ? 'Movendo…' : 'Salvar pasta'}
            </button>
            {!ehPadrao && (
              <button type="button" className="botao botao-claro" onClick={() => salvar('')} disabled={ocupado}>
                Usar a pasta padrão
              </button>
            )}
            <button type="button" className="botao botao-claro" onClick={() => setTexto(null)} disabled={ocupado}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="pasta-linha">
          <p className="pasta-atual">
            <i className="fa-solid fa-folder" /> <span className="mono">{pasta || '—'}</span>
            {ehPadrao && ' (padrão)'}
          </p>
          <button type="button" className="botao botao-claro" onClick={aoAbrir} disabled={soNoPc || !pasta}>
            <i className="fa-solid fa-folder-open" /> Abrir
          </button>
          {!soNoPc && (
            <button type="button" className="botao botao-claro" onClick={() => setTexto(pasta || '')} disabled={ocupado}>
              Trocar pasta
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// #/pastas: onde ficam os arquivos que o escritório usa (XMLs, exportações, SPED) e o botão para trocar.
export default function Pastas() {
  const { dados: estado, erro: erroCarga, recarregar } = useApi('/api/pastas')
  const { dados: pastaSped, recarregar: recarregarSped } = useApi('/estoque/api/pasta')
  const { dados: backup } = useApi('/api/backup')
  const { resumo } = useResumo()
  const [ocupado, setOcupado] = useState(null)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const soNoPc = resumo && !resumo.cadastroLiberado

  async function executar(nome, fn) {
    setOcupado(nome)
    setErro(null)
    setAviso(null)
    try {
      setAviso(await fn())
      return true
    } catch (e) {
      setErro(e.message)
      return false
    } finally {
      setOcupado(null)
    }
  }

  const salvarNotas = (tipo) => (valor) =>
    executar(tipo, async () => {
      try {
        return (await api.post('/api/pastas', { tipo, pasta: valor })).mensagem
      } finally {
        recarregar()
      }
    })
  const salvarSped = (valor) =>
    executar('sped', async () => {
      const r = await sped('/api/pasta', { method: 'POST', json: { pasta_saida: valor } })
      recarregarSped()
      if (r.erro) throw new Error(r.erro)
      return r.eh_padrao ? 'Arquivos do SPED: voltou para a pasta padrão.' : 'Pasta dos arquivos do SPED salva.'
    })
  const abrir = (tipo) => () =>
    executar(null, async () => {
      if (tipo === 'sped') {
        const r = await sped('/api/abrir-pasta', { method: 'POST' })
        if (r.erro) throw new Error(r.erro)
      } else await api.post('/api/pastas/abrir', { tipo })
      return null
    })

  if (!estado) return <Pagina titulo="Pastas" subtitulo={erroCarga ? '' : 'Carregando…'} erro={erroCarga} />

  return (
    <Pagina
      titulo="Pastas"
      subtitulo="Onde ficam os arquivos que o escritório usa. Dá para levar cada um para uma pasta mais fácil de achar, para outro disco ou para a rede."
      erro={erro}
      aoFecharErro={() => setErro(null)}
      aviso={aviso}
    >
      {estado.pastas.map((p) => (
        <Pasta
          key={p.tipo}
          titulo={p.nome}
          explicacao={EXPLICACAO[p.tipo]}
          pasta={p.pasta}
          ehPadrao={p.ehPadrao}
          soNoPc={soNoPc}
          ocupado={ocupado === p.tipo || estado.movendo === p.tipo}
          aoAbrir={abrir(p.tipo)}
          aoSalvar={salvarNotas(p.tipo)}
        />
      ))}
      {pastaSped && !pastaSped.erro && (
        <Pasta
          titulo="Arquivos do SPED"
          explicacao={EXPLICACAO.sped}
          pasta={pastaSped.pasta_saida}
          ehPadrao={pastaSped.eh_padrao}
          soNoPc={soNoPc}
          ocupado={ocupado === 'sped'}
          aoAbrir={abrir('sped')}
          aoSalvar={salvarSped}
        />
      )}
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
