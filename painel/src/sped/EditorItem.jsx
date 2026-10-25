import { useEffect, useRef, useState } from 'react'
import { milhar, sped, TIPOS_ITEM } from './api.js'
import Modal from './Modal.jsx'
import { useSped } from './SpedProvider.jsx'

const CAMPOS = ['codigo', 'descricao', 'ncm', 'unidade', 'tipo', 'qtd', 'vl_unit']
// O cursor vai para o campo da primeira pendência
const CAMPO_DA_PENDENCIA = [[/NCM/, 'ncm'], [/sem quantidade|fracionada|quantidade zero/, 'qtd'], [/sem valor|unitário|negativo/, 'vl_unit'],
  [/unidade/, 'unidade'], [/tipo do item/, 'tipo'], [/código/, 'codigo']]

export default function EditorItem({ item: i, aoFechar }) {
  const { lote, campos: empresa, res, converter, aviso } = useSped()
  // O que aparece no formulário é o valor atual; só o que mudar vira correção
  const atuais = useRef({
    codigo: i.c, descricao: i.d === '(sem descrição no arquivo)' ? '' : i.d, ncm: i.n, unidade: i.u,
    tipo: i.t || res?.campos?.tipo_item || '00', qtd: milhar(i.q), vl_unit: milhar(i.vu),
  }).current
  const [valores, setValores] = useState(atuais)
  const form = useRef(null)

  useEffect(() => {
    const pend = i.p.join(' ')
    const campo = CAMPO_DA_PENDENCIA.find(([re]) => re.test(pend))
    form.current?.elements[campo ? campo[1] : 'descricao']?.focus()
  }, [i])

  async function salvar(corrigidos) {
    const r = await sped('/api/ajustar', { method: 'POST', json: { lote, chave: i.k, campos: corrigidos, cnpj: empresa.cnpj } })
    if (r.erro) return aviso(r.erro, 'erro')
    aoFechar()
    const nova = await converter({ msg: 'Gerando de novo com a correção…' })
    if (nova && !nova.erro) aviso(Object.keys(corrigidos).length ? 'Item corrigido e SPED gerado de novo' : 'Correção desfeita')
  }

  function enviar(e) {
    e.preventDefault()
    const corrigidos = {}
    for (const k of CAMPOS) {
      const v = String(valores[k] ?? '').trim()
      if (v && v !== String(atuais[k] ?? '')) corrigidos[k] = v
    }
    // Nada mudou: fecha sem gerar de novo (as correções já salvas continuam)
    if (!Object.keys(corrigidos).length) return aoFechar()
    salvar(corrigidos)
  }

  const campo = (nome, props = {}) => (
    <input className="entrada" name={nome} value={valores[nome] ?? ''} onChange={(e) => setValores((v) => ({ ...v, [nome]: e.target.value }))} {...props} />
  )

  return (
    <Modal titulo={<>Corrigir item <span className="codigo">{i.c}</span></>} aoFechar={aoFechar} classe="modal-item">
      <form ref={form} autoComplete="off" onSubmit={enviar}>
        <div className="item-corpo">
          {i.p.length > 0 && (
            <div className="avisos-sped">
              {i.p.map((m) => <p key={m}><i className="fa-solid fa-triangle-exclamation" /><span>{m}</span></p>)}
            </div>
          )}
          <div className="grupo">
            <label><span className="rot">Código</span>{campo('codigo', { maxLength: 60, spellCheck: false })}</label>
            <label className="larga3"><span className="rot">Descrição</span>{campo('descricao', { maxLength: 200 })}</label>
            <label><span className="rot">NCM</span>{campo('ncm', { inputMode: 'numeric', maxLength: 10, placeholder: '8 dígitos' })}</label>
            <label><span className="rot">Unidade</span>{campo('unidade', { maxLength: 6 })}</label>
            <label className="larga">
              <span className="rot">Tipo do item</span>
              <select className="entrada" name="tipo" value={valores.tipo} onChange={(e) => setValores((v) => ({ ...v, tipo: e.target.value }))}>
                {TIPOS_ITEM.map(([v, n]) => <option key={v} value={v}>{v} · {n}</option>)}
              </select>
            </label>
            <label><span className="rot">Quantidade</span>{campo('qtd', { inputMode: 'decimal' })}</label>
            <label><span className="rot">Valor unitário</span>{campo('vl_unit', { inputMode: 'decimal' })}</label>
          </div>
          <p className="item-nota">
            Código, descrição, NCM, unidade e tipo ficam guardados para os próximos inventários desta empresa. Quantidade e valor valem só para este.
          </p>
        </div>
        <div className="modal-pe">
          {i.a.length > 0 && <button type="button" className="botao botao-claro" onClick={() => salvar({})}>Desfazer correção</button>}
          <span className="espaco" />
          <button type="button" className="botao botao-claro" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="botao botao-azul">Salvar e gerar de novo</button>
        </div>
      </form>
    </Modal>
  )
}
