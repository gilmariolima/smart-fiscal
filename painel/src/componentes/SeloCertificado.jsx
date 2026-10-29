import Etiqueta from './Etiqueta.jsx'
import { data, plural } from '../formato.js'

// Situação do certificado A1 do cliente: vencido, vencendo em menos de 30 dias ou no prazo.
export default function SeloCertificado({ c }) {
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
