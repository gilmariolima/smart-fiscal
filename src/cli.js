#!/usr/bin/env node
'use strict'

// Entrada da linha de comando: node src/cli.js <comando>  (ou npm run cli -- <comando>)

const fs = require('node:fs')
const path = require('node:path')
const { Command } = require('commander')
const { perguntarOculto, perguntarTexto } = require('./terminal')
const { EVENTOS_MANUAIS } = require('./services/manifestacao')
const { CNPJ_MOCK_OK, CNPJ_MOCK_656 } = require('./sefaz/mock-client')

// ---------- formatação ----------

function tabela(linhas, colunas) {
  if (!linhas.length) return '(nenhum registro)'
  const larguras = colunas.map(([titulo, campo]) => Math.max(titulo.length, ...linhas.map((l) => String(l[campo] ?? '').length)))
  const linha = (valores) => valores.map((v, i) => String(v ?? '').padEnd(larguras[i])).join('  ').trimEnd()
  return [linha(colunas.map((c) => c[0])), larguras.map((l) => '-'.repeat(l)).join('  '), ...linhas.map((l) => linha(colunas.map((c) => l[c[1]])))].join('\n')
}

const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : '')
const corta = (s, n) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s)

function descreverCert(c) {
  if (!c.cert_validade) return ''
  const data = c.cert_validade.slice(0, 10).split('-').reverse().join('/')
  if (c.cert_dias < 0) return `${data} VENCIDO`
  if (c.cert_dias < 30) return `${data} (vence em ${c.cert_dias} d)`
  return data
}

function linhaResultado(r) {
  const partes = []
  if (r.captura) {
    const c = r.captura
    partes.push(c.pulado ? `consulta pulada (${c.pulado})` : c.ok ? `consulta ${c.docs} doc(s), cStat ${c.cStat}` : `consulta com ERRO: ${c.erro}`)
  }
  if (r.ciencia) {
    const c = r.ciencia
    partes.push(c.pulado ? `ciência pulada (${c.pulado})` : c.ok ? `ciência ${c.enviadas}/${c.pendentes}${c.erros ? `, ${c.erros} rejeitada(s)` : ''}` : `ciência com ERRO: ${c.erro}`)
  }
  if (r.download) {
    const d = r.download
    partes.push(d.pulado ? `download pulado (${d.pulado})` : d.ok ? `download ${d.baixadas}/${d.consultas}` : `download com ERRO: ${d.erro}`)
  }
  if (r.erro) partes.push(`ERRO: ${r.erro}`)
  return `${r.cnpj}: ${partes.join(' | ')}`
}

// ---------- programa ----------

/**
 * @param {object} io
 * @param {Function} io.contexto     () => contexto (criarContexto); chamado só quando um comando precisa
 * @param {Function} [io.contextoTroca] () => contexto sem a checagem de ambiente (ambiente:producao)
 * @param {Function} [io.log]
 * @param {Function} [io.senha]      (mensagem) => Promise<string>
 * @param {Function} [io.texto]      (mensagem) => Promise<string>
 * @param {boolean}  [io.entradaInterativa] stdin é um terminal (para confirmar o manifestar)
 */
