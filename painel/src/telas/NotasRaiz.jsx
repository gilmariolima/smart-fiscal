import { useState } from 'react'
import Pasta from '../componentes/Pasta.jsx'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'
import { nomeDe } from '../useCliente.js'
import { cnpj, inteiro } from '../formato.js'

function filtrar(clientes, busca) {
  const texto = busca.trim().toLowerCase()
  const digitos = texto.replace(/\D/g, '')
  const lista = clientes.filter(
    (c) =>
      !texto ||
      nomeDe(c).toLowerCase().includes(texto) ||
      (c.razaoSocial || '').toLowerCase().includes(texto) ||
      (digitos && c.cnpj.includes(digitos)),
  )
  // Ativos primeiro; dentro de cada grupo, ordem alfabética.
  return lista.sort((a, b) => Number(!a.ativo) - Number(!b.ativo) || nomeDe(a).localeCompare(nomeDe(b), 'pt-BR'))
}

function Linha({ c }) {
  return (
    <tr className={c.ativo ? undefined : 'inativo'}>
      <td>
        <Pasta para={`/notas/${c.cnpj}`}>{nomeDe(c)}</Pasta>
        {!c.ativo && <span className="secundario">Desativado</span>}
      </td>
      <td className="sem-quebra">{cnpj(c.cnpj)}</td>
    </tr>
  )
}

export default function NotasRaiz() {
  const [busca, setBusca] = useState('')
  const { dados, erro, carregando } = useApi('/api/clientes')
  const todos = dados?.clientes || []
  const lista = filtrar(todos, busca)

  let conteudo
  if (carregando && !dados) conteudo = <p className="vazio">Carregando…</p>
  else if (!todos.length) conteudo = !erro && <p className="vazio">Nenhum cliente cadastrado ainda.</p>
  else
    conteudo = (
      <>
        <div className="busca">
          <label htmlFor="busca-cliente">Buscar cliente</label>
          <input
            id="busca-cliente"
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Nome ou CNPJ"
            autoComplete="off"
          />
        </div>
        {lista.length ? (
          <>
            <div className="tabela-moldura">
              <table className="tabela">
                <thead>
                  <tr>
                    <th scope="col">Cliente</th>
                    <th scope="col">CNPJ</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((c) => (
                    <Linha key={c.cnpj} c={c} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rodape-tabela">
              Mostrando 1 até {inteiro(lista.length)} de {inteiro(lista.length)}
            </p>
          </>
        ) : (
          <p className="vazio">Nenhum cliente encontrado para essa busca.</p>
        )}
      </>
    )

  return (
    <Pagina titulo="NF-es" subtitulo="Escolha o cliente." erro={erro}>
      {conteudo}
    </Pagina>
  )
}
