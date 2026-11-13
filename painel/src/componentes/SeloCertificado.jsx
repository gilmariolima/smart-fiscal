import Etiqueta from './Etiqueta.jsx'
import { data, plural } from '../formato.js'

// Nome do titular do e-CPF sem o CPF ("JOANA SILVA:12345678901" → "JOANA SILVA"), nas duas primeiras palavras.
const nomeCurto = (titular) => String(titular || '').split(':')[0].trim().split(/\s+/).slice(0, 2).join(' ')

// Situação do certificado A1 do cliente: sem certificado, vencido, vencendo em menos de 30 dias ou no prazo.
// Sem A1 mas com procurador: verde como "No prazo", com o nome do procurador que tem procuração (quando já se sabe).
export default function SeloCertificado({ c, procurador = false }) {
  if (c.temCertificado === false) {
    if (!procurador) return <Etiqueta cor="cinza">Sem certificado</Etiqueta>
    return (
      <Etiqueta cor="verde" titulo={c.procurador ? `Procurador: ${String(c.procurador).split(':')[0]}` : 'NFS-e pelo certificado procurador'}>
        {c.procurador ? `pelo procurador: ${nomeCurto(c.procurador)}` : 'pelo procurador'}
      </Etiqueta>
    )
  }
  if (c.certDias === null || c.certDias === undefined) return '—'
  if (c.certDias < 0)
    return (
      <Etiqueta cor="vermelha" titulo={`Venceu em ${data(c.certValidade)}`}>
        Vencido
      </Etiqueta>
    )
  if (c.certDias < 30)
    return (
      <Etiqueta cor="ambar" titulo={`Válido até ${data(c.certValidade)}`}>
        {c.certDias === 0 ? 'Vence hoje' : `Vence em ${plural(c.certDias, 'dia', 'dias')}`}
      </Etiqueta>
    )
  return (
    <Etiqueta cor="verde" titulo={`Válido até ${data(c.certValidade)}`}>
      No prazo
    </Etiqueta>
  )
}
