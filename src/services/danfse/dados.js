'use strict'

// Lê o XML da NFS-e e devolve cada campo do DANFSe já formatado (NT 008/2026 v1.02, item 2.4.5).
// Só aparece o que está no XML; campo sem informação vira "-" (nota 12).

const { XMLParser } = require('fast-xml-parser')
const { ajustarFuso } = require('../extracaoNfse')
const { descricao, municipio } = require('./descricoes')

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true })

const VAZIO = '-'
const txt = (v) => (v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v))
const ou = (v) => txt(v) ?? VAZIO
const num = (v) => (txt(v) === null || !Number.isFinite(Number(v)) ? null : Number(v))
const reais = (v) => (num(v) === null ? VAZIO : `R$ ${num(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const pct = (v) => (num(v) === null ? VAZIO : `${num(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`)
const juntar = (partes, sep = ' / ') => (partes.every((p) => p === null) ? VAZIO : partes.map((p) => p ?? VAZIO).join(sep))

function documento(g) {
  const cnpj = txt(g?.CNPJ)
  if (cnpj) return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  const cpf = txt(g?.CPF)
  if (cpf) return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  return ou(g?.NIF)
}

// "AAAA-MM-DDThh:mm:ss..." → "DD/MM/AAAA hh:mm:ss", na hora escrita no documento.
function dataHora(dh) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(txt(dh) || '')
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}` : ''}` : VAZIO
}

const cep = (c) => (txt(c) && /^\d{8}$/.test(c) ? `${c.slice(0, 2)}.${c.slice(2, 5)}-${c.slice(5)}` : txt(c))

function pessoa(g) {
  if (!g) return null
  const nac = g.end?.endNac || g.enderNac
  const ext = g.end?.endExt
  const end = g.end || g.enderNac || {}
  return {
    documento: documento(g),
    im: ou(g.IM),
    telefone: ou(g.fone),
    nome: ou(g.xNome),
    municipio: nac ? municipio(txt(nac.cMun)) ?? ou(nac.cMun) : ou(ext?.xCidade),
    ibgeCep: nac ? juntar([txt(nac.cMun), cep(nac.CEP)]) : juntar([null, txt(ext?.cEndPost)]),
    endereco: [end.xLgr, end.nro, end.xCpl, end.xBairro].map(txt).filter(Boolean).join(', ') || VAZIO,
    email: ou(g.email),
  }
}

const codigoTribNac = (c) => (txt(c) && /^\d{6}$/.test(c) ? `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4)}` : txt(c))
const codigoNbs = (c) => (txt(c) && /^\d{9}$/.test(c) ? `${c[0]}.${c.slice(1, 5)}.${c.slice(5, 7)}.${c.slice(7)}` : ou(c))

/**
 * @param {string} xml XML da NFS-e (NFSe/infNFSe)
 * @returns {object} campos do DANFSe formatados
 */
function dadosDanfse(xml) {
  const inf = parser.parse(xml)?.NFSe?.infNFSe
  if (!inf || !inf['@_Id']) throw new Error('O XML não é uma NFS-e (NFSe/infNFSe).')
  const dps = inf.DPS?.infDPS || {}
  const ambGer = txt(inf.ambGer)
  const chave = String(inf['@_Id']).replace(/^NFS/, '')
  const valores = dps.valores || {}
  const trib = valores.trib || {}
  const mun = trib.tribMun || {}
  const fed = trib.tribFed || {}
  const pc = fed.piscofins || {}
  const ibscbs = inf.IBSCBS || {}
  const ibsVal = ibscbs.valores || {}
  const ibsTot = ibscbs.totCIBS || {}
  const dpsIbs = dps.IBSCBS || {}
  const serv = dps.serv || {}
  const cServ = serv.cServ || {}
  const paisPrest = txt(serv.locPrest?.cPaisPrestacao) || 'BR'
  const incidencia = txt(mun.cPaisResult) || 'BR'
  const pisCofinsRetido = txt(pc.tpRetPisCofins) === '1'
  const anoCompet = Number((txt(dps.dCompet) || '').slice(0, 4))
  const totTrib = trib.totTrib || {}
  const vTot = totTrib.vTotTrib
  const pTot = totTrib.pTotTrib

  const informacoes = [
    txt(serv.infoCompl?.xInfComp) && `Inf. Cont.: ${txt(serv.infoCompl.xInfComp)}`,
    txt(dps.subst?.chSubstda) && `NFS-e Subst.: ${txt(dps.subst.chSubstda)}`,
    txt(serv.infoCompl?.docRef) && `Doc. Ref.: ${txt(serv.infoCompl.docRef)}`,
    txt(serv.obra?.cObra) && `Cod. Obra: ${txt(serv.obra.cObra)}`,
    txt(dpsIbs.imovel?.inscImobFisc ?? serv.obra?.inscImobFisc) && `Insc. Imob.: ${txt(dpsIbs.imovel?.inscImobFisc ?? serv.obra?.inscImobFisc)}`,
    txt(serv.atvEvento?.idAtvEvt) && `Cod. Evt.: ${txt(serv.atvEvento.idAtvEvt)}`,
    txt(serv.infoCompl?.idDocTec) && `Doc. Tec.: ${txt(serv.infoCompl.idDocTec)}`,
    txt(serv.infoCompl?.xPed) && `Núm. Ped.: ${txt(serv.infoCompl.xPed)}`,
    txt(inf.xOutInf) && `Inf. A. T. Mun.: ${txt(inf.xOutInf)}`,
    vTot
      ? `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ${reais(vTot.vTotTribFed)}; Estaduais: ${reais(vTot.vTotTribEst)}; Municipais: ${reais(vTot.vTotTribMun)}`
      : `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ${pct(pTot?.pTotTribFed)}; Estaduais: ${pct(pTot?.pTotTribEst)}; Municipais: ${pct(pTot?.pTotTribMun)}`,
  ].filter(Boolean)

  const totalIbs = num(ibsTot.gIBS?.vIBSTot)
  const totalCbs = num(ibsTot.gCBS?.vCBS)

  return {
    chave,
    urlQr: `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`,
    homologacao: txt(dps.tpAmb) === '2',
    municipioEmissao: `Município: ${municipio(txt(inf.emit?.enderNac?.cMun)) ?? ou(inf.xLocEmi)}`,
    ambienteGerador: `Ambiente Gerador: ${descricao('ambGer', ambGer) ?? VAZIO}`,
    tipoAmbiente: `Tipo de Ambiente: ${descricao('tpAmb', dps.tpAmb) ?? VAZIO}`,
    numero: ou(inf.nNFSe),
    competencia: dataHora(dps.dCompet),
    emissaoNfse: dataHora(ajustarFuso(txt(inf.dhProc), ambGer)),
    numeroDps: ou(dps.nDPS),
    serieDps: ou(dps.serie),
    emissaoDps: dataHora(ajustarFuso(txt(dps.dhEmi), ambGer)),
    emitente: descricao('tpEmit', dps.tpEmit) ?? VAZIO,
    situacao: descricao('cStat', inf.cStat) ?? VAZIO,
    finalidade: descricao('finNFSe', dpsIbs.finNFSe) ?? VAZIO,
    prestador: {
      ...pessoa({ ...inf.emit, ...dps.prest, xNome: dps.prest?.xNome ?? inf.emit?.xNome, enderNac: inf.emit?.enderNac, end: dps.prest?.end }),
      simples: descricao('opSimpNac', dps.prest?.regTrib?.opSimpNac) ?? VAZIO,
      regimeSn: descricao('regApTribSN', dps.prest?.regTrib?.regApTribSN) ?? VAZIO,
    },
    tomador: pessoa(dps.toma),
    destinatario: pessoa(dpsIbs.dest),
    intermediario: pessoa(dps.interm),
    servico: {
      codigo: juntar([codigoTribNac(cServ.cTribNac), txt(cServ.cTribMun)]),
      nbs: codigoNbs(cServ.cNBS),
      local: juntar([municipio(txt(serv.locPrest?.cLocPrestacao)) ?? txt(inf.xLocPrestacao), paisPrest]),
      descricaoCodigo: txt(inf.xTribMun) || txt(inf.xTribNac) || VAZIO,
      descricao: ou(cServ.xDescServ),
    },
    issqn: Object.keys(mun).length
      ? {
          tipo: descricao('tribISSQN', mun.tribISSQN) ?? VAZIO,
          incidencia: juntar([municipio(txt(inf.cLocIncid)) ?? txt(inf.xLocIncid), incidencia]),
          regimeEspecial: descricao('regEspTrib', dps.prest?.regTrib?.regEspTrib) ?? VAZIO,
          imunidade: descricao('tpImunidade', mun.tpImunidade) ?? VAZIO,
          suspensao: descricao('tpSusp', mun.exigSusp?.tpSusp) ?? VAZIO,
          processo: ou(mun.exigSusp?.nProcesso),
          beneficio: descricao('tpBM', inf.valores?.tpBM) ?? VAZIO,
          calculoBm: reais(inf.valores?.vCalcBM ?? mun.BM?.vRedBCBM),
          deducoes: reais(valores.vDedRed?.vDR ?? inf.valores?.vCalcDR),
          descontoIncond: reais(valores.vDescCondIncond?.vDescIncond),
          bc: reais(inf.valores?.vBC),
          aliquota: pct(inf.valores?.pAliqAplic),
          retencao: descricao('tpRetISSQN', mun.tpRetISSQN) ?? VAZIO,
          apurado: reais(inf.valores?.vISSQN),
        }
      : null,
    federal: {
      irrf: reais(fed.vRetIRRF),
      cpRetida: reais(fed.vRetCP),
      contribuicoesRetidas: pisCofinsRetido ? reais((num(fed.vRetCSLL) ?? 0) + (num(pc.vPis) ?? 0) + (num(pc.vCofins) ?? 0)) : reais(fed.vRetCSLL),
      pis: pisCofinsRetido ? reais(0) : reais(pc.vPis),
      cofins: pisCofinsRetido ? reais(0) : reais(pc.vCofins),
      descricaoRetidas: descricao('tpRetPisCofins', pc.tpRetPisCofins) ?? VAZIO,
      imprimirPisCofins: !anoCompet || anoCompet <= 2026,
    },
    ibscbs: {
      cst: juntar([txt(dpsIbs.valores?.trib?.gIBSCBS?.CST), txt(dpsIbs.valores?.trib?.gIBSCBS?.cClassTrib)]),
      indicador: juntar([txt(dpsIbs.cIndOp), txt(ibscbs.cLocalidadeIncid), municipio(txt(ibscbs.cLocalidadeIncid)) ?? txt(ibscbs.xLocalidadeIncid)]),
      exclusoes: reais(
        [valores.vDescCondIncond?.vDescIncond, ibsVal.vCalcReeRepRes, inf.valores?.vISSQN, pc.vPis, pc.vCofins].some((v) => num(v) !== null)
          ? [valores.vDescCondIncond?.vDescIncond, ibsVal.vCalcReeRepRes, inf.valores?.vISSQN, pc.vPis, pc.vCofins].reduce((s, v) => s + (num(v) ?? 0), 0)
          : null,
      ),
      bc: reais(ibsVal.vBC),
      reducoes: juntar([pct(ibsVal.uf?.pRedAliqUF), pct(ibsVal.mun?.pRedAliqMun), pct(ibsVal.fed?.pRedAliqCBS)].map((v) => (v === VAZIO ? null : v))),
      aliquotas: juntar([pct(ibsVal.uf?.pIBSUF), pct(ibsVal.mun?.pIBSMun)].map((v) => (v === VAZIO ? null : v))),
      efetivaMun: pct(ibsVal.mun?.pAliqEfetMun),
      valorMun: reais(ibsTot.gIBS?.gIBSMunTot?.vIBSMun),
      efetivaUf: pct(ibsVal.uf?.pAliqEfetUF),
      valorUf: reais(ibsTot.gIBS?.gIBSUFTot?.vIBSUF),
      totalIbs: reais(totalIbs),
      aliquotaCbs: pct(ibsVal.fed?.pCBS),
      efetivaCbs: pct(ibsVal.fed?.pAliqEfetCBS),
      totalCbs: reais(totalCbs),
    },
    totais: {
      servico: reais(valores.vServPrest?.vServ),
      descontoIncond: reais(valores.vDescCondIncond?.vDescIncond),
      descontoCond: reais(valores.vDescCondIncond?.vDescCond),
      retencoes: reais(inf.valores?.vTotalRet),
      liquido: reais(inf.valores?.vLiq),
      ibscbs: totalIbs === null && totalCbs === null ? VAZIO : reais((totalIbs ?? 0) + (totalCbs ?? 0)),
      liquidoComIbscbs: reais(ibsTot.vTotNF),
    },
    informacoes: informacoes.join(' | '),
  }
}

module.exports = { dadosDanfse, VAZIO }
