'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { criptografar } = require('../crypto')
const { lerCertificado, diasParaVencer } = require('../certificado')
const { dadosUf } = require('../sefaz/uf')
const { pastaDoClienteNoDisco, pastasDoClienteNoBanco, chavePastaPendente, pastasPendentesDoCliente } = require('./armazenamento')
const { VERSAO_XML } = require('./migracaoPastas')
const { nomearSemSobrescreverSync } = require('./copiaDePastas')

const DIAS_ALERTA_CERT = 30
const ARQUIVOS_NA_MENSAGEM = 3
// Erros de arquivo aberto no Windows: só neles faz sentido pedir para fechar.
const TRAVAMENTO = new Set(['EBUSY', 'EPERM', 'EACCES'])

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

const barraNormal = (caminho) => caminho.replace(/\\/g, '/')

function listaDeNomes(nomes) {
  const resto = nomes.length - ARQUIVOS_NA_MENSAGEM
  return `"${nomes.slice(0, ARQUIVOS_NA_MENSAGEM).join('", "')}"${resto > 0 ? ` e mais ${resto}` : ''}`
}

function mesmoConteudo(a, b) {
  return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b))
}

// XML em qualquer pasta XML\ da empresa: é o que prende o grupo. Relatório, ZIP e PDF são refeitos.
const ehXmlGuardado = (rel) => /(^|\/)xml\/.+\.xml$/i.test(barraNormal(rel))