function criarPrograma(io) {
  const log = io.log || ((m) => console.log(m))
  const pedirSenha = io.senha || perguntarOculto
  const pedirTexto = io.texto || perguntarTexto
  let ctx = null
  const contexto = () => (ctx ||= io.contexto())

  const programa = new Command()
  programa
    .name('smartdoc')
    .description('Captura de NF-e destinadas aos clientes do escritório (SEFAZ NFeDistribuicaoDFe).')
    .showHelpAfterError()

  programa
    .command('cliente:add')
    .description('Cadastra um cliente e o certificado A1 (a senha é pedida sem aparecer na tela)')
    .requiredOption('--cnpj <cnpj>', 'CNPJ do cliente')
    .requiredOption('--razao <razao>', 'razão social')
    .requiredOption('--uf <uf>', 'UF do cliente (ex.: CE)')
    .requiredOption('--pfx <caminho>', 'arquivo .pfx/.p12 do certificado')
    .option('--apelido <apelido>', 'nome curto usado na pasta dos XMLs')
    .action(async (o) => {
      const pfx = lerArquivo(o.pfx)
      const senha = await pedirSenha('Senha do certificado: ')
      const { cliente, certificado, avisos } = contexto().clientes.cadastrar({ cnpj: o.cnpj, razao: o.razao, uf: o.uf, apelido: o.apelido, pfx, senha })
      log(`Cliente cadastrado: ${cliente.cnpj} - ${cliente.razao_social}`)
      log(`Certificado: ${certificado.titular} | válido até ${dataHora(certificado.validade)}`)
      for (const a of avisos) log(`Atenção: ${a}`)
    })

  programa
    .command('cliente:cert')
    .description('Troca o certificado de um cliente (renovação)')
    .requiredOption('--cnpj <cnpj>', 'CNPJ do cliente')
    .requiredOption('--pfx <caminho>', 'novo arquivo .pfx/.p12')
    .action(async (o) => {
      const pfx = lerArquivo(o.pfx)
      const senha = await pedirSenha('Senha do novo certificado: ')
      const { cliente, certificado, avisos } = contexto().clientes.trocarCertificado({ cnpj: o.cnpj, pfx, senha })
      log(`Certificado trocado: ${cliente.cnpj} | válido até ${dataHora(certificado.validade)}`)
      for (const a of avisos) log(`Atenção: ${a}`)
    })

  programa
    .command('escritorio:add')
    .description('Cadastra o escritório e o certificado A1 dele (notas de saída pelo autXML)')
    .requiredOption('--cnpj <cnpj>', 'CNPJ do escritório')
    .requiredOption('--razao <razao>', 'razão social')
    .requiredOption('--uf <uf>', 'UF do escritório (ex.: CE)')
    .requiredOption('--pfx <caminho>', 'arquivo .pfx/.p12 do certificado')
    .action(async (o) => {
      const pfx = lerArquivo(o.pfx)
      const senha = await pedirSenha('Senha do certificado: ')
      const { cliente, certificado, avisos } = contexto().clientes.cadastrarEscritorio({ cnpj: o.cnpj, razao: o.razao, uf: o.uf, pfx, senha })
      log(`Escritório cadastrado: ${cliente.cnpj} - ${cliente.razao_social}`)
      log(`Certificado: ${certificado.titular} | válido até ${dataHora(certificado.validade)}`)
      for (const a of avisos) log(`Atenção: ${a}`)
    })

  programa
    .command('escritorio:cert')
    .description('Troca o certificado do escritório (renovação)')
    .requiredOption('--pfx <caminho>', 'novo arquivo .pfx/.p12')
    .action(async (o) => {
      const escritorio = contexto().clientes.obterEscritorio()
      if (!escritorio) throw new Error('Nenhum escritório cadastrado. Use escritorio:add.')
      const pfx = lerArquivo(o.pfx)
      const senha = await pedirSenha('Senha do novo certificado: ')
      const { cliente, certificado, avisos } = contexto().clientes.trocarCertificado({ cnpj: escritorio.cnpj, pfx, senha })
      log(`Certificado do escritório trocado: ${cliente.cnpj} | válido até ${dataHora(certificado.validade)}`)
      for (const a of avisos) log(`Atenção: ${a}`)
    })

  programa
    .command('cliente:list')
    .description('Lista os clientes')
    .action(() => {
      const linhas = contexto().clientes.listar().map((c) => ({
        cnpj: c.cnpj,
        nome: corta(c.apelido || c.razao_social, 30),
        papel: c.papel,
        ativo: c.ativo ? 'sim' : 'não',
        ult_nsu: c.ult_nsu,
        consulta: dataHora(c.ultima_consulta),
        erro: corta(c.ultimo_erro, 40),
        cert: descreverCert(c),
      }))
      log(tabela(linhas, [['CNPJ', 'cnpj'], ['Nome', 'nome'], ['Papel', 'papel'], ['Ativo', 'ativo'], ['ultNSU', 'ult_nsu'], ['Última consulta', 'consulta'], ['Último erro', 'erro'], ['Certificado', 'cert']]))
    })

  for (const [nome, ativo] of [['cliente:ativar', true], ['cliente:desativar', false]]) {
    programa
      .command(nome)
      .description(ativo ? 'Volta a capturar as notas do cliente' : 'Para de capturar as notas do cliente')
      .requiredOption('--cnpj <cnpj>', 'CNPJ do cliente')
      .action((o) => {
        const c = contexto().clientes.definirAtivo(o.cnpj, ativo)
        log(`${c.cnpj} ${ativo ? 'ativado' : 'desativado'}.`)
      })
  }

  programa
    .command('cliente:demo')
    .description('Só com SEFAZ_MOCK=1: cadastra dois clientes de demonstração com certificado simulado')
    .action(() => {
      const c = contexto()
      if (!c.config.sefazMock) throw new Error('cliente:demo só funciona com SEFAZ_MOCK=1.')
      const { gerarPfx } = require('./sefaz/mock-certificado')
      for (const [cnpj, razao, apelido] of [[CNPJ_MOCK_OK, 'Comercial Exemplo Ltda', 'Exemplo'], [CNPJ_MOCK_656, 'Loja Bloqueada Ltda', 'Bloqueada']]) {
        if (c.clientes.obter(cnpj)) {
          log(`${cnpj} já cadastrado.`)
          continue
        }
        const { pfx, senha } = gerarPfx({ cnpj, razao: razao.toUpperCase() })
        c.clientes.cadastrar({ cnpj, razao, uf: 'CE', apelido, pfx, senha })
        log(`${cnpj} cadastrado (${razao}).`)
      }
    })

  const opcaoCnpj = (cmd) => cmd.option('--cnpj <cnpj>', 'só este cliente (padrão: todos os ativos)')

  async function rodar(fn, o) {
    const r = await fn({ cnpj: o.cnpj ? o.cnpj.replace(/\D/g, '') : undefined, forcar: !!o.forcar })
    if (!r.ok) throw new Error(r.erro)
    if (!r.clientes.length && !r.escritorio) log('Nenhum cliente ativo.')
    if (r.escritorio) {
      const c = r.escritorio.captura
      const extra = c && c.ok && (c.saida || c.fora) ? ` | saída ${c.saida || 0}, fora da carteira ${c.fora || 0}` : ''
      log(`Escritório ${linhaResultado(r.escritorio)}${extra}`)
    }
    for (const linha of r.clientes) log(linhaResultado(linha))
  }

  opcaoCnpj(programa.command('capturar'))
    .description('Ciclo completo: consulta por NSU → ciência → download dos XMLs')
    .option('--forcar', 'ignora a espera de 1 h após "nenhum documento" (não ignora bloqueio por consumo indevido)')
    .action((o) => rodar(contexto().ciclo.executarCiclo, o))

  opcaoCnpj(programa.command('ciencia'))
    .description('Só envia a ciência das notas em resumo')
    .action((o) => rodar(contexto().ciclo.somenteCiencia, o))

  opcaoCnpj(programa.command('baixar'))
    .description('Só tenta baixar o XML das notas com ciência enviada')
    .action((o) => rodar(contexto().ciclo.somenteDownload, o))

  programa
    .command('exportar')
    .description('Gera o ZIP (XMLs + resumo.csv) do cliente na competência, para o Domínio/Fortes')
    .requiredOption('--cnpj <cnpj>', 'CNPJ do cliente')
    .requiredOption('--competencia <AAAA-MM>', 'mês de emissão das notas (ex.: 2026-10)')
    .action(async (o) => {
      const r = await contexto().exportacao.exportar({ cnpj: o.cnpj, competencia: o.competencia })
      log(`Arquivo: ${r.arquivo}`)
      const { entrada: e, saida: s } = r.porTipo
      log(`Entradas: ${e.xmls} XML(s) em entradas/xml/, ${e.canceladas} em entradas/canceladas/ | Saídas: ${s.xmls} XML(s) em saidas/xml/, ${s.canceladas} em saidas/canceladas/.`)
      log(`${r.semXml} nota(s) ainda sem XML completo (listadas no resumo.csv).`)
      for (const a of r.avisos) log(`Atenção: ${a}`)
    })

  programa
    .command('backup')
    .description('Copia agora o banco, os certificados, o .env e os XMLs novos para a PASTA_BACKUP')
    .action(async () => {
      const r = await contexto().backup.fazerBackup({ forcar: true })
      if (r.desligado) return log('Backup desligado: defina PASTA_BACKUP no .env (ex.: PASTA_BACKUP=D:\\Backup\\SmartFiscal).')
      if (!r.ok) throw new Error(r.erro)
      log(`Backup feito: ${r.xmlsNovos} XML(s) novo(s) e a cópia de ${r.dia}.`)
    })

  programa
    .command('manifestar')
    .description('Evento conclusivo manual (pede confirmação)')
    .requiredOption('--chave <chave>', 'chave de acesso (44 dígitos)')
    .requiredOption('--evento <evento>', Object.keys(EVENTOS_MANUAIS).join(' | '))
    .option('--justificativa <texto>', 'obrigatória para nao-realizada (15 a 255 caracteres)')
    .option('--cnpj <cnpj>', 'CNPJ do cliente (obrigatório se a chave estiver em mais de um cliente)')
    .option('--sim', 'não pergunta a confirmação (uso em scripts)')
    .action(async (o) => {
      const c = contexto()
      const tipo = EVENTOS_MANUAIS[o.evento]
      if (!tipo) throw new Error(`Evento inválido: ${o.evento}. Use ${Object.keys(EVENTOS_MANUAIS).join(', ')}.`)
      const chave = o.chave.replace(/\D/g, '')
      const cnpj = o.cnpj ? o.cnpj.replace(/\D/g, '') : null
      const consulta = 'SELECT n.*, c.cnpj FROM notas n JOIN clientes c ON c.id = n.cliente_id WHERE n.chave = ?'
      let nota
      if (cnpj) {
        nota = c.db.prepare(`${consulta} AND c.cnpj = ?`).get(chave, cnpj)
        if (nota && nota.tipo !== 'entrada') throw new Error('Manifestação só vale para nota de entrada.')
      } else {
        const linhas = c.db.prepare(`${consulta} AND n.tipo = 'entrada'`).all(chave)
        if (linhas.length > 1) throw new Error('Chave em mais de um cliente: informe o CNPJ.')
        nota = linhas[0]
      }
      if (!nota) throw new Error('Nota não encontrada no banco.')
      log(`Nota ${nota.numero || '?'} série ${nota.serie || '?'} | emitente ${nota.emitente_nome || '?'} (${nota.emitente_cnpj || '?'})`)
      log(`Valor ${nota.valor_total ?? '?'} | destinatário ${nota.cnpj} | evento: ${tipo.descricao} (${tipo.codigo})`)
      if (!o.sim) {
        if (io.entradaInterativa === false) throw new Error('Sem terminal para confirmar: use --sim.')
        const r = (await pedirTexto('Este evento é definitivo na SEFAZ. Confirmar? (s/N) ')).trim().toLowerCase()
        if (r !== 's' && r !== 'sim') {
          log('Cancelado.')
          return
        }
      }
      const r = await c.ciclo.manifestar({ chave, evento: o.evento, justificativa: o.justificativa, cnpj })
      if (!r.ok) throw new Error(r.erro)
      log(`Evento registrado: cStat ${r.cStat}, protocolo ${r.protocolo || '-'}`)
    })

  programa
    .command('servidor')
    .description('Modo do dia a dia: agendador + painel web (Ctrl+C para parar)')
    .option('--sem-ciclo-inicial', 'não roda um ciclo logo ao iniciar; espera o horário do cron')
    .option('--atraso-inicial <segundos>', 'espera antes do primeiro ciclo (padrão 15)')
    .action(async (o) => {
      const c = io.contextoServidor ? (ctx ||= io.contextoServidor()) : contexto()
      const { iniciarServidor, aguardarEncerramento } = require('./servidor')
      const atraso = o.atrasoInicial !== undefined ? Math.max(0, Number(o.atrasoInicial) || 0) * 1000 : undefined
      const servidor = await iniciarServidor(c, { atrasoInicialMs: o.semCicloInicial ? false : atraso })
      const e = servidor.agendador.estado()
      log(`Servidor rodando (${c.config.tpAmb === '1' ? 'PRODUÇÃO' : 'homologação'}${c.config.sefazMock ? ', SEFAZ simulada' : ''}).`)
      log(`Painel: ${servidor.painel.url}`)
      log(e.automatica
        ? `Agendamento: ${e.cron} | próxima execução: ${dataHora(e.proximaExecucao)}${o.semCicloInicial ? '' : ' | primeiro ciclo em instantes'}`
        : `Agendamento: ${e.cron} | busca automática DESLIGADA (ligue no painel, em Visão geral)`)
      log('Ctrl+C para parar. Detalhes em logs/app.log.')
      await aguardarEncerramento(servidor, c.logger)
    })

  programa
    .command('ambiente:producao')
    .description('Passa o banco de homologação para produção: zera a fila da SEFAZ de todos os clientes e descarta as notas de teste')
    .option('--sim', 'não pergunta a confirmação (uso em scripts)')
    .action(async (o) => {
      const c = (ctx ||= (io.contextoTroca || io.contexto)())
      const { previaProducao, conferirTrocaParaProducao, passarParaProducao, NOMES } = require('./ambiente')
      conferirTrocaParaProducao(c.db, c.config)
      const p = previaProducao(c.db)
      log(`Banco em ${NOMES[p.ambienteBanco] || 'ambiente não registrado'} | ${p.clientes} cliente(s), ${p.notas} nota(s) e ${p.eventos} evento(s) de teste.`)
      log('Os clientes e os certificados continuam. A posição na fila da SEFAZ de todos volta para o início, e as notas, os eventos e os XMLs de teste são apagados.')
      if (!o.sim) {
        if (io.entradaInterativa === false) throw new Error('Sem terminal para confirmar: use --sim.')
        const r = (await pedirTexto('Passar para produção? (s/N) ')).trim().toLowerCase()
        if (r !== 's' && r !== 'sim') {
          log('Cancelado.')
          return
        }
      }
      const r = passarParaProducao(c)
      log(`Banco em produção. ${r.clientes} cliente(s) com a fila zerada; ${r.notas} nota(s), ${r.eventos} evento(s) e ${r.xmls} XML(s) de teste apagados.`)
      log('A próxima captura busca as notas reais dos últimos ~3 meses de cada cliente.')
    })

  programa
    .command('status')
    .description('Resumo geral: notas por status, clientes com erro, próximas consultas')
    .action(() => {
      const c = contexto()
      const r = c.resumo.resumo()
      log(`Ambiente: ${c.config.tpAmb === '1' ? 'PRODUÇÃO' : 'homologação'}${c.config.sefazMock ? ' (SEFAZ simulada)' : ''}`)
      log(`Clientes ativos: ${r.clientesAtivos} de ${r.clientesTotal} | notas em ${r.competenciaAtual}: ${r.notasNoMes} | sem XML completo: ${r.notasSemXml}`)
      const escritorio = c.clientes.obterEscritorio()
      log(escritorio ? `Escritório: ${escritorio.cnpj} - ${escritorio.razao_social} | ${escritorio.ativo ? 'ativo' : 'inativo'} | certificado até ${dataHora(escritorio.cert_validade)}` : 'Escritório: não cadastrado (use escritorio:add)')
      const [proxima] = require('./scheduler').proximosHorarios(c.config.cronCaptura)
      const auto = c.automacao.obter()
      log(`Busca automática: ${auto.captura ? 'ligada' : 'desligada'} | ciência automática: ${auto.ciencia ? 'ligada' : 'desligada'} (mude no painel, em Visão geral)`)
      log(`Agendamento: ${c.config.cronCaptura} | próximo horário: ${dataHora(proxima)} (com o servidor rodando${auto.captura ? '' : ', mas a busca automática está desligada'})`)
      log('\nNotas por status:')
      log(tabela(r.notasPorStatus, [['Status', 'status'], ['Total', 'total'], ['Canceladas', 'canceladas']]))
      log('\nClientes com erro:')
      log(tabela(r.clientesComErro.map((e) => ({ ...e, erro: corta(e.ultimo_erro, 60), quando: dataHora(e.ultima_consulta) })), [['CNPJ', 'cnpj'], ['Nome', 'nome'], ['Erro', 'erro'], ['Quando', 'quando']]))
      if (r.certificadosVencendo.length) {
        log('\nCertificados vencendo:')
        log(tabela(r.certificadosVencendo.map((v) => ({ ...v, dias: v.dias < 0 ? 'VENCIDO' : `${v.dias} d` })), [['CNPJ', 'cnpj'], ['Nome', 'nome'], ['Dias', 'dias']]))
      }
      const agenda = r.agenda.filter((a) => a.bloqueadoAte || a.proximaConsulta)
      log('\nPróximas consultas liberadas:')
      log(tabela(agenda.map((a) => ({ ...a, quando: a.bloqueadoAte ? `${dataHora(a.bloqueadoAte)} (bloqueado 656)` : dataHora(a.proximaConsulta) })), [['CNPJ', 'cnpj'], ['Nome', 'nome'], ['Liberado em', 'quando']]))
    })

  programa.hook('postAction', () => {
    if (ctx) ctx.fechar()
    ctx = null
  })

  return programa
}

function lerArquivo(caminho) {
  const p = path.resolve(caminho)
  if (!fs.existsSync(p)) throw new Error(`Arquivo não encontrado: ${p}`)
  return fs.readFileSync(p)
}

async function principal(argv = process.argv) {
  const { criarContexto } = require('./contexto')
  // No terminal só avisos e erros; o detalhe completo fica em logs/app.log.
  // O servidor mostra também as informações (é o que aparece no log do serviço).
  const programa = criarPrograma({
    contexto: () => criarContexto({ nivelConsole: 'warn' }),
    contextoServidor: () => criarContexto({ nivelConsole: 'info' }),
    contextoTroca: () => criarContexto({ nivelConsole: 'warn', verificarAmbiente: false }),
    entradaInterativa: !!process.stdin.isTTY,
  })
  try {
    await programa.parseAsync(argv)
  } catch (e) {
    console.error(`Erro: ${e.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) principal()

module.exports = { criarPrograma, tabela }
