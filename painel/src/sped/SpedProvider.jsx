import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { sped } from './api.js'

// Estado do inventário aberto no SPED (arquivos do cliente, dados digitados e o resultado).
// Fica acima das rotas: trocar de tela e voltar não perde o que estava sendo convertido.

const Contexto = createContext(null)

export const CAMPOS_VAZIOS = {
  nome: '', cnpj: '', ie: '', uf: '', cod_mun: '', data_inv: '', periodo: '', perfil: 'A', ind_ativ: '1',
  cep: '', end: '', num: '', compl: '', bairro: '', tipo_item: '00',
}
// Campos que o SPED exige: vazios depois de converter, ficam em vermelho
const OBRIGATORIOS = ['nome', 'cnpj', 'ie', 'uf', 'cod_mun', 'cep', 'end', 'bairro']

export function SpedProvider({ children }) {
  const [lote, setLote] = useState(null)
  const [arquivos, setArquivos] = useState([])
  const [principal, setPrincipal] = useState(null)
  const [campos, setCampos] = useState(CAMPOS_VAZIOS)
  const [faltando, setFaltando] = useState(new Set())
  const [res, setRes] = useState(null)
  const [processando, setProcessando] = useState('')
  const [avisos, setAvisos] = useState([])
  const [focar, setFocar] = useState(null)
  // O que a pessoa digitou fica: a conversão só preenche os campos que ela não mexeu
  const editados = useRef(new Set())
  const estado = useRef({})
  estado.current = { lote, arquivos, principal, campos }

  const aviso = useCallback((msg, tipo = 'ok') => {
    const id = Math.random()
    setAvisos((a) => [...a, { id, msg, tipo }])
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), 4000)
  }, [])

  const preencher = useCallback((novos, marcarFalta) => {
    setCampos((c) => {
      const prox = { ...c }
      for (const [k, v] of Object.entries(novos || {})) if (k in prox && !editados.current.has(k)) prox[k] = v ?? ''
      if (marcarFalta) setFaltando(new Set(OBRIGATORIOS.filter((k) => !String(prox[k] || '').trim())))
      return prox
    })
  }, [])

  const converter = useCallback(async ({ msg = 'Gerando o SPED…', lista, princ } = {}) => {
    const atual = estado.current
    const nomes = lista ?? atual.arquivos
    const escolhido = princ !== undefined ? princ : atual.principal
    if (!nomes.length) {
      setRes(null)
      return null
    }
    const digitados = {}
    editados.current.forEach((k) => (digitados[k] = atual.campos[k]))
    setProcessando(msg)
    const r = await sped('/api/converter', { method: 'POST', json: { lote: atual.lote, arquivos: nomes, principal: escolhido, campos: digitados } })
    setProcessando('')
    setPrincipal(r.principal || escolhido)
    if (r.erro) {
      // O formulário continua na tela: é nele que se resolve o erro (ex.: a data que o arquivo não traz)
      if (r.campos) preencher(r.campos, false)
      setFaltando(new Set(r.campo ? [r.campo] : []))
      setFocar(r.campo || null)
    } else {
      preencher(r.campos, true)
    }
    setRes(r)
    return r
  }, [preencher])

  const enviar = useCallback(async (lista) => {
    const novos = [...lista]
    if (!novos.length) return
    setProcessando('Enviando arquivos…')
    let { lote: l, arquivos: nomes } = estado.current
    if (!l) {
      const r = await sped('/api/lote', { method: 'POST' })
      if (r.erro) {
        setProcessando('')
        aviso(r.erro, 'erro')
        return
      }
      l = r.lote
      setLote(l)
      estado.current.lote = l
    }
    nomes = [...nomes]
    for (const f of novos) {
      const r = await sped(`/api/enviar?lote=${l}&nome=${encodeURIComponent(f.name)}`, { method: 'POST', corpo: f })
      if (r.erro) {
        aviso(`${f.name}: ${r.erro}`, 'erro')
        continue
      }
      if (!nomes.includes(r.nome)) nomes.push(r.nome)
    }
    setArquivos(nomes)
    estado.current.arquivos = nomes
    await converter({ lista: nomes })
  }, [aviso, converter])

  const novoCliente = useCallback(() => {
    setLote(null)
    setArquivos([])
    setPrincipal(null)
    setRes(null)
    setCampos(CAMPOS_VAZIOS)
    setFaltando(new Set())
    editados.current.clear()
  }, [])

  const tirar = useCallback(async (nome) => {
    const { lote: l, arquivos: nomes, principal: p } = estado.current
    await sped(`/api/enviar?lote=${l}&nome=${encodeURIComponent(nome)}`, { method: 'DELETE' })
    const resto = nomes.filter((a) => a !== nome)
    if (!resto.length) return novoCliente()
    const princ = p === nome ? null : p
    setArquivos(resto)
    estado.current.arquivos = resto
    return converter({ lista: resto, princ })
  }, [converter, novoCliente])

  const usarComoInventario = useCallback((nome) => {
    // Outro inventário: a data e o período vêm dele
    for (const k of ['data_inv', 'periodo']) editados.current.delete(k)
    return converter({ princ: nome })
  }, [converter])

  const digitar = useCallback((nome, valor) => {
    editados.current.add(nome)
    setCampos((c) => ({ ...c, [nome]: valor }))
    setFaltando((f) => {
      if (!f.has(nome)) return f
      const n = new Set(f)
      n.delete(nome)
      return n
    })
  }, [])

  const valor = useMemo(() => ({
    lote, arquivos, principal, campos, faltando, res, processando, avisos, focar,
    aviso, enviar, converter, novoCliente, tirar, usarComoInventario, digitar, setProcessando, limparFoco: () => setFocar(null),
  }), [lote, arquivos, principal, campos, faltando, res, processando, avisos, focar, aviso, enviar, converter, novoCliente, tirar, usarComoInventario, digitar])

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>
}

export const useSped = () => useContext(Contexto)