/** Tudo dentro da pasta; pasta que não existe não tem nada. Outro erro de leitura lança. */
function arvoreDe(pasta) {
  try {
    return fs.readdirSync(pasta, { recursive: true, withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

/** Dois nomes do mesmo arquivo físico: o conteúdo já está no destino. Sem `ino`, sem o par ou com conteúdo diferente, não dá para afirmar. */
function mesmoArquivoFisico(a, b) {
  try {
    const [inoA, inoB] = [a, b].map((c) => fs.statSync(c, { bigint: true }).ino)
    return Boolean(inoA) && inoA === inoB && mesmoConteudo(a, b)
  } catch {
    return false
  }
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
    caminhosDeOutros: db.prepare(`SELECT caminho_xml FROM notas WHERE cliente_id <> @id AND caminho_xml IS NOT NULL
      UNION SELECT e.caminho_xml FROM eventos e JOIN notas n ON n.chave = e.chave WHERE n.cliente_id <> @id AND e.caminho_xml IS NOT NULL`).pluck(),
    caminhoNota: db.prepare('UPDATE notas SET caminho_xml = ? WHERE id = ?'),
    caminhoEvento: db.prepare('UPDATE eventos SET caminho_xml = ? WHERE id = ?'),
    outroNaPasta: db.prepare("SELECT 1 FROM notas WHERE cliente_id <> ? AND lower(substr(replace(caminho_xml, char(92), '/'), 1, ?)) = lower(?) LIMIT 1"),
    layout: db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck(),
    gravarSistema: db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
    apagarSistema: db.prepare('DELETE FROM sistema WHERE chave = ?'),
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
      sql.apagarSistema.run(chavePastaPendente(atual.id))
      sql.apagarExecucoes.run(atual.id)
      sql.apagar.run(atual.id)
    })()
    fs.rmSync(path.join(config.pastaCerts, atual.cert_arquivo), { force: true })
    logger.info('Escritório excluído', { cnpj: atual.cnpj })
    return atual
  }

  // O nome da pasta vem do nome do cliente. Banco primeiro, depois a pasta; se ela não mudar (aberta no Windows, por exemplo),
  // o banco volta e os XMLs continuam acessíveis onde estão.
  function moverPastaDoCliente(antiga, nova, aoFalhar = () => {}) {
    if (antiga === nova) return null
    const origem = path.join(config.pastaXmls, antiga)
    const destino = path.join(config.pastaXmls, nova)
    if (!fs.existsSync(origem)) return null
    const aviso = `Os XMLs antigos continuam na pasta "${antiga}"; os novos vão para "${nova}".`
    if (antiga.toLowerCase() !== nova.toLowerCase() && fs.existsSync(destino)) return aviso
    const prefixo = `${antiga}/`
    const dentro = (r) => r.caminho_xml.replace(/\\/g, '/').startsWith(prefixo)
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
      aoFalhar(e)
      return aviso
    }
  }

  // Notas e eventos dentro da pasta, por caminho relativo a ela (com /, em minúsculas).
  function linhasDaPasta(pasta) {
    const prefixo = `${pasta}/`.toLowerCase()
    const porArquivo = new Map()
    const juntar = (linhas, atualizar) => {
      for (const { id, caminho_xml: caminho } of linhas) {
        const normal = barraNormal(caminho).toLowerCase()
        if (!normal.startsWith(prefixo)) continue
        const chave = normal.slice(prefixo.length)
        if (!porArquivo.has(chave)) porArquivo.set(chave, [])
        porArquivo.get(chave).push({ id, caminho, atualizar })
      }
    }
    juntar(sql.caminhosNotas.all(), sql.caminhoNota)
    juntar(sql.caminhosEventos.all(), sql.caminhoEvento)
    return porArquivo
  }

  /**
   * Leva arquivo a arquivo o que está em `antiga` para `nova`, sem sobrescrever, com o banco acompanhando cada arquivo.
   * O que não sair agora (aberto, conteúdo diferente) fica onde está, e o banco dele também.
   * XML que continuar em `antiga`, com ou sem linha no banco, fica em `pasta_pendente:<cliente_id>` e prende os grupos do cliente.
   * Arquivo gerado (relatório, ZIP, PDF) só sai depois de comparado e, se não sair, fica lá sem prender nada.
   * @returns {string[]} problemas para o grupo rejeitar
   */
  function juntarPastas(clienteId, antiga, nova) {
    const origem = path.join(config.pastaXmls, antiga)
    const destino = path.join(config.pastaXmls, nova)
    const porArquivo = linhasDaPasta(antiga)
    const apontar = db.transaction((linhas) => {
      for (const l of linhas) l.atualizar.run(nova + l.caminho.slice(antiga.length), l.id)
    })
    let itens
    try {
      itens = arvoreDe(origem)
    } catch (e) {
      marcarPendente(clienteId, antiga, true)
      return [semLerAPasta(antiga, nova, e)]
    }
    const conflitos = []
    const semIdentidade = []
    const motivos = new Map()
    const naoApagados = []

    for (const item of itens) {
      if (!item.isFile() || item.name.toLowerCase().endsWith('.tmp')) continue
      const de = path.join(item.parentPath, item.name)
      const rel = path.relative(origem, de)
      const para = path.join(destino, rel)
      const chave = barraNormal(rel).toLowerCase()
      const linhas = porArquivo.get(chave) || []
      porArquivo.delete(chave)
      try {
        fs.mkdirSync(path.dirname(para), { recursive: true })
        const nomeNovo = nomearSemSobrescreverSync(de, para)
        if (!nomeNovo) {
          const [inoDe, inoPara] = [de, para].map((a) => fs.statSync(a, { bigint: true }).ino)
          if (inoDe && inoDe === inoPara && mesmoConteudo(de, para)) {
            // Dois nomes do mesmo arquivo, talvez a mesma pasta por junction: nenhum sai.
            // O conteúdo também é comparado: há disco que repete o ino para arquivos diferentes.
            apontar(linhas)
            continue
          }
          if (!mesmoConteudo(de, para)) {
            if (linhas.length || ehXmlGuardado(rel)) conflitos.push(rel)
            else logger.warn('Arquivo mantido na pasta antiga da empresa: conteúdo diferente na nova', { antiga, nova, arquivo: rel })
            continue
          }
          if (!inoDe || !inoPara) {
            apontar(linhas)
            if (linhas.length || ehXmlGuardado(rel)) semIdentidade.push(rel)
            else logger.warn('Arquivo mantido nas duas pastas da empresa: o disco não informa a identidade dele', { antiga, nova, arquivo: rel })
            continue
          }
        }
        // O arquivo já está no destino: daqui em diante, falhar só deixa a sobra na origem.
        apontar(linhas)
        try {
          fs.unlinkSync(de)
        } catch (e) {
          motivos.set(rel, e.code)
          naoApagados.push(rel)
        }
      } catch (e) {
        motivos.set(rel, e.code)
        logger.warn('Arquivo não saiu da pasta antiga da empresa', { arquivo: de, erro: e.code || e.message })
      }
    }
    if (naoApagados.length) logger.warn('Arquivos não apagados da pasta antiga da empresa: já estão na nova', { antiga, nova, arquivos: naoApagados.length, erro: motivos.get(naoApagados[0]) })

    // Quem sobrou no banco sem arquivo na origem: vale o destino, se o arquivo está lá.
    const perdidos = []
    for (const linhas of porArquivo.values()) {
      const rel = barraNormal(linhas[0].caminho).slice(antiga.length + 1)
      if (fs.existsSync(path.join(origem, rel))) continue
      if (fs.existsSync(path.join(destino, rel))) apontar(linhas)
      else perdidos.push(rel)
    }

    const pastas = itens.filter((i) => i.isDirectory()).map((i) => path.join(i.parentPath, i.name))
    for (const d of [...pastas.sort((a, b) => b.length - a.length), origem]) {
      try {
        fs.rmdirSync(d)
      } catch {} // pasta com arquivos ou que já não existe fica como está
    }

    const inicio = `A pasta da empresa está como "${antiga}" e deveria ser "${nova}".`
    const problemas = []
    if (conflitos.length) problemas.push(`${inicio} Estão nas duas com conteúdo diferente, e os dois foram mantidos: ${listaDeNomes(conflitos)}.`)
    if (semIdentidade.length) problemas.push(`${inicio} O disco não informa a identidade destes arquivos e não dá para garantir que são duas pastas de verdade, então os dois lados foram mantidos: ${listaDeNomes(semIdentidade)}.`)
    if (perdidos.length) problemas.push(`${inicio} Não estão em nenhuma das duas: ${listaDeNomes(perdidos)}.`)
    problemas.push(...conferirSobra(clienteId, antiga, nova, { jaDitos: [...conflitos, ...semIdentidade], motivoDe: (rel) => motivos.get(rel) }))
    return problemas
  }

  function marcarPendente(clienteId, pasta, resta) {
    const lista = pastasPendentesDoCliente(db, clienteId).filter((p) => p.toLowerCase() !== pasta.toLowerCase())
    if (resta) lista.push(pasta)
    if (lista.length) sql.gravarSistema.run(chavePastaPendente(clienteId), lista.join('\n'))
    else sql.apagarSistema.run(chavePastaPendente(clienteId))
  }

  const semLerAPasta = (antiga, nova, e) => `A pasta da empresa está como "${antiga}" e deveria ser "${nova}". Não consegui ler a pasta antiga (${e.code || e.message}); o Smart Fiscal tenta de novo na próxima captura.`

  /**
   * Grava ou remove a pendência conforme o XML que restou na pasta antiga.
   * XML com par de mesmo `ino` no destino não conta: o conteúdo já está lá, e nenhum dos dois nomes é apagado.
   * @param {object} [opcoes]
   * @param {string[]} [opcoes.jaDitos] arquivos que outro problema já cita
   * @param {(rel: string) => string|undefined} [opcoes.motivoDe] código do erro que impediu o arquivo de sair
   * @returns {string[]} problemas para o grupo rejeitar
   */
  function conferirSobra(clienteId, antiga, nova, { jaDitos = [], motivoDe = () => undefined } = {}) {
    const origem = path.join(config.pastaXmls, antiga)
    const destino = path.join(config.pastaXmls, nova)
    let xmls
    try {
      xmls = xmlsDe(antiga)
    } catch (e) {
      marcarPendente(clienteId, antiga, true)
      return [semLerAPasta(antiga, nova, e)]
    }
    const restam = xmls.filter((rel) => !mesmoArquivoFisico(path.join(origem, rel), path.join(destino, rel)))
    if (restam.length < xmls.length) logger.warn('Arquivos mantidos nas duas pastas da empresa: são o mesmo arquivo', { antiga, nova, arquivos: xmls.length - restam.length })
    marcarPendente(clienteId, antiga, restam.length > 0)
    const inicio = `A pasta da empresa está como "${antiga}" e deveria ser "${nova}".`
    const porMotivo = Map.groupBy(restam.filter((rel) => !jaDitos.includes(rel)), motivoDe)
    const travados = [...porMotivo].filter(([motivo]) => TRAVAMENTO.has(motivo)).flatMap(([, nomes]) => nomes)
    const problemas = []
    if (travados.length) problemas.push(`${inicio} Feche os arquivos abertos dessa pasta; o Smart Fiscal tenta de novo na próxima captura. Ainda lá: ${listaDeNomes(travados)}.`)
    for (const [motivo, nomes] of porMotivo) {
      if (!TRAVAMENTO.has(motivo)) problemas.push(`${inicio} Não consegui tirar da pasta antiga (${motivo || 'motivo não informado'}); o Smart Fiscal tenta de novo na próxima captura. Ainda lá: ${listaDeNomes(nomes)}.`)
    }
    return problemas
  }

  /** XML guardado na pasta, relativo a ela. Pasta que não existe não tem nenhum; outro erro de leitura lança. */
  function xmlsDe(pasta) {
    const raiz = path.join(config.pastaXmls, pasta)
    return arvoreDe(raiz)
      .filter((i) => i.isFile())
      .map((i) => path.relative(raiz, path.join(i.parentPath, i.name)))
      .filter(ehXmlGuardado)
  }

  /**
   * Pendência numa pasta que já não tem nota do cliente, ao lado de notas de outro: sai sem mover nada se todo XML que restou é de outro cliente.
   * @returns {string[]} problemas para o grupo rejeitar
   */
  function resolverChaveNaPastaDeOutro(cliente, pasta, esperada) {
    let xmls
    try {
      xmls = xmlsDe(pasta)
    } catch (e) {
      return [semLerAPasta(pasta, esperada, e)]
    }
    const deOutros = new Set(sql.caminhosDeOutros.all({ id: cliente.id }).map((c) => barraNormal(c).toLowerCase()))
    const semDono = xmls.filter((rel) => !deOutros.has(barraNormal(path.join(pasta, rel)).toLowerCase()))
    if (!semDono.length) {
      marcarPendente(cliente.id, pasta, false)
      return []
    }
    logger.warn('Pendência mantida: a pasta tem notas de outro cliente e XML que não é dele', { pasta, esperada, arquivos: semDono.length })
    return [`A pasta da empresa está como "${pasta}" e deveria ser "${esperada}". Uma das duas tem notas de outra empresa, e na pasta antiga ainda há XML que não é dela: ${listaDeNomes(semDono)}. O Smart Fiscal não mexe nisso sozinho: confira essa pasta.`]
  }

  /**
   * Leva para a pasta calculada as notas do cliente que estão em outra pasta (rename que falhou, homônimo, escritório renomeado)
   * e o que ficou na pasta pendente: move a pasta, junta com a que já existe ou, se a origem sumiu, reaponta o banco.
   * Formato antigo de pastas fica como está; pasta com notas de outro cliente também, e o motivo vai nos problemas.
   * Quem chama confere o resultado.
   * @returns {string[]} problemas para o grupo rejeitar
   */
  function reconciliarPasta(cliente) {
    if (sql.layout.get() !== VERSAO_XML) return []
    // Raiz fora do ar faz toda pasta parecer sumida, e a pendência se perderia.
    if (!fs.existsSync(config.pastaXmls)) return ['A pasta principal está indisponível: a pasta da empresa fica como está.']
    const esperada = pastaDoClienteNoDisco(cliente, sql.listar.all())
    const temOutroCliente = (pasta) => sql.outroNaPasta.get(cliente.id, pasta.length + 1, `${pasta}/`)
    const problemas = []
    const vistas = new Set()
    const noBanco = pastasDoClienteNoBanco(db, cliente.id)
    for (const pasta of [...noBanco, ...pastasPendentesDoCliente(db, cliente.id)]) {
      if (vistas.has(pasta.toLowerCase())) continue
      vistas.add(pasta.toLowerCase())
      if (pasta.toLowerCase() === esperada.toLowerCase()) {
        marcarPendente(cliente.id, pasta, false)
        continue
      }
      if (temOutroCliente(pasta) || temOutroCliente(esperada)) {
        if (!noBanco.some((p) => p.toLowerCase() === pasta.toLowerCase())) {
          problemas.push(...resolverChaveNaPastaDeOutro(cliente, pasta, esperada))
          continue
        }
        logger.warn('Pasta do cliente não mexida: tem notas de outro cliente', { pasta, esperada })
        problemas.push(`A pasta da empresa está como "${pasta}" e deveria ser "${esperada}". Uma das duas tem notas de outra empresa, e o Smart Fiscal não mexe nelas sozinho: confira essas pastas.`)
        continue
      }
      if (fs.existsSync(path.join(config.pastaXmls, pasta)) && !fs.existsSync(path.join(config.pastaXmls, esperada))) {
        let erroAoMover
        const aviso = moverPastaDoCliente(pasta, esperada, (e) => (erroAoMover = e))
        if (aviso) logger.warn('Pasta do cliente segue com outro nome', { pasta, esperada })
        problemas.push(...conferirSobra(cliente.id, pasta, esperada, { motivoDe: () => erroAoMover?.code }))
      } else {
        problemas.push(...juntarPastas(cliente.id, pasta, esperada))
      }
    }
    return problemas
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
      sql.apagarSistema.run(chavePastaPendente(atual.id))
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

  return { cadastrar, cadastrarEscritorio, editarEscritorio, excluirEscritorio, obterEscritorio, trocarCertificado, definirAtivo, definirAutomatica, definirAutomaticaDeVarios, editar, excluir, listar, obter, validarCertificado, reconciliarPasta }
}

module.exports = { criarServicoClientes, cnpjValido, somenteDigitos, DIAS_ALERTA_CERT, COLUNAS_PUBLICAS, DA_CARTEIRA }
