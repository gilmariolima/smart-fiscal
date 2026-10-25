'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { criptografar } = require('../crypto')
const { lerCertificado, diasParaVencer } = require('../certificado')
const { dadosUf } = require('../sefaz/uf')

const DIAS_ALERTA_CERT = 30

// Colunas seguras para exibir: nunca inclui cert_senha_enc.
const COLUNAS_PUBLICAS = `id, cnpj, razao_social, apelido, uf, cert_arquivo, cert_validade, ativo, papel, ult_nsu, max_nsu,
  proxima_consulta, bloqueado_ate, ultima_consulta, ultimo_erro, criado_em`

function somenteDigitos(v) {
  return String(v || '').replace(/\D/g, '')
}

/** Valida os dígitos verificadores do CNPJ. */
function cnpjValido(cnpj) {
  const c = somenteDigitos(cnpj)
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false
  const dv = (base) => {
    let soma = 0
    let peso = base.length - 7
    for (const d of base) {
      soma += Number(d) * peso--
      if (peso < 2) peso = 9
    }
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(c.slice(0, 12))
  return d1 === Number(c[12]) && dv(c.slice(0, 12) + d1) === Number(c[13])
}

function criarServicoClientes({ db, config, logger, agora = () => new Date() }) {
  const sql = {
    porCnpj: db.prepare(`SELECT ${COLUNAS_PUBLICAS} FROM clientes WHERE cnpj = ?`),
    listar: db.prepare(`SELECT ${COLUNAS_PUBLICAS} FROM clientes ORDER BY razao_social`),
    escritorio: db.prepare(`SELECT ${COLUNAS_PUBLICAS} FROM clientes WHERE papel = 'escritorio'`),
    inserir: db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, papel, cert_arquivo, cert_senha_enc, cert_validade)
      VALUES (@cnpj, @razao_social, @apelido, @uf, @papel, @cert_arquivo, @cert_senha_enc, @cert_validade)`),
    trocarCert: db.prepare(`UPDATE clientes SET cert_arquivo = @cert_arquivo, cert_senha_enc = @cert_senha_enc,
      cert_validade = @cert_validade, ultimo_erro = NULL WHERE cnpj = @cnpj`),
    ativo: db.prepare('UPDATE clientes SET ativo = ? WHERE cnpj = ?'),
  }

  /** Abre o .pfx e confere senha, validade e raiz do CNPJ. Lança Error com a mensagem para o usuário. */
  function validarCertificado(cnpj, pfx, senha) {
    const cert = lerCertificado(pfx, senha)
    const dias = diasParaVencer(cert.validade, agora())
    if (dias < 0) throw new Error(`Certificado vencido em ${cert.validade.slice(0, 10)}.`)
    if (!cert.cnpj) throw new Error(`Não encontrei o CNPJ no certificado (titular: ${cert.titular || '?'}). É um e-CNPJ?`)
    if (cert.cnpj.slice(0, 8) !== cnpj.slice(0, 8)) {
      throw new Error(`O certificado é do CNPJ ${cert.cnpj}, de outra empresa (raiz ${cert.cnpj.slice(0, 8)} ≠ ${cnpj.slice(0, 8)}).`)
    }
    const avisos = []
    if (dias < DIAS_ALERTA_CERT) avisos.push(`Certificado vence em ${dias} dia(s) (${cert.validade.slice(0, 10)}).`)
    if (cert.cnpj !== cnpj) avisos.push(`Certificado da matriz/filial ${cert.cnpj} (mesma raiz).`)
    return { cert, avisos }
  }

  // Grava o .pfx em certs/<cnpj>.pfx (temporário + renomear).
  function gravarPfx(cnpj, pfx) {
    fs.mkdirSync(config.pastaCerts, { recursive: true })
    const nome = `${cnpj}.pfx`
    const destino = path.join(config.pastaCerts, nome)
    const tmp = `${destino}.${process.pid}.tmp`
    fs.writeFileSync(tmp, pfx, { mode: 0o600 })
    fs.renameSync(tmp, destino)
    return nome
  }

  function validarDados({ cnpj, razao, uf }) {
    const c = somenteDigitos(cnpj)
    if (!cnpjValido(c)) throw new Error(`CNPJ inválido: ${cnpj}`)
    if (!String(razao || '').trim()) throw new Error('Informe a razão social.')
    dadosUf(uf) // lança se a UF não existir
    return c
  }

  // Caminho comum de cadastro: valida, guarda o .pfx e insere a linha com o papel dado.
  function inserirCliente({ cnpj, razao, uf, apelido, papel, pfx, senha }) {
    const { cert, avisos } = validarCertificado(cnpj, pfx, senha)
    const certArquivo = gravarPfx(cnpj, pfx)
    try {
      sql.inserir.run({
        cnpj,
        razao_social: String(razao).trim(),
        apelido: String(apelido || '').trim() || null,
        uf: String(uf).trim().toUpperCase(),
        papel,
        cert_arquivo: certArquivo,
        cert_senha_enc: criptografar(senha, config.masterKey),
        cert_validade: cert.validade,
      })
    } catch (e) {
      fs.rmSync(path.join(config.pastaCerts, certArquivo), { force: true })
      throw e
    }
    return { cliente: sql.porCnpj.get(cnpj), certificado: cert, avisos }
  }

  /**
   * Cadastra um cliente. `pfx` é o conteúdo do arquivo (Buffer).
   * @returns {{ cliente: object, certificado: object, avisos: string[] }}
   */
  function cadastrar({ cnpj, razao, uf, apelido, pfx, senha }) {
    const c = validarDados({ cnpj, razao, uf })
    if (sql.porCnpj.get(c)) throw new Error(`CNPJ ${c} já cadastrado. Para renovar, troque o certificado do cliente (cliente:cert ou no painel).`)
    const r = inserirCliente({ cnpj: c, razao, uf, apelido, papel: 'cliente', pfx, senha })
    logger.info('Cliente cadastrado', { cnpj: c, validade: r.certificado.validade })
    return r
  }

  /** Cadastra o escritório (no máximo um), que usa o próprio certificado A1 para as notas de saída. */
  function cadastrarEscritorio({ cnpj, razao, uf, pfx, senha }) {
    const c = validarDados({ cnpj, razao, uf })
    const atual = sql.escritorio.get()
    if (atual) throw new Error(`Já existe um escritório cadastrado (${atual.cnpj}).`)
    if (sql.porCnpj.get(c)) throw new Error(`CNPJ ${c} já cadastrado.`)
    const r = inserirCliente({ cnpj: c, razao, uf, apelido: 'escritorio', papel: 'escritorio', pfx, senha })
    logger.info('Escritório cadastrado', { cnpj: c, validade: r.certificado.validade })
    return r
  }

  /** Troca o certificado (renovação anual). */
  function trocarCertificado({ cnpj, pfx, senha }) {
    const c = somenteDigitos(cnpj)
    if (!sql.porCnpj.get(c)) throw new Error(`CNPJ ${c} não cadastrado.`)
    const { cert, avisos } = validarCertificado(c, pfx, senha)
    const certArquivo = gravarPfx(c, pfx)
    sql.trocarCert.run({ cnpj: c, cert_arquivo: certArquivo, cert_senha_enc: criptografar(senha, config.masterKey), cert_validade: cert.validade })
    logger.info('Certificado trocado', { cnpj: c, validade: cert.validade })
    return { cliente: sql.porCnpj.get(c), certificado: cert, avisos }
  }

  function definirAtivo(cnpj, ativo) {
    const c = somenteDigitos(cnpj)
    if (!sql.ativo.run(ativo ? 1 : 0, c).changes) throw new Error(`CNPJ ${c} não cadastrado.`)
    logger.info(ativo ? 'Cliente ativado' : 'Cliente desativado', { cnpj: c })
    return sql.porCnpj.get(c)
  }

  /** Lista sem a senha; inclui dias para o certificado vencer. */
  function listar() {
    return sql.listar.all().map((c) => ({ ...c, cert_dias: c.cert_validade ? diasParaVencer(c.cert_validade, agora()) : null }))
  }

  const obter = (cnpj) => sql.porCnpj.get(somenteDigitos(cnpj)) || null

  const obterEscritorio = () => sql.escritorio.get() || null

  return { cadastrar, cadastrarEscritorio, obterEscritorio, trocarCertificado, definirAtivo, listar, obter, validarCertificado }
}

module.exports = { criarServicoClientes, cnpjValido, somenteDigitos, DIAS_ALERTA_CERT, COLUNAS_PUBLICAS }
