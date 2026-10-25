export const inteiro = (v) => Number(v || 0).toLocaleString('pt-BR')

export const plural = (n, um, varios) => `${inteiro(n)} ${n === 1 ? um : varios}`

export const cnpj = (c) =>
  /^\d{14}$/.test(c || '') ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : c || ''

export const dataHora = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

// "hoje às 13:00", "amanhã às 08:00" ou "12/10 às 13:00"
export function quando(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const hoje = new Date()
  const diferenca = Math.round((dia - new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86400e3)
  if (diferenca === 0) return `hoje às ${hora}`
  if (diferenca === 1) return `amanhã às ${hora}`
  if (diferenca === -1) return `ontem às ${hora}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hora}`
}

export function nomeDoAmbiente(ambiente) {
  if (!ambiente) return ''
  if (ambiente.sefazSimulada) return 'Simulada'
  return ambiente.producao ? 'Produção' : 'Homologação'
}

// Destinatário de saída pode ser pessoa física (CPF).
export const documento = (d) =>
  /^\d{11}$/.test(d || '') ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cnpj(d)

export const dinheiro = (v) =>
  v === null || v === undefined ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// "2026-10-11T09:30:00-03:00" → "11/10/2026" (sem passar por fuso)
export function data(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')

// "2027-03-15..." → "03/2027"
export function mesAno(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '')
  return m ? `${m[2]}/${m[1]}` : ''
}

export const NOMES_DOS_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
