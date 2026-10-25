import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

export const EVENTO_CAPTURA_TERMINOU = 'smartdoc:captura-terminou'

const INTERVALO_CAPTURANDO = 5000
const INTERVALO_PARADO = 60000

const ContextoResumo = createContext({ resumo: null, erro: null, recarregar: () => {} })

export function ResumoProvider({ children }) {
  const [resumo, setResumo] = useState(null)
  const [erro, setErro] = useState(null)
  const [versao, setVersao] = useState(0)
  const capturando = useRef(false)

  const recarregar = useCallback(() => setVersao((v) => v + 1), [])

  useEffect(() => {
    let ativo = true
    let timer = null
    api
      .get('/api/resumo')
      .then(
        (r) => {
          if (!ativo) return
          if (capturando.current && !r.capturaEmAndamento) window.dispatchEvent(new Event(EVENTO_CAPTURA_TERMINOU))
          capturando.current = r.capturaEmAndamento
          setResumo(r)
          setErro(null)
        },
        (e) => ativo && setErro(e.message),
      )
      .finally(() => {
        if (ativo) timer = setTimeout(recarregar, capturando.current ? INTERVALO_CAPTURANDO : INTERVALO_PARADO)
      })
    return () => {
      ativo = false
      clearTimeout(timer)
    }
  }, [versao, recarregar])

  return <ContextoResumo.Provider value={{ resumo, erro, recarregar }}>{children}</ContextoResumo.Provider>
}

export const useResumo = () => useContext(ContextoResumo)

// Roda `aoTerminar` quando uma captura em andamento acaba (as telas recarregam os dados).
export function useAoTerminarCaptura(aoTerminar) {
  const ultimo = useRef(aoTerminar)
  ultimo.current = aoTerminar
  useEffect(() => {
    const ouvir = () => ultimo.current()
    window.addEventListener(EVENTO_CAPTURA_TERMINOU, ouvir)
    return () => window.removeEventListener(EVENTO_CAPTURA_TERMINOU, ouvir)
  }, [])
}
