import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

// GET com estado de carga. Ao trocar de caminho os dados antigos somem; ao recarregar ficam até chegar a resposta.
export function useApi(caminho, deps = []) {
  const [estado, setEstado] = useState({ dados: null, erro: null, carregando: !!caminho })
  const [versao, setVersao] = useState(0)
  const caminhoAnterior = useRef(caminho)

  useEffect(() => {
    if (!caminho) return undefined
    let ativo = true
    const mesmoCaminho = caminhoAnterior.current === caminho
    caminhoAnterior.current = caminho
    setEstado((e) => ({ dados: mesmoCaminho ? e.dados : null, erro: null, carregando: true }))
    api.get(caminho).then(
      (dados) => ativo && setEstado({ dados, erro: null, carregando: false }),
      (e) => ativo && setEstado((s) => ({ dados: s.dados, erro: e.message, carregando: false })),
    )
    return () => {
      ativo = false
    }
  }, [caminho, versao, ...deps])

  const recarregar = useCallback(() => setVersao((v) => v + 1), [])
  return { ...estado, recarregar }
}
