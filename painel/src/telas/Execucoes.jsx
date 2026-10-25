import { useEffect } from 'react'
import Etiqueta from '../componentes/Etiqueta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura, useResumo } from '../layout/ResumoProvider.jsx'
import { useApi } from '../useApi.js'
import { cnpj, dataHora, inteiro } from '../formato.js'
import { explicarSefaz } from '../mensagensSefaz.js'

const TIPOS = { captura: 'Consulta', ciencia: 'Ciência', download: 'Download', exportacao: 'Exportação', backup: 'Backup' }
const SEM_SEFAZ = new Set(['exportacao', 'backup'])

function Linha({ e }) {
  return (
    <tr>
      <td className="sem-quebra">{dataHora(e.inicio)}</td>
      <td className="sem-quebra">{e.fim ? dataHora(e.fim) : <Etiqueta cor="ambar">Em andamento</Etiqueta>}</td>
      <td>{TIPOS[e.tipo] || e.tipo}</td>
      <td>
        {e.cliente_nome || '—'}
        {e.cnpj && <span className="secundario">{cnpj(e.cnpj)}</span>}
      </td>
      <td className="num">{inteiro(e.docs_recebidos)}</td>
      <td className="resultado">
        <Resultado e={e} />
      </td>
    </tr>
  )
}

function Resultado({ e }) {
  const explicacao = SEM_SEFAZ.has(e.tipo) ? null : explicarSefaz({ cStat: e.c_stat, xMotivo: e.x_motivo, erro: e.erro })
  if (explicacao) {
    return (
      <Etiqueta cor={explicacao.cor} titulo={explicacao.dica || e.erro || e.x_motivo || undefined}>
        {explicacao.titulo}
      </Etiqueta>
    )
  }
  return (
    <>
        {e.erro ? (
          <Etiqueta cor="vermelha" titulo={e.erro}>
            {e.erro}
          </Etiqueta>
        ) : (
          e.x_motivo || '—'
        )}
    </>
  )
}

export default function Execucoes() {
  const { resumo } = useResumo()
  const { dados, erro, carregando, recarregar } = useApi('/api/execucoes')

  useAoTerminarCaptura(recarregar)

  // Durante a captura, recarrega junto com o resumo (a cada 5 s).
  const capturando = !!resumo?.capturaEmAndamento
  const geradoEm = resumo?.geradoEm
  useEffect(() => {
    if (capturando) recarregar()
  }, [capturando, geradoEm, recarregar])

  const execucoes = dados || []
  let conteudo
  if (carregando && !dados) conteudo = <p className="vazio">Carregando…</p>
  else if (!execucoes.length) conteudo = !erro && <p className="vazio">Nenhuma execução ainda. A primeira captura aparece aqui assim que rodar.</p>
  else
    conteudo = (
      <>
        <div className="tabela-moldura">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Início</th>
                <th scope="col">Fim</th>
                <th scope="col">Tipo</th>
                <th scope="col">Cliente</th>
                <th scope="col" className="num">
                  Documentos
                </th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {execucoes.map((e) => (
                <Linha key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="rodape-tabela">
          Mostrando 1 até {inteiro(execucoes.length)} de {inteiro(execucoes.length)}
        </p>
      </>
    )

  return (
    <Pagina titulo="Execuções" subtitulo="Últimas 200 consultas, ciências, downloads, exportações e backups." erro={erro}>
      {conteudo}
    </Pagina>
  )
}
