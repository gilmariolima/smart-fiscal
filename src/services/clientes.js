'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { criptografar } = require('../crypto')
const { lerCertificado, diasParaVencer } = require('../certificado')
const { dadosUf } = require('../sefaz/uf')
const { pastaDoClienteNoDisco } = require('./armazenamento')

const DIAS_ALERTA_CERT = 30

// Colunas seguras para exibir: nunca inclui cert_senha_enc.
const COLUNAS_PUBLICAS = `id, cnpj, razao_social, apelido, uf, cert_arquivo, cert_validade, ativo, papel, ult_nsu, max_nsu,
  proxima_consulta, bloqueado_ate, ultima_consulta, ultimo_erro, criado_em,
  nfse_ult_nsu, nfse_proxima_consulta, nfse_ultima_consulta, nfse_ultimo_erro, tambem_cliente, auto_nfe, auto_nfse,
  cte_ult_nsu, cte_proxima_consulta, cte_ultima_consulta, cte_ultimo_erro, cte_bloqueado_ate, auto_cte`

// Linhas que têm notas próprias: os clientes e o escritório quando ele também é cliente.
const DA_CARTEIRA = "(papel = 'cliente' OR tambem_cliente = 1)"

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
    inserir: db.prepare(`INSERT INTO clientes (cnpj, razao_social, apelido, uf, papel, cert_arquivo, cert_senha_enc, cert_validade, auto_cte)
      VALUES (@cnpj, @razao_social, @apelido, @uf, @papel, @cert_arquivo, @cert_senha_enc, @cert_validade, 1)`), // cliente novo já busca CT-e
    trocarCert: db.prepare(`UPDATE clientes SET cert_arquivo = @cert_arquivo, cert_senha_enc = @cert_senha_enc,
      cert_validade = @cert_validade, ultimo_erro = NULL WHERE cnpj = @cnpj`),
    ativo: db.prepare('UPDATE clientes SET ativo = ? WHERE cnpj = ?'),
    tambemCliente: db.prepare("UPDATE clientes SET tambem_cliente = ? WHERE cnpj = ? AND papel = 'escritorio'"),
    autoNfe: db.prepare('UPDATE clientes SET auto_nfe = ? WHERE cnpj = ?'),
    autoNfse: db.prepare('UPDATE clientes SET auto_nfse = ? WHERE cnpj = ?'),
    autoCte: db.prepare('UPDATE clientes SET auto_cte = ? WHERE cnpj = ?'),
    dados: db.prepare('UPDATE clientes SET razao_social = @razao_social, uf = @uf WHERE id = @id'),
    notasDe: db.prepare('SELECT COUNT(*) n FROM notas WHERE cliente_id = ?'),
    apagarExecucoes: db.prepare('DELETE FROM execucoes WHERE cliente_id = ?'),
    apagar: db.prepare('DELETE FROM clientes WHERE id = ?'),
    editar: db.prepare('UPDATE clientes SET razao_social = @razao_social, uf = @uf, apelido = @apelido WHERE id = @id'),
    // Cada CNPJ tem a sua fila na SEFAZ, no ADN e no CT-e: com outro CNPJ, tudo volta para o início.
    trocarCnpj: db.prepare(`UPDATE clientes SET cnpj = @cnpj, cert_arquivo = @cert_arquivo,
      ult_nsu = '000000000000000', max_nsu = NULL, proxima_consulta = NULL, bloqueado_ate = NULL, ultima_consulta = NULL, ultimo_erro = NULL,
      nfse_ult_nsu = '0', nfse_proxima_consulta = NULL, nfse_ultima_consulta = NULL, nfse_ultimo_erro = NULL,
      cte_ult_nsu = '0', cte_proxima_consulta = NULL, cte_bloqueado_ate = NULL, cte_ultima_consulta = NULL, cte_ultimo_erro = NULL
      WHERE id = @id`),
    apagarNotas: db.prepare('DELETE FROM notas WHERE cliente_id = ?'),
    // A mesma nota pode estar em dois clientes (A vende para B): o evento só sai se ela não ficar em outro.
    apagarEventos: db.prepare(`DELETE FROM eventos WHERE chave IN (SELECT chave FROM notas WHERE cliente_id = @id)
      AND chave NOT IN (SELECT chave FROM notas WHERE cliente_id <> @id)`),
    caminhosNotas: db.prepare('SELECT id, caminho_xml FROM notas WHERE caminho_xml IS NOT NULL'),
    caminhosEventos: db.prepare('SELECT id, caminho_xml FROM eventos WHERE caminho_xml IS NOT NULL'),
    caminhoNota: db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?'),
    caminhoEvento: db.prepare('UPDATE eventos SET caminho_xml = ? WHERE id = ?'),
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

  // Cliente sem certificado: arquivo e senha vazios e desativado, porque não tem o que capturar (a captura precisa do A1 dele).
  // Continua na carteira e recebe as notas de saída que chegam pelo escritório. Ao ganhar o certificado, ativa sozinho.
  function inserirSemCertificado({ cnpj, razao, uf, apelido }) {
    sql.inserir.run({
      cnpj,
      razao_social: String(razao).trim(),
      apelido: String(apelido || '').trim() || null,
      uf: String(uf).trim().toUpperCase(),
      papel: 'cliente',
      cert_arquivo: '',
      cert_senha_enc: '',
      cert_validade: null,
    })
    sql.ativo.run(0, cnpj)
    return { cliente: sql.porCnpj.get(cnpj), certificado: null, avisos: [] }
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
   * Cadastra um cliente. `pfx` é o conteúdo do arquivo (Buffer); sem ele, o cliente fica sem certificado.
   * @returns {{ cliente: object, certificado: object|null, avisos: string[] }}
   */
  function cadastrar({ cnpj, razao, uf, apelido, pfx, senha }) {
    const c = validarDados({ cnpj, razao, uf })
    const existente = sql.porCnpj.get(c)
    if (existente?.papel === 'escritorio' && !existente.tambem_cliente) return tornarEscritorioCliente({ cnpj: c, pfx, senha })
    if (existente) throw new Error(`CNPJ ${c} já cadastrado. Para renovar, troque o certificado do cliente (cliente:cert ou no painel).`)
    if (!pfx) {
      const r = inserirSemCertificado({ cnpj: c, razao, uf, apelido })
      logger.info('Cliente cadastrado sem certificado', { cnpj: c })
      return r
    }
    const r = inserirCliente({ cnpj: c, razao, uf, apelido, papel: 'cliente', pfx, senha })
    logger.info('Cliente cadastrado', { cnpj: c, validade: r.certificado.validade })
    return r
  }

  // O CNPJ do escritório cadastrado como cliente: a mesma linha passa a guardar as notas dele (uma fila de NSU por CNPJ).
  // O certificado enviado substitui o do escritório (é o mesmo CNPJ); sem enviar, fica o que ele já tem.
  function tornarEscritorioCliente({ cnpj, pfx, senha }) {
    const r = pfx ? trocarCertificado({ cnpj, pfx, senha }) : { certificado: null, avisos: [] }
    sql.tambemCliente.run(1, cnpj)
    logger.info('Escritório passou a ser cliente também', { cnpj })
    return { ...r, cliente: sql.porCnpj.get(cnpj) }
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

  /** Muda a razão social e a UF do escritório. O CNPJ não muda: é o do certificado. */
  function editarEscritorio({ razao, uf }) {
    const atual = sql.escritorio.get()
    if (!atual) throw new Error('Escritório não cadastrado.')
    validarDados({ cnpj: atual.cnpj, razao, uf })
    sql.dados.run({ id: atual.id, razao_social: String(razao).trim(), uf: String(uf).trim().toUpperCase() })
    logger.info('Dados do escritório alterados', { cnpj: atual.cnpj })
    return sql.escritorio.get()
  }

  /**
   * Exclui o escritório: o cadastro, o certificado guardado e o histórico de execuções dele.
   * Os XMLs já recebidos ficam nas pastas dos clientes (e em fora da carteira) e as notas não mudam.
   */
  function excluirEscritorio() {
    const atual = sql.escritorio.get()
    if (!atual) throw new Error('Escritório não cadastrado.')
    if (sql.notasDe.get(atual.id).n) throw new Error('O escritório tem notas no próprio nome; não dá para excluir.')
    db.transaction(() => {
      sql.apagarExecucoes.run(atual.id)
      sql.apagar.run(atual.id)
    })()
    fs.rmSync(path.join(config.pastaCerts, atual.cert_arquivo), { force: true })
    logger.info('Escritório excluído', { cnpj: atual.cnpj })
    return atual
  }

  // O nome da pasta vem do nome do cliente. Banco primeiro, depois a pasta; se ela não mudar (aberta no Windows, por exemplo),
  // o banco volta e os XMLs continuam acessíveis onde estão.
  function moverPastaDoCliente(antiga, nova) {
    if (antiga === nova) return null
    const origem = path.join(config.pastaXmls, antiga)
    const destino = path.join(config.pastaXmls, nova)
    if (!fs.existsSync(origem)) return null
    const aviso = `Os XMLs antigos continuam na pasta "${antiga}"; os novos vão para "${nova}".`
    if (antiga.toLowerCase() !== nova.toLowerCase() && fs.existsSync(destino)) return aviso
    const prefixo = antiga + path.sep
    const dentro = (r) => r.caminho_xml.startsWith(prefixo)
    const notas = sql.caminhosNotas.all().filter(dentro)
    const eventos = sql.caminhosEventos.all().filter(dentro)
    const apontar = db.transaction((de, para) => {
      for (const r of notas) sql.caminhoNota.run(para + r.caminho_xml.slice(de.length), r.id)
      for (const r of eventos) sql.caminhoEvento.run(para + r.caminho_xml.slice(de.length), r.id)
    })
    apontar(antiga, nova)
    try {
      fs.renameSync(origem, destino)
      return null
    } catch (e) {
      db.transaction(() => {
        for (const r of notas) sql.caminhoNota.run(r.caminho_xml, r.id)
        for (const r of eventos) sql.caminhoEvento.run(r.caminho_xml, r.id)
      })()
      logger.warn('Pasta do cliente não renomeada', { erro: e.message })
      return aviso
    }
  }

  /**
   * Edita os dados do cliente. O CNPJ só muda sem notas (as que existem são do CNPJ antigo) e, com certificado,
   * só dentro da mesma empresa (matriz e filial), porque o certificado guardado é dela.
   * @returns {{ cliente: object, avisos: string[] }}
   */
  function editar(cnpjAtual, { cnpj, razao, uf, apelido }) {
    const atual = sql.porCnpj.get(somenteDigitos(cnpjAtual))
    if (!atual) throw new Error(`CNPJ ${somenteDigitos(cnpjAtual)} não cadastrado.`)
    if (atual.papel === 'escritorio') throw new Error('Os dados do escritório são editados na tela Escritório.')
    const novo = validarDados({ cnpj, razao, uf })
    let certArquivo = atual.cert_arquivo
    if (novo !== atual.cnpj) {
      if (sql.porCnpj.get(novo)) throw new Error(`CNPJ ${novo} já cadastrado.`)
      if (sql.notasDe.get(atual.id).n) throw new Error('Este cliente já tem notas no CNPJ atual: para usar outro CNPJ, exclua e cadastre de novo.')
      if (atual.cert_arquivo && novo.slice(0, 8) !== atual.cnpj.slice(0, 8)) {
        throw new Error('O certificado guardado é de outra empresa: para usar este CNPJ, exclua e cadastre de novo.')
      }
    }
    const pastaAntiga = pastaDoClienteNoDisco(atual, sql.listar.all())
    if (novo !== atual.cnpj && atual.cert_arquivo) {
      certArquivo = `${novo}.pfx`
      fs.renameSync(path.join(config.pastaCerts, atual.cert_arquivo), path.join(config.pastaCerts, certArquivo))
    }
    db.transaction(() => {
      sql.editar.run({ id: atual.id, razao_social: String(razao).trim(), uf: String(uf).trim().toUpperCase(), apelido: String(apelido || '').trim() || null })
      if (novo !== atual.cnpj) sql.trocarCnpj.run({ id: atual.id, cnpj: novo, cert_arquivo: certArquivo })
    })()
    const cliente = sql.porCnpj.get(novo)
    const aviso = moverPastaDoCliente(pastaAntiga, pastaDoClienteNoDisco(cliente, sql.listar.all()))
    logger.info('Dados do cliente alterados', { cnpj: novo, ...(novo !== atual.cnpj && { cnpjAnterior: atual.cnpj }) })
    return { cliente, avisos: aviso ? [aviso] : [] }
  }

  /**
   * Exclui o cliente: cadastro, certificado, notas e histórico no sistema.
   * Os XMLs ficam no disco: guardar o documento fiscal é obrigação legal, e apagar não teria volta.
   * @returns {{ cliente: object, notas: number }}
   */
  function excluir(cnpj) {
    const c = somenteDigitos(cnpj)
    const atual = sql.porCnpj.get(c)
    if (!atual) throw new Error(`CNPJ ${c} não cadastrado.`)
    if (atual.papel === 'escritorio') throw new Error('O escritório é excluído na tela Escritório.')
    const notas = sql.notasDe.get(atual.id).n
    db.transaction(() => {
      sql.apagarEventos.run({ id: atual.id })
      sql.apagarNotas.run(atual.id)
      sql.apagarExecucoes.run(atual.id)
      sql.apagar.run(atual.id)
    })()
    if (atual.cert_arquivo) fs.rmSync(path.join(config.pastaCerts, atual.cert_arquivo), { force: true })
    logger.info('Cliente excluído', { cnpj: c, notas })
    return { cliente: atual, notas }
  }

  /** Troca o certificado (renovação anual). */
  function trocarCertificado({ cnpj, pfx, senha }) {
    const c = somenteDigitos(cnpj)
    const atual = sql.porCnpj.get(c)
    if (!atual) throw new Error(`CNPJ ${c} não cadastrado.`)
    const { cert, avisos } = validarCertificado(c, pfx, senha)
    const certArquivo = gravarPfx(c, pfx)
    sql.trocarCert.run({ cnpj: c, cert_arquivo: certArquivo, cert_senha_enc: criptografar(senha, config.masterKey), cert_validade: cert.validade })
    if (!atual.cert_arquivo) sql.ativo.run(1, c) // estava desativado só por não ter certificado
    logger.info('Certificado trocado', { cnpj: c, validade: cert.validade })
    return { cliente: sql.porCnpj.get(c), certificado: cert, avisos }
  }

  function definirAtivo(cnpj, ativo) {
    const c = somenteDigitos(cnpj)
    // No escritório, desativar como cliente só deixa de puxar as notas dele; as de saída dos clientes continuam.
    if (sql.porCnpj.get(c)?.papel === 'escritorio') {
      sql.tambemCliente.run(ativo ? 1 : 0, c)
      logger.info(ativo ? 'Escritório voltou a ser cliente' : 'Escritório deixou de ser cliente', { cnpj: c })
      return { ...sql.porCnpj.get(c), ativo: ativo ? 1 : 0 }
    }
    const atual = sql.porCnpj.get(c)
    if (!atual) throw new Error(`CNPJ ${c} não cadastrado.`)
    if (ativo && !atual.cert_arquivo) throw new Error('Cliente sem certificado: adicione o certificado para ativar.')
    sql.ativo.run(ativo ? 1 : 0, c)
    logger.info(ativo ? 'Cliente ativado' : 'Cliente desativado', { cnpj: c })
    return sql.porCnpj.get(c)
  }

  /** Liga ou desliga o cliente na busca automática de um tipo de nota ('nfe' | 'nfse' | 'cte'); o botão Capturar continua valendo. */
  function definirAutomatica(cnpj, modelo, ligado) {
    const c = somenteDigitos(cnpj)
    const alvo = { nfe: sql.autoNfe, nfse: sql.autoNfse, cte: sql.autoCte }[modelo]
    if (!alvo) throw new Error(`Modelo inválido: ${modelo}. Use nfe, nfse ou cte.`)
    if (!alvo.run(ligado ? 1 : 0, c).changes) throw new Error(`CNPJ ${c} não cadastrado.`)
    logger.info(ligado ? 'Cliente na busca automática' : 'Cliente fora da busca automática', { cnpj: c, modelo })
    return sql.porCnpj.get(c)
  }

  /** Vários clientes de uma vez, num tipo de nota: CNPJ desconhecido cancela tudo. */
  function definirAutomaticaDeVarios(cnpjs, modelo, ligado) {
    const alvo = { nfe: sql.autoNfe, nfse: sql.autoNfse, cte: sql.autoCte }[modelo]
    if (!alvo) throw new Error(`Modelo inválido: ${modelo}. Use nfe, nfse ou cte.`)
    db.transaction(() => {
      for (const cnpj of cnpjs) {
        const c = somenteDigitos(cnpj)
        if (!alvo.run(ligado ? 1 : 0, c).changes) throw new Error(`CNPJ ${c} não cadastrado.`)
      }
    })()
    logger.info(ligado ? 'Clientes na busca automática' : 'Clientes fora da busca automática', { clientes: cnpjs.length, modelo })
    return cnpjs.length
  }

  /** Lista sem a senha; inclui dias para o certificado vencer. */
  function listar() {
    return sql.listar.all().map((c) => ({ ...c, cert_dias: c.cert_validade ? diasParaVencer(c.cert_validade, agora()) : null }))
  }

  const obter = (cnpj) => sql.porCnpj.get(somenteDigitos(cnpj)) || null

  const obterEscritorio = () => sql.escritorio.get() || null

  return { cadastrar, cadastrarEscritorio, editarEscritorio, excluirEscritorio, obterEscritorio, trocarCertificado, definirAtivo, definirAutomatica, definirAutomaticaDeVarios, editar, excluir, listar, obter, validarCertificado }
}

module.exports = { criarServicoClientes, cnpjValido, somenteDigitos, DIAS_ALERTA_CERT, COLUNAS_PUBLICAS, DA_CARTEIRA }
