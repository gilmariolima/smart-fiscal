import { useCallback, useState } from 'react'

// Conjunto de ids marcados na tela. Vale entre páginas e zera sozinho quando a chave do filtro muda.
export function useSelecao(chaveDoFiltro) {
  const [estado, setEstado] = useState(() => ({ chave: chaveDoFiltro, ids: new Set() }))
  let atual = estado
  if (estado.chave !== chaveDoFiltro) {
    atual = { chave: chaveDoFiltro, ids: new Set() }
    setEstado(atual)
  }

  const mudar = useCallback((fn) => {
    setEstado((e) => {
      const ids = new Set(e.ids)
      fn(ids)
      return { ...e, ids }
    })
  }, [])

  const alternar = useCallback((id) => mudar((ids) => (ids.has(id) ? ids.delete(id) : ids.add(id))), [mudar])
  const marcar = useCallback((lista) => mudar((ids) => lista.forEach((id) => ids.add(id))), [mudar])
  const desmarcar = useCallback((lista) => mudar((ids) => lista.forEach((id) => ids.delete(id))), [mudar])
  const limpar = useCallback(() => setEstado((e) => ({ ...e, ids: new Set() })), [])

  return { ids: atual.ids, alternar, marcar, desmarcar, limpar, tamanho: atual.ids.size }
}
