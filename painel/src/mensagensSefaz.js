// Traduz o retorno da SEFAZ (código cStat + texto) para quem usa o painel: um título curto,
// a cor da etiqueta e o que fazer. O texto original continua no banco e no logs/app.log.
// Devolve null quando não reconhece o retorno; aí a tela mostra o texto original.

const SEM_CONEXAO = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|timeout|Network Error/i

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
