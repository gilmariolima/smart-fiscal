'use strict'

// Consulta de situação da NF-e (NFeConsultaProtocolo4) na SVRS, usada para descobrir as chaves das saídas pelo número:
// a chave montada com um código numérico qualquer volta com cStat 613 e a chave verdadeira entre colchetes
// quando o número existe; 217 quando não existe; 526 quando a nota tem mais de 6 meses (testado em 18/11/2026).

const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const tls = require('node:tls')
const { descriptografar } = require('../crypto')
const { agenteDoCertificado } = require('./certificado')

const ENDERECO = 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx'
const TIMEOUT_MS = 30e3

function digitoVerificador(base43) {
  let soma = 0
  let peso = 2
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += Number(base43[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const resto = soma % 11
  return String(resto < 2 ? 0 : 11 - resto)
}

/** Chave de NF-e (modelo 55, emissão normal) de um número; `cNF` é o código numérico (qualquer um serve na consulta). */
function montarChave({ cUF, aamm, cnpj, serie, numero, cNF = '12345678' }) {
  const base = `${cUF}${aamm}${cnpj}55${String(serie).padStart(3, '0')}${String(numero).padStart(9, '0')}1${String(cNF).padStart(8, '0')}`
  return base + digitoVerificador(base)
}

const pegar = (xml, tag) => new RegExp(`<(?:\\w+:)?${tag}>([^<]*)<`).exec(xml || '')?.[1] ?? null

/** { cStat, xMotivo, chaveVerdadeira } — chaveVerdadeira só no 613 que a traz entre colchetes. */
function lerRetornoConsulta(xml) {
  const cStat = pegar(xml, 'cStat')
  const xMotivo = pegar(xml, 'xMotivo')
  const chaveVerdadeira = cStat === '613' ? /\[(\d{44})\]/.exec(xMotivo || '')?.[1] || null : null
  return { cStat, xMotivo, chaveVerdadeira }
}

function envelope(chave) {
  return '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4"><consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
    `<tpAmb>1</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe></nfeDadosMsg></soap12:Body></soap12:Envelope>`
}

function requisitarHttps(agent) {
  return (url, corpo) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', agent, timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) } }, (res) => {
        const partes = []
        res.on('data', (d) => partes.push(d))
        res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('a SEFAZ não respondeu em 30 s')))
      req.on('error', reject)
      req.end(corpo)
    })
}

/** @returns {{ consultar(chave): Promise<{ cStat, xMotivo, chaveVerdadeira } | { erro }> }} */
function criarClienteConsulta({ pfx, passphrase, requisitar } = {}) {
  const enviar = requisitar || requisitarHttps(agenteDoCertificado(pfx, passphrase, { ca: [...tls.rootCertificates, ...require('node-mde/lib/env').CA] }))
  return {
    async consultar(chave) {
      try {
        const r = await enviar(ENDERECO, envelope(chave))
        if (r.status >= 500) return { erro: `A SEFAZ respondeu ${r.status}` }
        return lerRetornoConsulta(r.corpo)
      } catch (e) {
        return { erro: `Sem resposta da SEFAZ: ${e.message}` }
      }
    },
  }
}

// SEFAZ simulada (SEFAZ_MOCK): os 5 números depois do primeiro consultado de cada série existem; depois, 217.
// Demonstração: toda série tem as notas 1 a 120; de 20 em 20, do mês atual (101 a 120) para trás (1 a 20 = 5 meses antes).
const ULTIMA_SIMULADA = 120
function consultaSimulada() {
  return {
    async consultar(chave) {
      const numero = Number(chave.slice(25, 34))
      if (numero < 1 || numero > ULTIMA_SIMULADA) return { cStat: '217', xMotivo: 'Rejeicao: NF-e nao consta na base de dados da SEFAZ' }
      const hoje = new Date()
      const mes = new Date(hoje.getFullYear(), hoje.getMonth() - Math.floor((ULTIMA_SIMULADA - numero) / 20), 1)
      const aamm = `${String(mes.getFullYear()).slice(2)}${String(mes.getMonth() + 1).padStart(2, '0')}`
      const verdadeira = chave.slice(0, 2) + aamm + chave.slice(6, 35) + '7654321'.padStart(8, '0')
      const real = verdadeira.slice(0, 43) + digitoVerificador(verdadeira.slice(0, 43))
      return { cStat: '613', xMotivo: `Rejeicao: Codigo Numerico difere [${real}]`, chaveVerdadeira: real }
    },
  }
}

/** (linha de clientes) => cliente da consulta, com o certificado dela. */
function criarFabricaConsulta(config) {
  if (config.sefazMock) {
    const simulada = consultaSimulada()
    return () => simulada
  }
  return (cliente) =>
    criarClienteConsulta({ pfx: fs.readFileSync(path.join(config.pastaCerts, cliente.cert_arquivo)), passphrase: descriptografar(cliente.cert_senha_enc, config.masterKey) })
}

module.exports = { montarChave, digitoVerificador, lerRetornoConsulta, criarClienteConsulta, criarFabricaConsulta }
