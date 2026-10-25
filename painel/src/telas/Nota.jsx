import { useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import CodigoBarras from '../componentes/CodigoBarras.jsx'
import Etiqueta from '../componentes/Etiqueta.jsx'
import { data, dataHora, dinheiro, documento, NOMES_DOS_MESES } from '../formato.js'
import Pagina from '../layout/Pagina.jsx'
import { useApi } from '../useApi.js'

// Número com casas fixas no padrão brasileiro; vazio quando não veio no XML.
const num = (v, casas = 2) =>
  v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

// Quantidade e valor unitário: até 4 casas, sem zeros sobrando.
const qtd = (v, minimo = 0) =>
  v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: minimo, maximumFractionDigits: 4 })

const chaveEmGrupos = (c) => (c || '').replace(/(\d{4})(?=\d)/g, '$1 ')

const cep = (c) => (/^\d{8}$/.test(c || '') ? `${c.slice(0, 5)}-${c.slice(5)}` : c || '')

function enderecoEmLinha(e) {
  if (!e) return ''
  const rua = [e.logradouro, e.numero].filter(Boolean).join(', ')
  return [rua, e.complemento, e.bairro].filter(Boolean).join(' - ')
}

function Quadro({ rotulo, children, classe = '' }) {
  return (
    <div className={`quadro ${classe}`}>
      <span className="quadro-rotulo">{rotulo}</span>
      <span className="quadro-valor">{children || ' '}</span>
    </div>
  )
}

function Situacao({ nota }) {
  if (nota.cancelada) return <Etiqueta cor="vermelha">Cancelada</Etiqueta>
  if (nota.status === 'completa') return <Etiqueta cor="verde">Autorizada · XML completo</Etiqueta>
  return <Etiqueta cor="ambar">Só o resumo</Etiqueta>
}

function Pessoa({ titulo, p, extra }) {
  return (
    <section className="danfe-bloco">
      <h2>{titulo}</h2>
      <div className="quadros">
        <Quadro rotulo="Nome / razão social" classe="largo">
          {p.nome}
        </Quadro>
        <Quadro rotulo="CNPJ / CPF" classe="mono">
          {documento(p.documento)}
        </Quadro>
        <Quadro rotulo="Inscrição estadual" classe="mono">
          {p.ie}
        </Quadro>
        <Quadro rotulo="Endereço" classe="largo">
          {enderecoEmLinha(p.endereco)}
        </Quadro>
        <Quadro rotulo="Município">{p.endereco?.municipio}</Quadro>
        <Quadro rotulo="UF">{p.endereco?.uf}</Quadro>
        <Quadro rotulo="CEP" classe="mono">
          {cep(p.endereco?.cep)}
        </Quadro>
        {extra}
      </div>
    </section>
  )
}

