import { useEffect, useState } from 'react'
import Pagina from '../layout/Pagina.jsx'
import { sped } from './api.js'
import { useSped } from './SpedProvider.jsx'

// Contabilista do registro 0100 do SPED (sem ele o PVA recusa o arquivo).
const CAMPOS = [
  ['nome', 'Nome do contabilista', 'd2'], ['cpf', 'CPF', '', 'numeric'], ['crc', 'CRC'],
  ['cnpj', 'CNPJ do escritório', 'd2'], ['email', 'E-mail', 'd2'], ['end', 'Endereço', 'd2'],
  ['num', 'Número'], ['compl', 'Complemento'], ['bairro', 'Bairro'], ['cep', 'CEP', '', 'numeric'],
  ['fone', 'Telefone', '', 'numeric'], ['cod_mun', 'Município (IBGE)', '', 'numeric'],
]

export default function Contador() {
  const { aviso, arquivos, converter } = useSped()
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState('')
  useEffect(() => {
    sped('/api/escritorio').then((r) => (r.erro ? setErro(r.erro) : setDados(r)))
  }, [])

  async function salvar(e) {
    e.preventDefault()
    const r = await sped('/api/escritorio', { method: 'POST', json: dados })
    if (r.erro) return aviso(r.erro, 'erro')
    aviso('Dados do contador salvos')
    if (arquivos.length) converter()
  }

  return (
    <Pagina titulo="Contador do SPED" subtitulo="Contabilista do registro 0100: sai em todo SPED gerado" erro={erro}>
      {dados && (
        <form className="cartao form-contador" autoComplete="off" onSubmit={salvar}>
          {CAMPOS.map(([nome, rotulo, classe, modo]) => (
            <label key={nome} className={classe || undefined}>
              <span className="rot">{rotulo}</span>
              <input className="entrada" name={nome} inputMode={modo} maxLength={nome === 'cod_mun' ? 7 : undefined}
                type={nome === 'email' ? 'email' : 'text'} value={dados[nome] || ''} onChange={(e) => setDados((d) => ({ ...d, [nome]: e.target.value }))} />
            </label>
          ))}
          <div className="pe"><button type="submit" className="botao botao-azul">Salvar</button></div>
        </form>
      )}
    </Pagina>
  )
}
