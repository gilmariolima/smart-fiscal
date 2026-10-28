// Traduz o retorno da SEFAZ (código cStat + texto) para quem usa o painel: um título curto,
// a cor da etiqueta e o que fazer. O texto original continua no banco e no logs/app.log.
// Devolve null quando não reconhece o retorno; aí a tela mostra o texto original.

import { plural } from './formato.js'

const SEM_CONEXAO =/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|timeout|Network Error/i

const POR_CODIGO = {
  128: { cor: 'verde', titulo: 'Lote de ciência processado' },
  135: { cor: 'verde', titulo: 'Ciência registrada' },
  136: { cor: 'verde', titulo: 'Ciência registrada' },
  137: { cor: 'verde', titulo: 'Nenhuma nota nova', dica: 'Normal. A SEFAZ pede 1 hora até a próxima consulta deste CNPJ.' },
  138: { cor: 'verde', titulo: 'Notas recebidas' },
  573: { cor: 'verde', titulo: 'Ciência já registrada', dica: 'Outro sistema já tinha dado ciência nesta nota. Está tudo certo.' },
  108: { cor: 'ambar', titulo: 'SEFAZ fora do ar', dica: 'O serviço da SEFAZ está paralisado. A próxima captura tenta de novo.' },
  109: { cor: 'ambar', titulo: 'SEFAZ fora do ar', dica: 'O serviço da SEFAZ está paralisado. A próxima captura tenta de novo.' },
}

const O_QUE_E_EVENTO = 'ciência, cancelamento ou carta de correção de notas já emitidas'

// O que uma captura bem-sucedida trouxe. Um 138 pode trazer só eventos: aí não há nota nova.
// `notas`/`eventos` null = captura gravada antes dessa separação; só se sabe o total.
export function resumoDaCaptura({ cStat, docs = 0, notas = null, eventos = null } = {}) {
  if (String(cStat) === '137' || !docs) return { cor: 'cinza', titulo: 'Nenhuma nota nova', detalhe: 'A SEFAZ não tinha nada novo para este CNPJ.' }
  if (notas === null) {
    return { cor: 'verde', titulo: plural(docs, 'documento recebido', 'documentos recebidos'), detalhe: `Notas ou eventos (${O_QUE_E_EVENTO}).` }
  }
  if (!notas) {
    return {
      cor: 'cinza',
      titulo: 'Nenhuma nota nova',
      detalhe: `Vieram só ${plural(eventos, 'evento', 'eventos')}: ${O_QUE_E_EVENTO}. Evento não vira nota nova na lista.`,
    }
  }
  return {
    cor: 'verde',
    titulo: plural(notas, 'nota recebida', 'notas recebidas'),
    detalhe: eventos ? `Também ${eventos === 1 ? 'veio 1 evento' : `vieram ${plural(eventos, 'evento', 'eventos')}`}: ${O_QUE_E_EVENTO}.` : null,
  }
}

// Última captura de NF-e + de NFS-e juntas, para a coluna Última captura dos Clientes.
// Captura de NF-e antiga (sem a separação notas/eventos) volta ao texto de resumoDaCaptura.
export function resumoDasCapturas(nfe, nfse) {
  const nNfe = !nfe || String(nfe.cStat) === '137' || !nfe.docs ? 0 : nfe.notas
  const nNfse = nfse?.notas || 0
  const semSeparacao = nNfe === null || nNfe === undefined
  const linha = `NF-e: ${semSeparacao ? plural(nfe.docs, 'documento', 'documentos') : nNfe} · NFS-e: ${nNfse}`
  if (semSeparacao && !nNfse) return { ...resumoDaCaptura(nfe), linha }
  const total = (semSeparacao ? 0 : nNfe) + nNfse
  if (!total) return { cor: 'cinza', titulo: 'Nenhuma nota nova', linha }
  return { cor: 'verde', titulo: plural(total, 'nota recebida', 'notas recebidas'), linha }
}

export function explicarSefaz({ cStat, xMotivo, erro } = {}) {
  const texto = String(erro || xMotivo || '')
  const codigo = String(cStat || /^(\d{3})\b/.exec(texto)?.[1] || '')

  if (codigo === '656') {
    return /ultNSU/i.test(texto)
      ? {
          cor: 'vermelha',
          titulo: 'Bloqueio temporário da SEFAZ (656)',
          dica: 'Outro sistema pode estar consultando este CNPJ. O Smart Fiscal tenta de novo depois de 1 hora; nenhuma nota se perde.',
        }
      : {
          cor: 'vermelha',
          titulo: 'Consultas demais em pouco tempo (656)',
          dica: 'A SEFAZ pediu 1 hora sem consultas deste CNPJ. Nenhuma nota se perde.',
        }
  }
  if (POR_CODIGO[codigo]) return POR_CODIGO[codigo]
  if (/recusou o certificado|HTTP 403/i.test(texto)) {
    return {
      cor: 'vermelha',
      titulo: 'Certificado recusado pela SEFAZ',
      dica: 'Confira se é o certificado A1 do próprio CNPJ e se está no prazo.',
    }
  }
  if (SEM_CONEXAO.test(texto)) {
    return {
      cor: 'ambar',
      titulo: 'Sem conexão com a SEFAZ',
      dica: 'Confira a internet deste computador. A próxima captura tenta de novo.',
    }
  }
  return null
}
