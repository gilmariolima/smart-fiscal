// Acesso ao motor do SPED (Python), que o servidor repassa em /estoque. Devolve sempre um
// objeto: com `erro` quando falha, como as telas do SPED esperam (o motor também responde assim).
export async function sped(caminho, { method = 'GET', json, corpo } = {}) {
  const cabecalhos = { Accept: 'application/json' }
  if (method !== 'GET') cabecalhos['X-Painel'] = '1'
  if (json !== undefined) cabecalhos['Content-Type'] = 'application/json'
  let r
  try {
    r = await fetch(`/estoque${caminho}`, { method, headers: cabecalhos, body: json !== undefined ? JSON.stringify(json) : corpo })
  } catch {
    return { erro: 'Sem conexão com o Smart Fiscal. Ele está aberto?' }
  }
  const dados = await r.json().catch(() => ({ erro: 'Resposta inválida do motor do SPED.' }))
  if (!r.ok && !dados.erro) dados.erro = `Falha na comunicação com o motor do SPED (${r.status}).`
  return dados
}

export const baixar = (nome) => `/estoque/baixar/${encodeURIComponent(nome)}`

// "1234567,890" → "1.234.567,890" (o motor manda os números já com vírgula decimal)
export const milhar = (v) => {
  if (v === '' || v == null) return ''
  const [i, d] = String(v).split(',')
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (d !== undefined ? ',' + d : '')
}

export const TIPOS_ITEM = [
  ['00', 'Mercadoria para revenda'], ['01', 'Matéria-prima'], ['02', 'Embalagem'], ['03', 'Produto em processo'],
  ['04', 'Produto acabado'], ['05', 'Subproduto'], ['06', 'Produto intermediário'], ['07', 'Material de uso e consumo'],
  ['08', 'Ativo imobilizado'], ['10', 'Outros insumos'], ['99', 'Outras'],
]
