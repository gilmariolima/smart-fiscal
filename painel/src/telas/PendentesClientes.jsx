import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useAoTerminarCaptura } from '../layout/ResumoProvider.jsx'
import { useApi } from '../useApi.js'
import { nomeDe } from '../useCliente.js'
import { cnpj, inteiro } from '../formato.js'

// Notas sem XML completo (canceladas fora): resumo, ciência dada sem XML e erro na ciência.
const semXml = (n) => (n?.resumo || 0) + (n?.ciencia || 0) + (n?.cienciaErro || 0)

// Atalho "XMLs não baixados" do Início: primeiro o cliente, depois a pasta dele com as notas.
export default function PendentesClientes() {
  const { dados, erro, carregando, recarregar } = useApi('/api/clientes')
  useAoTerminarCaptura(recarregar)
  const lista = (dados?.clientes || [])
    .filter((c) => semXml(c.notas) > 0)
    .sort((a, b) => semXml(b.notas) - semXml(a.notas) || nomeDe(a).localeCompare(nomeDe(b), 'pt-BR'))

  let conteudo
  if (carregando && !dados) conteudo = <p className="vazio">Carregando…</p>
  else if (!lista.length) conteudo = !erro && <p className="vazio">Nenhuma nota sem XML. Todas as notas estão completas.</p>
  else
    conteudo = (
      <>
        <div className="tabela-moldura">
          <table className="tabela">
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">CNPJ</th>
                <th scope="col" className="num">
                  Aguardando ciência
                </th>
                <th scope="col" className="num">
                  Sem XML
                </th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.cnpj}>
                  <td>
                    <Pasta para={`/notas/${c.cnpj}/pendentes`}>{nomeDe(c)}</Pasta>
                  </td>
                  <td className="sem-quebra">{cnpj(c.cnpj)}</td>
                  <td className="num">{inteiro(c.notas.resumo)}</td>
                  <td className="num">{inteiro(semXml(c.notas))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rodape-tabela">
          Mostrando 1 até {inteiro(lista.length)} de {inteiro(lista.length)}
        </p>
      </>
    )

  return (
    <Pagina
      titulo="XMLs não baixados"
      subtitulo="Clientes com notas que ainda não têm o XML completo. Escolha o cliente."
      trilha={[{ rotulo: 'Início', para: '/notas' }, { rotulo: 'XMLs não baixados' }]}
      erro={erro}
    >
      {conteudo}
    </Pagina>
  )
}
