import { useState } from 'react'
import { Link, useParams } from 'react-router'
import SituacaoNota from '../componentes/SituacaoNota.jsx'
import Pagina from '../layout/Pagina.jsx'
import { api } from '../api.js'
import { useApi } from '../useApi.js'
import { useNomeDoCliente } from '../useCliente.js'
import { cnpj as formatarCnpj, data, dinheiro, plural } from '../formato.js'

const ROTULOS = { nfe: 'NF-e', nfse: 'NFS-e' }

// Notas que chegaram na última captura de um cliente (link "Ver notas" da tela Capturar).
export default function NotasNovas() {
  const { modelo, cnpj } = useParams()
  const rotulo = ROTULOS[modelo] || 'NF-e'
  const nome = useNomeDoCliente(cnpj)
  const { dados, erro: erroLista } = useApi(`/api/notas?${new URLSearchParams({ cnpj, modelo: ROTULOS[modelo] ? modelo : 'nfe', novas: '1', ordem: 'emissao-desc' })}`)
  const [erro, setErro] = useState(null)
  const [baixando, setBaixando] = useState(false)

  const notas = dados?.notas || []
  const comXml = notas.filter((n) => n.status === 'completa')
  // A contraparte: quem emitiu nas entradas, quem recebeu nas saídas.
  const outraParte = (n) => (n.tipo === 'saida' ? { nome: n.destinatario_nome, cnpj: n.destinatario_cnpj } : { nome: n.emitente_nome, cnpj: n.emitente_cnpj })

  async function baixar() {
    setBaixando(true)
    setErro(null)
    try {
      await api.baixar('/api/notas/zip', { ids: comXml.map((n) => n.id) })
    } catch (e) {
      setErro(e.message)
    } finally {
      setBaixando(false)
    }
  }

  let conteudo
  if (!dados) conteudo = !erroLista && <p className="vazio">Carregando…</p>
  else if (!notas.length) conteudo = <p className="vazio">Nenhuma nota nova na última captura.</p>
  else
    conteudo = (
      <div className="tabela-moldura">
        <table className="tabela tabela-novas">
          <thead>
            <tr>
              <th scope="col">Número</th>
              <th scope="col">Emissão</th>
              <th scope="col">Tipo</th>
              <th scope="col">Emitente / destinatário</th>
              <th scope="col" className="num">
                Valor
              </th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            {notas.map((n) => {
              const parte = outraParte(n)
              return (
                <tr key={n.id}>
                  <td className="mono">
                    <Link to={`/notas/${cnpj}/nota/${n.id}`}>{n.numero || '—'}</Link>
                  </td>
                  <td className="sem-quebra">{data(n.data_emissao)}</td>
                  <td>{n.tipo === 'saida' ? 'Saída' : 'Entrada'}</td>
                  <td className="nome-cliente">
                    {parte.nome || '—'}
                    {parte.cnpj && <span className="secundario mono">{formatarCnpj(parte.cnpj)}</span>}
                  </td>
                  <td className="num sem-quebra">{dinheiro(n.valor_total)}</td>
                  <td className="sem-quebra">
                    <SituacaoNota nota={n} limite={dados.limiteTentativas} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )

  return (
    <Pagina
      titulo={`${rotulo} novas`}
      subtitulo={dados ? `${nome} · ${plural(dados.total, 'nota recebida', 'notas recebidas')} na última captura` : nome}
      trilha={[{ rotulo: 'Capturar', para: `/capturar/${modelo}` }, { rotulo: nome }]}
      acoes={
        comXml.length > 0 && (
          <button type="button" className="botao botao-verde" onClick={baixar} disabled={baixando}>
            {baixando ? 'Baixando…' : `⬇ Baixar XMLs (${comXml.length})`}
          </button>
        )
      }
      erro={erro || erroLista}
      aoFecharErro={erro ? () => setErro(null) : undefined}
    >
      {conteudo}
    </Pagina>
  )
}
