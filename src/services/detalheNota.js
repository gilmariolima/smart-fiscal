'use strict'

// Lê o XML completo de uma NF-e (nfeProc) e devolve os blocos que o painel mostra na tela "Ver nota".
// Campo ausente vira null; XML que não é NF-e devolve null. Nada aqui lança exceção.
const { xmlParaJson } = require('../sefaz/xml')
const { texto, pegar } = require('./extracao')
const { dadosNfse } = require('./extracaoNfse')

const MODALIDADES_FRETE = {
  0: 'Por conta do emitente',
  1: 'Por conta do destinatário',
  2: 'Por conta de terceiros',
  3: 'Próprio por conta do remetente',
  4: 'Próprio por conta do destinatário',
  9: 'Sem frete',
}

const FINALIDADES = { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução' }

const FORMAS_PAGAMENTO = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja',
  10: 'Vale alimentação', 11: 'Vale refeição', 12: 'Vale presente', 13: 'Vale combustível', 15: 'Boleto bancário',
  16: 'Depósito bancário', 17: 'PIX', 18: 'Transferência bancária', 19: 'Programa de fidelidade', 90: 'Sem pagamento', 99: 'Outros',
}

/** Nó repetível do XML (um item vira objeto, vários viram lista): sempre lista. */
const lista = (no) => (no === null || no === undefined ? [] : Array.isArray(no) ? no : [no])

const t = (obj, caminho) => texto(pegar(obj, caminho))

function n(obj, caminho) {
  const v = t(obj, caminho)
  const num = Number(v)
  return v !== null && Number.isFinite(num) ? num : null
}

/** Único filho de um nó como <ICMS><ICMS00>…</ICMS00></ICMS>. */
function filhoUnico(no) {
  if (!no || typeof no !== 'object') return null
  const valores = Object.values(no).filter((v) => v && typeof v === 'object')
  return valores[0] || null
}

function endereco(e) {
  if (!e) return null
  return {
    logradouro: t(e, 'xLgr'), numero: t(e, 'nro'), complemento: t(e, 'xCpl'), bairro: t(e, 'xBairro'),
    municipio: t(e, 'xMun'), uf: t(e, 'UF'), cep: t(e, 'CEP'), telefone: t(e, 'fone'),
  }
}

function pessoa(p, noEndereco) {
  if (!p || typeof p !== 'object') return null
  return {
    nome: t(p, 'xNome'), fantasia: t(p, 'xFant'), documento: t(p, 'CNPJ') || t(p, 'CPF') || t(p, 'idEstrangeiro'),
    ie: t(p, 'IE'), endereco: endereco(p[noEndereco]),
  }
}

function item(det) {
  const prod = det.prod || {}
  const icms = filhoUnico(pegar(det, 'imposto.ICMS')) || {}
  const ipi = pegar(det, 'imposto.IPI.IPITrib') || {}
  const tributacao = t(icms, 'CST') || t(icms, 'CSOSN')
  return {
    numero: t(det, '@_nItem'), codigo: t(prod, 'cProd'), descricao: t(prod, 'xProd'), ncm: t(prod, 'NCM'), cfop: t(prod, 'CFOP'),
    cst: tributacao ? (t(icms, 'orig') || '') + tributacao : null,
    unidade: t(prod, 'uCom'), quantidade: n(prod, 'qCom'), valorUnitario: n(prod, 'vUnCom'), valorTotal: n(prod, 'vProd'), desconto: n(prod, 'vDesc'),
    baseIcms: n(icms, 'vBC'), aliquotaIcms: n(icms, 'pICMS'), valorIcms: n(icms, 'vICMS'), valorIpi: n(ipi, 'vIPI'), aliquotaIpi: n(ipi, 'pIPI'),
  }
}

function transporte(tr) {
  const ta = tr.transporta
  const veic = tr.veicTransp
  const mod = t(tr, 'modFrete')
  return {
    modalidade: mod === null ? null : `${mod} - ${MODALIDADES_FRETE[mod] || 'Outra'}`,
    transportadora: ta
      ? { nome: t(ta, 'xNome'), documento: t(ta, 'CNPJ') || t(ta, 'CPF'), ie: t(ta, 'IE'), endereco: t(ta, 'xEnder'), municipio: t(ta, 'xMun'), uf: t(ta, 'UF') }
      : null,
    veiculo: veic ? { placa: t(veic, 'placa'), uf: t(veic, 'UF') } : null,
    volumes: lista(tr.vol).map((v) => ({
      quantidade: n(v, 'qVol'), especie: t(v, 'esp'), marca: t(v, 'marca'), numeracao: t(v, 'nVol'), pesoLiquido: n(v, 'pesoL'), pesoBruto: n(v, 'pesoB'),
    })),
  }
}