function Danfe({ nfe, nota }) {
  const { ide, protocolo, emitente, destinatario, itens, totais, transporte, cobranca, pagamentos, informacoes } = nfe
  const end = emitente?.endereco
  return (
    <article className="danfe">
      <section className="danfe-topo">
        <div className="danfe-emitente">
          <strong>{emitente?.nome}</strong>
          {emitente?.fantasia && emitente.fantasia !== emitente.nome && <span>{emitente.fantasia}</span>}
          <span>{enderecoEmLinha(end)}</span>
          <span>
            {[end?.municipio, end?.uf].filter(Boolean).join(' - ')} {cep(end?.cep)}
          </span>
          {end?.telefone && <span>Fone: {end.telefone}</span>}
        </div>
        <div className="danfe-titulo">
          <strong>DANFE</strong>
          <span>Documento auxiliar da nota fiscal eletrônica</span>
          <span className="danfe-tipo">
            {ide.tipo === 'entrada' ? '0 - Entrada' : ide.tipo === 'saida' ? '1 - Saída' : ''}
          </span>
          <strong>Nº {ide.numero}</strong>
          <span>Série {ide.serie}</span>
        </div>
        <div className="danfe-chave">
          <CodigoBarras digitos={ide.chave} />
          <span className="quadro-rotulo">Chave de acesso</span>
          <span className="mono">{chaveEmGrupos(ide.chave)}</span>
          <span className="danfe-consulta">Consulta de autenticidade no portal nacional da NF-e (www.nfe.fazenda.gov.br).</span>
        </div>
      </section>

      <div className="quadros">
        <Quadro rotulo="Natureza da operação" classe="largo">
          {ide.naturezaOperacao}
        </Quadro>
        <Quadro rotulo="Protocolo de autorização" classe="largo mono">
          {protocolo ? `${protocolo.numero} - ${dataHora(protocolo.data)}` : ''}
        </Quadro>
        <Quadro rotulo="Inscrição estadual" classe="mono">
          {emitente?.ie}
        </Quadro>
        <Quadro rotulo="CNPJ" classe="mono">
          {documento(emitente?.documento)}
        </Quadro>
        <Quadro rotulo="Situação">
          <Situacao nota={nota} />
        </Quadro>
      </div>

      {destinatario && (
        <Pessoa
          titulo="Destinatário / remetente"
          p={destinatario}
          extra={
            <>
              <Quadro rotulo="Data de emissão">{data(ide.dataEmissao)}</Quadro>
              <Quadro rotulo="Data de saída/entrada">{data(ide.dataSaida)}</Quadro>
              {ide.finalidade && ide.finalidade !== 'Normal' && <Quadro rotulo="Finalidade">{ide.finalidade}</Quadro>}
            </>
          }
        />
      )}

      {(cobranca.fatura || cobranca.duplicatas.length > 0 || pagamentos.length > 0) && (
        <section className="danfe-bloco">
          <h2>Fatura / duplicatas</h2>
          <div className="quadros">
            {cobranca.fatura && (
              <Quadro rotulo="Fatura" classe="linha-inteira">
                Nº {cobranca.fatura.numero} · original {dinheiro(cobranca.fatura.valorOriginal)} · desconto {dinheiro(cobranca.fatura.desconto)} ·
                líquido {dinheiro(cobranca.fatura.valorLiquido)}
              </Quadro>
            )}
            {cobranca.duplicatas.map((d) => (
              <Quadro key={d.numero} rotulo={`Duplicata ${d.numero}`}>
                {data(d.vencimento)} · {dinheiro(d.valor)}
              </Quadro>
            ))}
            {pagamentos.map((p, i) => (
              <Quadro key={i} rotulo="Pagamento">
                {p.forma} · {dinheiro(p.valor)}
              </Quadro>
            ))}
          </div>
        </section>
      )}

      <section className="danfe-bloco">
        <h2>Cálculo do imposto</h2>
        <div className="quadros quadros-numeros">
          <Quadro rotulo="Base de cálculo do ICMS">{num(totais.baseIcms)}</Quadro>
          <Quadro rotulo="Valor do ICMS">{num(totais.icms)}</Quadro>
          <Quadro rotulo="Base de cálculo ICMS ST">{num(totais.baseSt)}</Quadro>
          <Quadro rotulo="Valor do ICMS ST">{num(totais.st)}</Quadro>
          <Quadro rotulo="Valor total dos produtos">{num(totais.produtos)}</Quadro>
          <Quadro rotulo="Valor do frete">{num(totais.frete)}</Quadro>
          <Quadro rotulo="Valor do seguro">{num(totais.seguro)}</Quadro>
          <Quadro rotulo="Desconto">{num(totais.desconto)}</Quadro>
          <Quadro rotulo="Outras despesas">{num(totais.outras)}</Quadro>
          <Quadro rotulo="Valor do IPI">{num(totais.ipi)}</Quadro>
          <Quadro rotulo="Valor do PIS">{num(totais.pis)}</Quadro>
          <Quadro rotulo="Valor da COFINS">{num(totais.cofins)}</Quadro>
          {totais.tributosAproximados !== null && <Quadro rotulo="Tributos aproximados">{num(totais.tributosAproximados)}</Quadro>}
          <Quadro rotulo="Valor total da nota" classe="destaque">
            {num(totais.total)}
          </Quadro>
        </div>
      </section>

      <section className="danfe-bloco">
        <h2>Transportador / volumes transportados</h2>
        <div className="quadros">
          <Quadro rotulo="Nome / razão social" classe="largo">
            {transporte.transportadora?.nome}
          </Quadro>
          <Quadro rotulo="Frete por conta">{transporte.modalidade}</Quadro>
          <Quadro rotulo="CNPJ / CPF" classe="mono">
            {documento(transporte.transportadora?.documento)}
          </Quadro>
          <Quadro rotulo="Inscrição estadual" classe="mono">
            {transporte.transportadora?.ie}
          </Quadro>
          <Quadro rotulo="Endereço" classe="largo">
            {transporte.transportadora?.endereco}
          </Quadro>
          <Quadro rotulo="Município">{transporte.transportadora?.municipio}</Quadro>
          <Quadro rotulo="UF">{transporte.transportadora?.uf}</Quadro>
          {transporte.veiculo && (
            <Quadro rotulo="Placa do veículo" classe="mono">
              {[transporte.veiculo.placa, transporte.veiculo.uf].filter(Boolean).join(' - ')}
            </Quadro>
          )}
          {transporte.volumes.map((v, i) => (
            <Quadro key={i} rotulo={transporte.volumes.length > 1 ? `Volumes (${i + 1})` : 'Volumes'} classe="largo">
              {[
                v.quantidade !== null && `${qtd(v.quantidade)} ${v.especie || ''}`.trim(),
                v.marca && `marca ${v.marca}`,
                v.numeracao && `nº ${v.numeracao}`,
                v.pesoBruto !== null && `peso bruto ${qtd(v.pesoBruto)} kg`,
                v.pesoLiquido !== null && `peso líquido ${qtd(v.pesoLiquido)} kg`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Quadro>
          ))}
        </div>
      </section>

      <section className="danfe-bloco">
        <h2>Dados dos produtos / serviços</h2>
        <div className="tabela-rolagem">
          <table className="tabela-produtos">
            <thead>
              <tr>
                <th>Código</th>
                <th>Descrição</th>
                <th>NCM</th>
                <th>CST</th>
                <th>CFOP</th>
                <th>Un.</th>
                <th className="num">Qtd.</th>
                <th className="num">V. unit.</th>
                <th className="num">V. total</th>
                <th className="num">BC ICMS</th>
                <th className="num">V. ICMS</th>
                <th className="num">V. IPI</th>
                <th className="num">% ICMS</th>
                <th className="num">% IPI</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.numero}>
                  <td className="mono">{it.codigo}</td>
                  <td className="descricao">{it.descricao}</td>
                  <td className="mono">{it.ncm}</td>
                  <td className="mono">{it.cst}</td>
                  <td className="mono">{it.cfop}</td>
                  <td>{it.unidade}</td>
                  <td className="num">{qtd(it.quantidade)}</td>
                  <td className="num">{qtd(it.valorUnitario, 2)}</td>
                  <td className="num">{num(it.valorTotal)}</td>
                  <td className="num">{num(it.baseIcms)}</td>
                  <td className="num">{num(it.valorIcms)}</td>
                  <td className="num">{num(it.valorIpi)}</td>
                  <td className="num">{num(it.aliquotaIcms)}</td>
                  <td className="num">{num(it.aliquotaIpi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(informacoes.complementar || informacoes.fisco) && (
        <section className="danfe-bloco">
          <h2>Dados adicionais</h2>
          <div className="quadros">
            {informacoes.complementar && (
              <Quadro rotulo="Informações complementares" classe="linha-inteira texto-livre">
                {informacoes.complementar}
              </Quadro>
            )}
            {informacoes.fisco && (
              <Quadro rotulo="Reservado ao fisco" classe="linha-inteira texto-livre">
                {informacoes.fisco}
              </Quadro>
            )}
          </div>
        </section>
      )}
    </article>
  )
}

// Nota que só tem o resumo da SEFAZ: mostra o que o banco sabe.
function Resumo({ nota }) {
  return (
    <section className="danfe-bloco">
      <h2>Dados do resumo</h2>
      <div className="quadros">
        <Quadro rotulo="Emitente" classe="largo">
          {nota.emitente_nome}
        </Quadro>
        <Quadro rotulo="CNPJ do emitente" classe="mono">
          {documento(nota.emitente_cnpj)}
        </Quadro>
        <Quadro rotulo="Inscrição estadual" classe="mono">
          {nota.emitente_ie}
        </Quadro>
        <Quadro rotulo="Número / série">{[nota.numero, nota.serie].filter(Boolean).join(' / ')}</Quadro>
        <Quadro rotulo="Data de emissão">{data(nota.data_emissao)}</Quadro>
        <Quadro rotulo="Valor total" classe="destaque">
          {dinheiro(nota.valor_total)}
        </Quadro>
        <Quadro rotulo="Situação">
          <Situacao nota={nota} />
        </Quadro>
        <Quadro rotulo="Chave de acesso" classe="largo mono">
          {chaveEmGrupos(nota.chave)}
        </Quadro>
      </div>
    </section>
  )
}

function Eventos({ eventos }) {
  if (!eventos.length) return null
  return (
    <section className="danfe-bloco danfe-eventos">
      <h2>Eventos da nota</h2>
      <div className="tabela-rolagem">
        <table className="tabela-produtos">
          <thead>
            <tr>
              <th>Data</th>
              <th>Evento</th>
              <th>Protocolo</th>
            </tr>
          </thead>
          <tbody>
            {eventos.map((e) => (
              <tr key={`${e.tp_evento}-${e.n_seq}`}>
                <td className="sem-quebra">{dataHora(e.data_evento)}</td>
                <td>{e.descricao || e.tp_evento}</td>
                <td className="mono">{e.protocolo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function Nota() {
  const { cnpj, id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { dados, erro, carregando } = useApi(`/api/notas/${encodeURIComponent(id)}/detalhe`)
  const nota = dados?.nota
  // Número e emitente do XML quando houver; senão, os do resumo.
  const numero = dados?.nfe?.ide.numero || nota?.numero || ''
  const emitente = dados?.nfe?.emitente?.nome || nota?.emitente_nome || ''
  const [ano, mes] = (nota?.competencia || '').split('-')
  const pastaDoMes = ano ? `/notas/${cnpj}/${ano}/${mes}` : `/notas/${cnpj}`

  // "Imprimir DANFE" do menu da nota: abre a impressão assim que a nota carrega, uma vez só.
  const imprimir = params.get('imprimir') === '1'
  useEffect(() => {
    if (!imprimir || !dados) return
    setParams({}, { replace: true })
    if (dados.nfe) setTimeout(() => window.print(), 300)
  }, [imprimir, dados])

  // Voltar mantém os filtros da lista quando se veio dela; link direto cai na pasta do mês.
  const voltar = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(pastaDoMes))

  const trilha = [
    { rotulo: 'Início', para: '/notas' },
    { rotulo: nota?.cliente_nome || cnpj, para: `/notas/${cnpj}` },
    ...(ano
      ? [
          { rotulo: ano, para: `/notas/${cnpj}/${ano}` },
          { rotulo: NOMES_DOS_MESES[Number(mes) - 1] || mes, para: pastaDoMes },
        ]
      : []),
    { rotulo: `Nota ${numero}`.trim() },
  ]

  const acoes = (
    <>
      <button type="button" className="botao botao-claro" onClick={voltar}>
        Voltar
      </button>
      {nota?.tem_xml ? (
        <a className="botao botao-claro" href={`/api/notas/${nota.id}/xml`} download={`${nota.chave}-nfe.xml`}>
          Baixar XML
        </a>
      ) : null}
      {dados?.nfe && (
        <button type="button" className="botao botao-azul" onClick={() => window.print()}>
          Imprimir / PDF
        </button>
      )}
    </>
  )

  let conteudo = null
  if (!dados) conteudo = carregando && <p className="vazio">Carregando…</p>
  else if (dados.nfe) conteudo = <Danfe nfe={dados.nfe} nota={nota} />
  else
    conteudo = (
      <>
        <p className="faixa faixa-ambar" role="status">
          {dados.erroXml ||
            (nota.cancelada
              ? 'Nota cancelada pelo emitente: a SEFAZ não entrega o XML completo.'
              : 'XML completo ainda não disponível: a SEFAZ só mandou o resumo. Ele chega depois da ciência da operação.')}
        </p>
        <Resumo nota={nota} />
      </>
    )

  return (
    <Pagina
      titulo={`NF-e ${numero}`.trim()}
      subtitulo={nota ? `${nota.tipo === 'saida' ? 'Saída' : 'Entrada'} · ${emitente}` : ''}
      trilha={trilha}
      acoes={acoes}
      erro={erro}
    >
      {conteudo}
      {dados && <Eventos eventos={dados.eventos} />}
    </Pagina>
  )
}
