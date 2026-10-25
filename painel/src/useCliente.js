import { useApi } from './useApi.js'

// Nome de exibição do cliente: apelido, senão razão social. Enquanto carrega (ou se não achar), cai no CNPJ.
export const nomeDe = (c) => c.apelido || c.razaoSocial || c.cnpj

export function useNomeDoCliente(cnpj) {
  const { dados } = useApi('/api/clientes')
  const cliente = dados?.clientes?.find((c) => c.cnpj === cnpj)
  return cliente ? nomeDe(cliente) : cnpj
}