function detalharNfe(xml) {
  let json
  try {
    json = xmlParaJson(xml || '')
  } catch {
    return null
  }
  const proc = pegar(json, 'nfeProc')
  const inf = pegar(proc || json, 'NFe.infNFe')
  if (!inf || typeof inf !== 'object') return null

  const ide = inf.ide || {}
  const tot = pegar(inf, 'total.ICMSTot') || {}
  const fat = pegar(inf, 'cobr.fat')
  const prot = pegar(proc, 'protNFe.infProt')
  const chave = t(prot, 'chNFe') || (t(inf, '@_Id') || '').replace(/^NFe/, '') || null

  return {
    ide: {
      chave, numero: t(ide, 'nNF'), serie: t(ide, 'serie'), modelo: t(ide, 'mod'), naturezaOperacao: t(ide, 'natOp'),
      dataEmissao: t(ide, 'dhEmi') || t(ide, 'dEmi'), dataSaida: t(ide, 'dhSaiEnt') || t(ide, 'dSaiEnt'),
      tipo: { 0: 'entrada', 1: 'saida' }[t(ide, 'tpNF')] || null,
      finalidade: FINALIDADES[t(ide, 'finNFe')] || null,
      ambiente: { 1: 'producao', 2: 'homologacao' }[t(ide, 'tpAmb')] || null,
    },
    protocolo: prot ? { numero: t(prot, 'nProt'), data: t(prot, 'dhRecbto'), cStat: t(prot, 'cStat'), motivo: t(prot, 'xMotivo') } : null,
    emitente: pessoa(inf.emit, 'enderEmit'),
    destinatario: pessoa(inf.dest, 'enderDest'),
    itens: lista(inf.det).map(item),
    totais: {
      baseIcms: n(tot, 'vBC'), icms: n(tot, 'vICMS'), baseSt: n(tot, 'vBCST'), st: n(tot, 'vST'), produtos: n(tot, 'vProd'),
      frete: n(tot, 'vFrete'), seguro: n(tot, 'vSeg'), desconto: n(tot, 'vDesc'), outras: n(tot, 'vOutro'),
      ipi: n(tot, 'vIPI'), pis: n(tot, 'vPIS'), cofins: n(tot, 'vCOFINS'), total: n(tot, 'vNF'), tributosAproximados: n(tot, 'vTotTrib'),
    },
    transporte: inf.transp ? transporte(inf.transp) : { modalidade: null, transportadora: null, veiculo: null, volumes: [] },
    cobranca: {
      fatura: fat ? { numero: t(fat, 'nFat'), valorOriginal: n(fat, 'vOrig'), desconto: n(fat, 'vDesc'), valorLiquido: n(fat, 'vLiq') } : null,
      duplicatas: lista(pegar(inf, 'cobr.dup')).map((d) => ({ numero: t(d, 'nDup'), vencimento: t(d, 'dVenc'), valor: n(d, 'vDup') })),
    },
    pagamentos: lista(pegar(inf, 'pag.detPag')).map((p) => ({ forma: FORMAS_PAGAMENTO[t(p, 'tPag')] || 'Outros', valor: n(p, 'vPag') })),
    informacoes: { complementar: t(inf, 'infAdic.infCpl'), fisco: t(inf, 'infAdic.infAdFisco') },
  }
}

/** Blocos da tela "Ver nota" para uma NFS-e Nacional. XML que não é NFS-e devolve null. */
function detalharNfse(xml) {
  let d
  try {
    d = dadosNfse(xml)
  } catch {
    return null
  }
  if (!d.chave) return null
  return {
    numero: d.numero,
    competencia: d.competencia,
    dataEmissao: d.dataEmissao,
    municipio: d.municipio,
    prestador: { cnpj: d.prestadorCnpj, nome: d.prestadorNome },
    tomador: { cnpj: d.tomadorCnpj, nome: d.tomadorNome },
    intermediario: d.intermediarioCnpj,
    valor: d.valor,
    descricaoServico: d.descricaoServico,
  }
}

module.exports = { detalharNfe, detalharNfse }
