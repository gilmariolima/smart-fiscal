import Etiqueta from './Etiqueta.jsx'

// Situação da nota na lista do mês e na tela de XMLs não baixados.
export const esgotada = (n, limite) => n.status === 'esgotada' || (n.status === 'ciencia_enviada' && n.tentativas_download >= limite)

export const podeReprocessar = (n, limite) => n.tipo === 'entrada' && !n.cancelada && (n.status === 'ciencia_erro' || esgotada(n, limite))

export default function SituacaoNota({ nota: n, limite }) {
  if (n.cancelada) return <Etiqueta cor="vermelha">Cancelada</Etiqueta>
  if (n.status === 'completa') return <Etiqueta cor="verde">XML completo</Etiqueta>
  if (n.status === 'ciencia_erro')
    return (
      <Etiqueta cor="vermelha" titulo={n.ciencia_erro}>
        Erro na ciência
      </Etiqueta>
    )
  if (esgotada(n, limite))
    return (
      <Etiqueta cor="cinza" titulo={`Sem XML após ${limite} tentativas de download.`}>
        Esgotada
      </Etiqueta>
    )
  if (n.status === 'ciencia_enviada')
    return (
      <Etiqueta cor="ambar" titulo={`${n.tentativas_download} de ${limite} tentativas de download`}>
        Aguardando XML
      </Etiqueta>
    )
  return <Etiqueta cor="ambar">Aguardando ciência</Etiqueta>
}
