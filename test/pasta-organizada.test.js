'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { criarGrupos } = require('../src/services/pastaOrganizada')
const { montarAmbiente } = require('./apoio/ambiente')

const CNPJS = ['11222333000181', '44555666000199']
const AGORA = new Date('2026-10-09T12:00:00Z')

function preparar(t) {
  const amb = montarAmbiente({ clientes: CNPJS })
  t.after(amb.limpar)
  let seq = 0
  const nota = ({ cliente = amb.ids[0], modelo = 'nfe', competencia = '2026-10', status = 'completa', caminho = 'x.xml', atualizado = '2026-10-01 10:00:00' } = {}) => {
    const chave = String(++seq).padStart(44, '0')
    amb.db
      .prepare('INSERT INTO notas (cliente_id, chave, modelo, status, competencia, caminho_xml, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cliente, chave, modelo, status, competencia, caminho, atualizado)
    return chave
  }
  const evento = (chave, n = 1) => amb.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq) VALUES (?, '110111', ?)").run(chave, String(n))
  const grupos = criarGrupos({ db: amb.db, agora: () => AGORA })
  const marcarTodos = () => grupos.pendentes().forEach((g) => grupos.marcarPronto(g))
  return { ...amb, nota, evento, grupos, marcarTodos }
}

test('grupo novo fica pendente e, marcado, deixa de ficar', (t) => {
  const a = preparar(t)
  a.nota()
  const [g, ...resto] = a.grupos.pendentes()
  assert.equal(resto.length, 0)
  assert.equal(g.clienteId, a.ids[0])
  assert.equal(g.competencia, '2026-10')
  assert.equal(g.modelo, 'nfe')
  assert.equal(typeof g.assinatura, 'string')
  assert.equal(g.eventos, 0)
  assert.equal(g.eventosAntes, null)

  a.grupos.marcarPronto(g)
  assert.deepEqual(a.grupos.pendentes(), [])
  const linha = a.db.prepare('SELECT * FROM pasta_grupos').get()
  assert.equal(linha.assinatura, g.assinatura)
  assert.equal(linha.gerado_em, AGORA.toISOString())
})

const mudancas = [
  ['nota nova', (a) => a.nota()],
  ['nota atualizada', (a) => a.db.prepare("UPDATE notas SET atualizado_em = '2026-10-02 09:00:00'").run()],
  ['nota cancelada', (a) => a.db.prepare('UPDATE notas SET cancelada = 1').run()],
  ['evento novo', (a, chave) => a.evento(chave)],
  ['nome da empresa', (a) => a.db.prepare("UPDATE clientes SET apelido = 'Outro nome' WHERE id = ?").run(a.ids[0])],
]
for (const [nome, mudanca] of mudancas) {
  test(`volta a ficar pendente: ${nome}`, (t) => {
    const a = preparar(t)
    const chave = a.nota()
    a.marcarTodos()
    assert.deepEqual(a.grupos.pendentes(), [])
    mudanca(a, chave)
    const [g, ...resto] = a.grupos.pendentes()
    assert.equal(resto.length, 0)
    assert.equal(g.clienteId, a.ids[0])
  })
}

test('evento novo muda a contagem de eventos e guarda a anterior', (t) => {
  const a = preparar(t)
  const chave = a.nota()
  a.evento(chave)
  a.marcarTodos()
  a.evento(chave, 2)
  const [g] = a.grupos.pendentes()
  assert.equal(g.eventos, 2)
  assert.equal(g.eventosAntes, 1)
  a.grupos.marcarPronto(g)
  assert.equal(a.db.prepare('SELECT eventos FROM pasta_grupos').get().eventos, 2)
})

test('mudança só em nota não mexe nos eventos', (t) => {
  const a = preparar(t)
  const chave = a.nota()
  a.evento(chave)
  a.marcarTodos()
  a.nota()
  const [g] = a.grupos.pendentes()
  assert.equal(g.eventos, 1)
  assert.equal(g.eventosAntes, 1)
})

test('evento de nota de outro grupo não conta', (t) => {
  const a = preparar(t)
  a.nota()
  const outra = a.nota({ competencia: '2026-09' })
  a.evento(outra)
  const porMes = Object.fromEntries(a.grupos.pendentes().map((g) => [g.competencia, g.eventos]))
  assert.deepEqual(porMes, { '2026-10': 0, '2026-09': 1 })
})

test('nada mudou: nada pendente', (t) => {
  const a = preparar(t)
  a.nota()
  a.nota({ modelo: 'cte' })
  a.marcarTodos()
  assert.deepEqual(a.grupos.pendentes(), [])
  assert.deepEqual(a.grupos.pendentes(), [])
})

test('mais recente primeiro', (t) => {
  const a = preparar(t)
  a.nota({ competencia: '2025-12' })
  a.nota({ competencia: '2026-10' })
  a.nota({ competencia: '2026-02' })
  assert.deepEqual(
    a.grupos.pendentes().map((g) => g.competencia),
    ['2026-10', '2026-02', '2025-12'],
  )
})

test('fica de fora: sem competência, fora da carteira e escritório que não é cliente', (t) => {
  const a = preparar(t)
  a.nota({ competencia: null })
  a.nota({ caminho: 'Cliente 1/fora-da-carteira/2026/10-Outubro/Entradas/NF-e/XML/a.xml' })
  a.nota({ caminho: 'Cliente 1\\fora-da-carteira\\2026\\10-Outubro\\Entradas\\NF-e\\XML\\b.xml', competencia: '2026-09' })
  a.db.prepare("UPDATE clientes SET papel = 'escritorio' WHERE id = ?").run(a.ids[1])
  a.nota({ cliente: a.ids[1] })
  assert.deepEqual(a.grupos.pendentes(), [])

  a.db.prepare('UPDATE clientes SET tambem_cliente = 1 WHERE id = ?').run(a.ids[1])
  assert.deepEqual(
    a.grupos.pendentes().map((g) => g.clienteId),
    [a.ids[1]],
  )
})

test('nota fora da carteira não entra na contagem do grupo', (t) => {
  const a = preparar(t)
  a.nota()
  a.nota({ caminho: 'Cliente 1/fora-da-carteira/2026/10-Outubro/Entradas/NF-e/XML/a.xml' })
  a.marcarTodos()
  assert.deepEqual(a.grupos.pendentes(), [])
  a.nota({ caminho: 'Cliente 1/fora-da-carteira/2026/10-Outubro/Entradas/NF-e/XML/c.xml' })
  assert.deepEqual(a.grupos.pendentes(), [])
})

test('dois clientes com o mesmo nome têm grupos separados', (t) => {
  const a = preparar(t)
  a.db.prepare("UPDATE clientes SET apelido = 'Igual'").run()
  a.nota({ cliente: a.ids[0] })
  a.nota({ cliente: a.ids[1] })
  const grupos = a.grupos.pendentes()
  assert.equal(grupos.length, 2)
  assert.notEqual(grupos[0].assinatura, grupos[1].assinatura)
  a.grupos.marcarPronto(grupos[0])
  assert.equal(a.grupos.pendentes().length, 1)
})

test('mês só com resumos também é grupo', (t) => {
  const a = preparar(t)
  a.nota({ status: 'resumo', caminho: null })
  const [g, ...resto] = a.grupos.pendentes()
  assert.equal(resto.length, 0)
  assert.equal(g.modelo, 'nfe')
})

// ---- Geração dos arquivos do grupo ----

const fs = require('node:fs')
const path = require('node:path')
const { criarGerador } = require('../src/services/pastaOrganizada')
const { caminhoDa } = require('../src/services/armazenamento')
const { lerZip } = require('./apoio/zip')
const { nfeProc, item } = require('./apoio/nfe')
const { cteProc } = require('./apoio/cte')

const fortaleza = fs.readFileSync(path.join(__dirname, 'apoio', 'nfse', 'fortaleza.xml'), 'utf8')
const ANTIGA = '2026-01-01 00:00:00'
const FUTURA = '2999-01-01 00:00:00'
const ZIP_NFE = 'Cliente 1 NF-e Entradas Novembro 2026.zip'
const XLSX_NFE = 'Relatorio NF-e Entradas Novembro 2026.xlsx'
const PDF_NFE = 'Relatorio NF-e Entradas Novembro 2026.pdf'

function prepararDisco(t, opcoes = {}) {
  const amb = montarAmbiente({ clientes: CNPJS })
  t.after(amb.limpar)
  let seq = 0
  const raiz = amb.pastaXmls
  const abs = (...p) => path.join(raiz, ...p)
  const existe = (...p) => fs.existsSync(abs(...p))
  const nota = ({ cliente = amb.ids[0], modelo = 'nfe', competencia = '2026-11', pastaMes = competencia, direcao = 'entrada', status = 'completa', xml, semArquivo = false, atualizado = ANTIGA } = {}) => {
    const chave = String(++seq).padStart(modelo === 'nfse' ? 50 : 44, '0')
    const c = amb.db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente)
    const conteudo = xml ?? (modelo === 'nfse' ? fortaleza : modelo === 'cte' ? cteProc({}) : nfeProc({ det: item(1) }))
    const relativo = status === 'completa' ? caminhoDa({ cliente: c, modelo, direcao, competencia: pastaMes, nomeArquivo: `${chave}-${modelo}.xml` }) : null
    if (relativo && !semArquivo) {
      fs.mkdirSync(path.dirname(abs(relativo)), { recursive: true })
      fs.writeFileSync(abs(relativo), conteudo)
    }
    amb.db
      .prepare('INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml, atualizado_em, data_emissao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(cliente, chave, modelo, direcao === 'saida' ? 'saida' : direcao === 'outro' ? 'outro' : 'entrada', status, competencia, relativo, atualizado, `${competencia}-10`)
    return { chave, relativo }
  }
  const config = { pastaXmls: raiz }
  const gerador = criarGerador({ db: amb.db, config, logger: amb.deps.logger, ...opcoes })
  const grupos = criarGrupos({ db: amb.db })
  const grupoDe = ({ competencia = '2026-11', modelo = 'nfe', direcao = 'entrada', clienteId = amb.ids[0] } = {}) =>
    grupos.pendentes().find((g) => g.competencia === competencia && g.modelo === modelo && g.direcao === direcao && g.clienteId === clienteId)
  const gerar = (qual = {}, execucao = {}) => gerador.gerarGrupo(grupoDe(qual), execucao)
  const tmps = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.tmp')) : [])
  const tipo = (modelo = 'NF-e', mes = '11-Novembro', direcao = 'Entradas') => path.join('Cliente 1', '2026', mes, direcao, modelo)
  return { ...amb, nota, abs, existe, gerar, gerador, grupoDe, config, tmps, tipo, raiz }
}

const AVULSOS = path.join('Cliente 1', '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e')
const zipDe = (a, ...p) => lerZip(fs.readFileSync(a.abs(...p)))
const ehPdf = (arquivo) => fs.readFileSync(arquivo).subarray(0, 5).toString() === '%PDF-'

test('entradas e saídas têm pastas, relatórios e ZIP próprios', async (t) => {
  const a = prepararDisco(t)
  const entrada = a.nota()
  const saida = a.nota({ direcao: 'saida' })
  assert.deepEqual(await a.gerar(), { parou: false, avisos: [] })
  const base = a.tipo()
  assert.ok(ehPdf(a.abs(base, 'PDF', `${entrada.chave}-nfe.pdf`)))
  assert.ok(a.existe(base, XLSX_NFE))
  assert.ok(ehPdf(a.abs(base, PDF_NFE)))
  assert.deepEqual([...zipDe(a, base, ZIP_NFE).keys()].sort(), [`PDF/${entrada.chave}-nfe.pdf`, PDF_NFE, XLSX_NFE, `XML/${entrada.chave}-nfe.xml`].sort())
  assert.ok(!a.existe(a.tipo('NF-e', '11-Novembro', 'Saidas'), 'Relatorio NF-e Saidas Novembro 2026.pdf'), 'cada direção é um grupo')

  assert.deepEqual(await a.gerar({ direcao: 'saida' }), { parou: false, avisos: [] })
  const pastaSaida = a.tipo('NF-e', '11-Novembro', 'Saidas')
  const [xlsx, pdf, zip] = ['Relatorio NF-e Saidas Novembro 2026.xlsx', 'Relatorio NF-e Saidas Novembro 2026.pdf', 'Cliente 1 NF-e Saidas Novembro 2026.zip']
  assert.ok(ehPdf(a.abs(pastaSaida, 'PDF', `${saida.chave}-nfe.pdf`)))
  assert.deepEqual([...zipDe(a, pastaSaida, zip).keys()].sort(), [`PDF/${saida.chave}-nfe.pdf`, pdf, xlsx, `XML/${saida.chave}-nfe.xml`].sort())
  assert.ok(a.existe(base, ZIP_NFE), 'a pasta de entradas continua')
})

test('o ZIP não contém a si mesmo nem .tmp, mesmo na segunda geração', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  const base = a.tipo()
  await a.gerar()
  fs.writeFileSync(a.abs(base, 'PDF', 'resto.pdf.1.tmp'), 'x')
  await a.gerar()
  const nomes = [...zipDe(a, base, ZIP_NFE).keys()]
  assert.ok(nomes.includes(`XML/${n.chave}-nfe.xml`))
  assert.ok(!nomes.some((x) => x.endsWith('.zip') || x.endsWith('.tmp')), nomes.join())
})

test('segunda geração só refaz o PDF que falta ou que está mais antigo que a nota', async (t) => {
  const a = prepararDisco(t)
  const [n1, n2, n3] = [a.nota(), a.nota(), a.nota()]
  await a.gerar()
  const pdf = (n) => a.abs(a.tipo(), 'PDF', `${n.chave}-nfe.pdf`)
  fs.writeFileSync(pdf(n1), 'marca1')
  fs.writeFileSync(pdf(n2), 'marca2')
  fs.rmSync(pdf(n3))
  a.db.prepare('UPDATE notas SET atualizado_em = ? WHERE chave = ?').run(FUTURA, n2.chave)
  await a.gerar()
  assert.equal(fs.readFileSync(pdf(n1), 'utf8'), 'marca1')
  assert.ok(ehPdf(pdf(n2)))
  assert.ok(ehPdf(pdf(n3)))
})

test('nota com evento refaz o PDF quando os eventos do grupo mudaram', async (t) => {
  const a = prepararDisco(t)
  const com = a.nota()
  const sem = a.nota()
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq) VALUES (?, '110111', '1')").run(com.chave)
  await a.gerar()
  const pdf = (n) => a.abs(a.tipo(), 'PDF', `${n.chave}-nfe.pdf`)
  fs.writeFileSync(pdf(com), 'marca')
  fs.writeFileSync(pdf(sem), 'marca')
  await a.gerar({}, { eventosMudaram: false })
  assert.equal(fs.readFileSync(pdf(com), 'utf8'), 'marca')
  await a.gerar({}, { eventosMudaram: true })
  assert.ok(ehPdf(pdf(com)))
  assert.equal(fs.readFileSync(pdf(sem), 'utf8'), 'marca')
})

test('PDF sem nota correspondente é apagado; o de nota de outro mês com XML na pasta fica', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  // Nota de outubro com o XML guardado na pasta de novembro: justifica o PDF dela.
  const outro = a.nota({ competencia: '2026-10', pastaMes: '2026-11' })
  // O grupo de outubro gera o PDF da nota dele ao lado do XML, na pasta de novembro.
  await a.gerar({ competencia: '2026-10' })
  await a.gerar()
  const pdfs = path.join(a.tipo(), 'PDF')
  fs.writeFileSync(a.abs(pdfs, 'orfao-nfe.pdf'), 'x')
  fs.writeFileSync(a.abs(pdfs, 'anotacao.txt'), 'x')
  await a.gerar()
  assert.ok(!a.existe(pdfs, 'orfao-nfe.pdf'))
  assert.ok(a.existe(pdfs, 'anotacao.txt'))
  assert.ok(a.existe(pdfs, `${n.chave}-nfe.pdf`))
  assert.ok(a.existe(pdfs, `${outro.chave}-nfe.pdf`))
})

test('relatório e ZIP com outro nome são trocados ao renomear a empresa', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  await a.gerar()
  // Como depois da migração de pastas: tudo foi para a pasta nova, com os relatórios e o ZIP de nome antigo.
  fs.renameSync(a.abs('Cliente 1'), a.abs('Nova Empresa'))
  a.db.prepare("UPDATE clientes SET apelido = 'Nova Empresa' WHERE id = ?").run(a.ids[0])
  a.db.prepare('UPDATE notas SET caminho_xml = replace(caminho_xml, ?, ?)').run('Cliente 1', 'Nova Empresa')
  const nova = path.join('Nova Empresa', '2026', '11-Novembro', 'Entradas', 'NF-e')
  fs.writeFileSync(a.abs(nova, 'Relatorio NF-e Entradas Setembro 2025.xlsx'), 'x')
  fs.writeFileSync(a.abs(nova, 'leia-me.txt'), 'x')
  await a.gerar()
  assert.deepEqual(
    fs.readdirSync(a.abs(nova)).filter((f) => !['PDF', 'XML'].includes(f)).sort(),
    ['Nova Empresa NF-e Entradas Novembro 2026.zip', PDF_NFE, XLSX_NFE, 'leia-me.txt'].sort(),
  )
})

test('resumo não gera PDF nem ZIP; mês só com resumos não tem relatório', async (t) => {
  const a = prepararDisco(t)
  const base = a.tipo()
  const chave = '9'.repeat(44)
  const resumo = path.join(AVULSOS, `${chave}-resumo.xml`)
  fs.mkdirSync(path.dirname(a.abs(resumo)), { recursive: true })
  fs.writeFileSync(a.abs(resumo), '<resNFe/>')
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, status, competencia, caminho_xml) VALUES (?, ?, 'nfe', 'resumo', '2026-11', ?)").run(a.ids[0], chave, resumo)
  fs.mkdirSync(a.abs(base), { recursive: true })
  fs.writeFileSync(a.abs(base, XLSX_NFE), 'antigo')
  await a.gerar()
  assert.ok(!a.existe(base, 'PDF'))
  assert.ok(!a.existe(base, XLSX_NFE))
  assert.ok(!a.existe(base, PDF_NFE))
  assert.ok(!a.existe(base, ZIP_NFE))
})

test('CT-e tem PDF/Outros', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota({ modelo: 'cte', direcao: 'outro' })
  const r = await a.gerar({ modelo: 'cte', direcao: 'outro' })
  assert.deepEqual(r.avisos, [])
  const base = a.tipo('CT-e', '11-Novembro', 'Outros')
  assert.ok(ehPdf(a.abs(base, 'PDF', `${n.chave}-cte.pdf`)))
  assert.ok(a.existe(base, 'Relatorio CT-e Outros Novembro 2026.xlsx'))
  assert.ok(a.existe(base, 'Cliente 1 CT-e Outros Novembro 2026.zip'))
})

test('XML ruim: PDF falha, o grupo termina e o ZIP leva avisos.txt', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  const ruim = a.nota({ xml: '<nada/>' })
  const r = await a.gerar()
  assert.equal(r.parou, false)
  assert.equal(r.avisos.length, 1)
  assert.match(r.avisos[0], new RegExp(ruim.chave))
  const base = a.tipo()
  assert.ok(!a.existe(base, 'PDF', `${ruim.chave}-nfe.pdf`))
  assert.ok(a.existe(base, PDF_NFE))
  assert.match(zipDe(a, base, ZIP_NFE).get('avisos.txt').toString(), new RegExp(ruim.chave))
  assert.ok(!a.existe(base, 'avisos.txt'))
})

test('XML ausente no disco: o grupo termina e o aviso cita a chave', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  const sumida = a.nota({ semArquivo: true })
  const r = await a.gerar()
  assert.equal(r.parou, false)
  assert.equal(r.avisos.length, 1)
  assert.match(r.avisos[0], new RegExp(sumida.chave))
  assert.ok(a.existe(a.tipo(), ZIP_NFE))
})

test('caminho_xml em outro mês: o PDF fica ao lado do XML e o ZIP leva o que está na pasta', async (t) => {
  const a = prepararDisco(t)
  // Competência de novembro, XML guardado na pasta de outubro.
  const n = a.nota({ pastaMes: '2026-10' })
  await a.gerar()
  assert.ok(a.existe(a.tipo('NF-e', '10-Outubro'), 'PDF', `${n.chave}-nfe.pdf`))
  assert.ok(!a.existe(a.tipo(), 'PDF'))
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
  assert.deepEqual([...zipDe(a, a.tipo(), ZIP_NFE).keys()].sort(), [PDF_NFE, XLSX_NFE].sort())
})

test('arquivo travado na troca (EBUSY): rejeita e o arquivo antigo continua inteiro', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  await a.gerar()
  const xlsx = a.abs(a.tipo(), XLSX_NFE)
  fs.writeFileSync(xlsx, 'antigo')
  a.db.prepare('UPDATE notas SET atualizado_em = ?').run(FUTURA)
  const real = fs.promises.rename
  const travado = criarGerador({
    db: a.db,
    config: a.config,
    renomear: async (de, para) => {
      if (para === xlsx) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      return real(de, para)
    },
  })
  await assert.rejects(travado.gerarGrupo(a.grupoDe(), {}), { code: 'EBUSY' })
  assert.equal(fs.readFileSync(xlsx, 'utf8'), 'antigo')
  assert.deepEqual(a.tmps(a.raiz), [])
})

test('gravar injetado que falha rejeita o grupo', async (t) => {
  const a = prepararDisco(t, {
    gravar: async () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    },
  })
  a.nota()
  await assert.rejects(a.gerar(), { code: 'EBUSY' })
})

test('deveParar: para entre arquivos e devolve parou, sem relatórios nem ZIP', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  a.nota()
  a.nota()
  let chamadas = 0
  const r = await a.gerar({}, { deveParar: () => ++chamadas > 2 })
  assert.equal(r.parou, true)
  const base = a.tipo()
  assert.ok(!a.existe(base, ZIP_NFE))
  assert.ok(!a.existe(base, XLSX_NFE))
  assert.equal(fs.readdirSync(a.abs(base, 'PDF')).length, 2)
})

test('pasta base indisponível rejeita com ENOENT e não a recria', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  const g = a.grupoDe()
  fs.rmSync(a.raiz, { recursive: true, force: true })
  await assert.rejects(a.gerador.gerarGrupo(g, {}), { code: 'ENOENT' })
  assert.ok(!fs.existsSync(a.raiz))
})

test('não deixa .tmp depois de terminar e apaga os restos, menos no XML', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  const base = a.tipo()
  fs.mkdirSync(a.abs(base, 'PDF'), { recursive: true })
  fs.writeFileSync(a.abs(base, 'PDF', 'x-nfe.pdf.99.tmp'), 'x')
  fs.writeFileSync(a.abs(base, `${XLSX_NFE}.99.tmp`), 'x')
  const emXml = path.join(base, 'XML', 'y-nfe.xml.99.tmp')
  fs.writeFileSync(a.abs(emXml), 'x')
  await a.gerar()
  assert.deepEqual(a.tmps(a.abs(base, 'PDF')), [])
  assert.deepEqual(fs.readdirSync(a.abs(base)).filter((f) => f.endsWith('.tmp')), [])
  assert.ok(a.existe(emXml), 'XML nunca é tocado')
  assert.ok(a.existe(n.relativo))
  assert.ok(![...zipDe(a, base, ZIP_NFE).keys()].some((f) => f.endsWith('.tmp')))
})

test('falha ao montar o relatório (E/S ao ler o XML): rejeita e relatórios e ZIP antigos ficam intactos', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota({ modelo: 'nfse' })
  await a.gerar({ modelo: 'nfse' })
  const base = a.tipo('NFS-e')
  const antes = ['Relatorio NFS-e Entradas Novembro 2026.xlsx', 'Relatorio NFS-e Entradas Novembro 2026.pdf', 'Cliente 1 NFS-e Entradas Novembro 2026.zip'].map((f) => fs.readFileSync(a.abs(base, f)))
  // XML virou uma pasta: leitura falha com EISDIR (não é arquivo ausente). O PDF já existe, então só o relatório lê o XML (NF-e não lê).
  fs.rmSync(a.abs(n.relativo))
  fs.mkdirSync(a.abs(n.relativo))
  await assert.rejects(a.gerar({ modelo: 'nfse' }), { code: 'EISDIR' })
  assert.deepEqual(['Relatorio NFS-e Entradas Novembro 2026.xlsx', 'Relatorio NFS-e Entradas Novembro 2026.pdf', 'Cliente 1 NFS-e Entradas Novembro 2026.zip'].map((f) => fs.readFileSync(a.abs(base, f))), antes)
  assert.deepEqual(a.tmps(a.raiz), [])
})

test('erro de E/S ao ler o XML para o PDF rejeita, em vez de virar aviso', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  fs.rmSync(a.abs(n.relativo))
  fs.mkdirSync(a.abs(n.relativo))
  await assert.rejects(a.gerar(), { code: 'EISDIR' })
})

test('XML malformado não trava o grupo: os dois relatórios saem', async (t) => {
  const a = prepararDisco(t)
  a.nota({ xml: '<nfeProc><NFe' })
  const r = await a.gerar()
  assert.equal(r.parou, false)
  assert.equal(r.avisos.length, 1)
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
  assert.ok(ehPdf(a.abs(a.tipo(), PDF_NFE)))
  assert.ok(a.existe(a.tipo(), ZIP_NFE))
})

test('falha ao gravar o ZIP: rejeita, o ZIP antigo fica inteiro e não sobra .tmp', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  await a.gerar()
  const zip = a.abs(a.tipo(), ZIP_NFE)
  const antes = fs.readFileSync(zip)
  a.db.prepare('UPDATE notas SET atualizado_em = ?').run(FUTURA)
  const real = fs.promises.rename
  const travado = criarGerador({
    db: a.db,
    config: a.config,
    renomear: async (de, para) => {
      if (para === zip) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(de, para)
    },
  })
  await assert.rejects(travado.gerarGrupo(a.grupoDe(), {}), { code: 'EBUSY' })
  assert.deepEqual(fs.readFileSync(zip), antes)
  assert.deepEqual(a.tmps(a.raiz), [])
})

test('deveParar verdadeiro antes dos relatórios: sem relatórios nem ZIP', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  let chamadas = 0
  const r = await a.gerar({}, { deveParar: () => ++chamadas > 1 })
  assert.equal(r.parou, true)
  assert.ok(ehPdf(a.abs(a.tipo(), 'PDF', fs.readdirSync(a.abs(a.tipo(), 'PDF'))[0])))
  assert.ok(!a.existe(a.tipo(), XLSX_NFE))
  assert.ok(!a.existe(a.tipo(), ZIP_NFE))
})

test('NFS-e: PDF em Entradas, relatórios e ZIP', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota({ modelo: 'nfse' })
  const r = await a.gerar({ modelo: 'nfse' })
  assert.deepEqual(r, { parou: false, avisos: [] })
  const base = a.tipo('NFS-e')
  assert.ok(ehPdf(a.abs(base, 'PDF', `${n.chave}-nfse.pdf`)))
  assert.ok(a.existe(base, 'Relatorio NFS-e Entradas Novembro 2026.xlsx'))
  assert.ok(ehPdf(a.abs(base, 'Relatorio NFS-e Entradas Novembro 2026.pdf')))
  assert.deepEqual([...zipDe(a, base, 'Cliente 1 NFS-e Entradas Novembro 2026.zip').keys()].sort(), [
    `PDF/${n.chave}-nfse.pdf`,
    'Relatorio NFS-e Entradas Novembro 2026.pdf',
    'Relatorio NFS-e Entradas Novembro 2026.xlsx',
    `XML/${n.chave}-nfse.xml`,
  ])
})

// ---------- passadas em segundo plano ----------

const { criarOrganizador } = require('../src/services/pastaOrganizada')

function prepararOrganizador(t, { temPasta = true, ...opcoes } = {}) {
  const a = prepararDisco(t)
  const logs = []
  const logger = { info() {}, error: (m, d) => logs.push(['error', m, d]), warn: (m, d) => logs.push(['warn', m, d]) }
  const org = criarOrganizador({ db: a.db, config: a.config, logger, pastas: { temPasta: () => temPasta }, ...opcoes })
  const prontos = () => a.db.prepare('SELECT COUNT(*) FROM pasta_grupos').pluck().get()
  const avisos = (re) => logs.filter((l) => l[0] === 'warn' && (!re || re.test(l[1])))
  return { ...a, org, logs, logger, prontos, avisos }
}

test('passada gera os pendentes e marca prontos', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.nota({ competencia: '2026-10' })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 2)
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
  assert.ok(a.existe(a.tipo('NF-e', '10-Outubro'), 'Relatorio NF-e Entradas Outubro 2026.xlsx'))
  assert.deepEqual(a.org.estado(), { situacao: 'parada', feitos: 2, total: 2, atual: null, falhas: 0, ultimoErro: null })
})

test('sem pasta escolhida não faz nada', async (t) => {
  const a = prepararOrganizador(t, { temPasta: false })
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 0)
  assert.ok(!a.existe(a.tipo(), XLSX_NFE))
})

test('pedido durante a passada faz mais uma ao terminar, e só uma', async (t) => {
  let passadas = 0
  const a = prepararOrganizador(t, {
    gravar: async (destino, conteudo) => {
      if (destino.endsWith('.xlsx')) passadas++
      await fs.promises.writeFile(destino, conteudo)
    },
  })
  a.nota()
  a.org.agendar()
  a.org.agendar()
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.equal(passadas, 1)
  a.db.prepare('UPDATE notas SET atualizado_em = ?').run(FUTURA)
  a.org.agendar()
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(passadas, 2)
})

test('arquivo travado: grupo segue pendente, os outros terminam, falhas e ultimoErro preenchidos', async (t) => {
  const a = prepararOrganizador(t, {
    renomear: async (de, para) => {
      if (para.endsWith('.zip') && para.includes('Cliente 1')) throw Object.assign(new Error('EBUSY: arquivo em uso'), { code: 'EBUSY' })
      return fs.promises.rename(de, para)
    },
  })
  a.nota()
  a.nota({ cliente: a.ids[1] })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
  const e = a.org.estado()
  assert.equal(e.falhas, 1)
  assert.match(e.ultimoErro, /EBUSY/)
  assert.equal(e.situacao, 'parada')
  assert.equal(a.avisos().length, 1)
  assert.equal(a.grupoDe().clienteId, a.ids[0])
})

test('pasta indisponível: para, situacao indisponivel, um aviso só no log', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.nota({ competencia: '2026-10' })
  fs.rmSync(a.raiz, { recursive: true, force: true })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.org.estado().situacao, 'indisponivel')
  assert.equal(a.org.estado().feitos, 0)
  assert.equal(a.avisos(/indispon/).length, 1)
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.avisos(/indispon/).length, 1)
  fs.mkdirSync(a.raiz, { recursive: true })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.org.estado().situacao, 'parada')
  assert.equal(a.prontos(), 2)
})

test('parar no meio: o grupo continua pendente e a próxima passada conclui', async (t) => {
  let org
  const a = prepararOrganizador(t, {
    gravar: async (destino, conteudo) => {
      if (destino.includes(`${path.sep}PDF${path.sep}`)) void org.parar()
      await fs.promises.writeFile(destino, conteudo)
    },
  })
  org = a.org
  a.nota()
  a.nota()
  org.agendar()
  await org.aguardar()
  assert.equal(a.prontos(), 0)
  assert.ok(!a.existe(a.tipo(), XLSX_NFE))
  org.agendar()
  await org.aguardar()
  assert.equal(a.prontos(), 0, 'depois de parar nenhuma passada começa')
  const outro = criarOrganizador({ db: a.db, config: a.config, logger: a.logger, pastas: { temPasta: () => true } })
  outro.agendar()
  await outro.aguardar()
  assert.equal(a.prontos(), 1)
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
})

test('nota nova durante a geração: grupo refeito na passada seguinte', async (t) => {
  let a
  let inserida = false
  a = prepararOrganizador(t, {
    gravar: async (destino, conteudo) => {
      if (!inserida && destino.endsWith('.xlsx')) {
        inserida = true
        a.nota()
      }
      await fs.promises.writeFile(destino, conteudo)
    },
  })
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(inserida, true)
  const xmls = [...zipDe(a, a.tipo(), ZIP_NFE).keys()].filter((n) => n.endsWith('.xml'))
  assert.equal(xmls.length, 2)
  assert.equal(a.grupoDe(), undefined)
})

test('abertura: relatório ou ZIP apagado volta a ficar pendente', async (t) => {
  const a = prepararOrganizador(t)
  const zipOut = 'Cliente 1 NF-e Entradas Outubro 2026.zip'
  a.nota()
  a.nota({ competencia: '2026-10' })
  a.nota({ status: 'resumo', competencia: '2026-09' })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 3, 'o grupo só de resumo também é gravado')
  fs.writeFileSync(a.abs(a.tipo(), XLSX_NFE), 'marca')
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.equal(fs.readFileSync(a.abs(a.tipo(), XLSX_NFE), 'utf8'), 'marca', 'nada faltando: nada refeito')
  fs.rmSync(a.abs(a.tipo(), XLSX_NFE))
  fs.rmSync(a.abs(a.tipo('NF-e', '10-Outubro'), zipOut))
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
  assert.ok(a.existe(a.tipo('NF-e', '10-Outubro'), zipOut))
})

test('pausarDurante espera a geração parar, executa e retoma com outra passada', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.org.agendar()
  let dentro
  await a.org.pausarDurante(() => {
    dentro = a.org.estado().situacao
    a.nota({ competencia: '2026-10' })
  })
  assert.equal(dentro, 'parada')
  await a.org.aguardar()
  assert.equal(a.prontos(), 2)
})

test('removerCliente apaga as linhas do cliente e mantém os arquivos', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.nota({ cliente: a.ids[1] })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 2)
  a.org.removerCliente(a.ids[0])
  assert.equal(a.prontos(), 1)
  assert.ok(a.existe(a.tipo(), XLSX_NFE))
})

test('erro ao agendar nunca sobe', (t) => {
  const a = prepararOrganizador(t)
  const org = criarOrganizador({ db: a.db, config: a.config, logger: a.logger, pastas: { temPasta: () => { throw new Error('banco fechado') } } })
  assert.doesNotThrow(() => org.agendar())
  assert.equal(a.logs.at(-1)[0], 'error')
})

test('conferência: grupo só com notas fora da carteira não volta a ficar pendente', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  a.db.prepare("UPDATE notas SET caminho_xml = 'fora-da-carteira/x.xml'").run()
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
})

test('aviso de pasta indisponível: queda, volta sem pendentes e nova queda avisam de novo', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  fs.rmSync(a.raiz, { recursive: true, force: true })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.avisos(/indispon/).length, 1)
  fs.mkdirSync(a.raiz, { recursive: true })
  const grupos = criarGrupos({ db: a.db })
  grupos.pendentes().forEach((g) => grupos.marcarPronto(g))
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.org.estado().situacao, 'parada')
  fs.rmSync(a.raiz, { recursive: true, force: true })
  a.db.prepare('UPDATE notas SET atualizado_em = ?').run(FUTURA)
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.avisos(/indispon/).length, 2)
})

test('pausarDurante executa uma fn por vez', async (t) => {
  const a = prepararOrganizador(t)
  let ativas = 0
  let maximo = 0
  const fn = async () => {
    maximo = Math.max(maximo, ++ativas)
    await new Promise((r) => setTimeout(r, 10))
    ativas--
  }
  await Promise.all([a.org.pausarDurante(fn), a.org.pausarDurante(fn), a.org.pausarDurante(fn)])
  assert.equal(maximo, 1)
})

test('erro em fn não deixa a geração pausada', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  await assert.rejects(a.org.pausarDurante(() => { throw new Error('falhou') }), /falhou/)
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
})

test('agendar durante fn roda uma passada só no fim', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  await a.org.pausarDurante(async () => {
    a.org.agendar()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(a.prontos(), 0)
    assert.equal(a.org.estado().situacao, 'parada')
  })
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
})

test('grupo que sempre falha não gera laço de passadas', async (t) => {
  let tentativas = 0
  const a = prepararOrganizador(t, {
    renomear: async () => {
      tentativas++
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    },
  })
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  const feitas = tentativas
  assert.ok(feitas >= 1 && feitas <= 3, String(feitas))
  assert.equal(a.prontos(), 0)
  assert.equal(a.org.estado().falhas, 1)
})

test('agendar depois de parar não faz nada', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  await a.org.parar()
  a.org.agendar()
  await a.org.pausarDurante(() => {})
  await a.org.aguardar()
  assert.equal(a.prontos(), 0)
})

// ---------- achados da revisão geral ----------

const { criarServicoClientes } = require('../src/services/clientes')
const { silencioso } = require('./apoio/ambiente')
const { VERSAO_XML } = require('../src/services/migracaoPastas')

// Gerador e organizador com o serviço de clientes de verdade.
function comClientes(t, { temPasta = true, ...opcoes } = {}) {
  let servico
  const reconciliarPasta = (c) => servico.reconciliarPasta(c)
  const a = prepararDisco(t, { reconciliarPasta })
  a.config.pastaCerts = a.raiz
  servico = criarServicoClientes({ db: a.db, config: a.config, logger: silencioso })
  const logs = []
  const logger = { info: (m, d) => logs.push(['info', m, d]), error: (m, d) => logs.push(['error', m, d]), warn: (m, d) => logs.push(['warn', m, d]) }
  const org = criarOrganizador({ db: a.db, config: a.config, logger, pastas: { temPasta: () => temPasta }, reconciliarPasta, ...opcoes })
  const prontos = () => a.db.prepare('SELECT COUNT(*) FROM pasta_grupos').pluck().get()
  camada(a, VERSAO_XML)
  return { ...a, servico, org, logs, prontos }
}
const apelido = (a, id, nome) => a.db.prepare('UPDATE clientes SET apelido = ? WHERE id = ?').run(nome, id)
const caminhoDe = (a, chave) => a.db.prepare('SELECT caminho_xml FROM notas WHERE chave = ?').get(chave).caminho_xml
const noZip = (a, base, zip) => [...zipDe(a, base, zip).keys()].sort()

test('I1: o rename falha: rejeita com erro claro, sem ZIP vazio; depois de soltar, move e gera com XML e PDF', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  const nova = path.join('Novo Nome', '2026', '11-Novembro', 'Entradas', 'NF-e')
  const renomear = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
  })
  const g = a.grupoDe()
  await assert.rejects(a.gerador.gerarGrupo(g, {}), /"Cliente 1" e deveria ser "Novo Nome"/)
  assert.ok(renomear.mock.callCount() > 0, 'tentou mover de novo')
  assert.ok(!a.existe(nova, 'Novo Nome NF-e Entradas Novembro 2026.zip'))
  assert.equal(caminhoDe(a, n.chave), n.relativo, 'o banco volta')

  renomear.mock.restore()
  await a.gerador.gerarGrupo(g, {})
  assert.ok(!a.existe('Cliente 1'))
  assert.deepEqual(noZip(a, nova, 'Novo Nome NF-e Entradas Novembro 2026.zip'), [`PDF/${n.chave}-nfe.pdf`, PDF_NFE, XLSX_NFE, `XML/${n.chave}-nfe.xml`].sort())
  assert.ok(caminhoDe(a, n.chave).startsWith('Novo Nome'))
})

test('I1: o erro aparece em ultimoErro e o grupo fica pendente', async (t) => {
  const a = comClientes(t)
  a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  const renomear = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
  })
  a.org.agendar()
  await a.org.aguardar()
  renomear.mock.restore()
  assert.equal(a.prontos(), 0)
  assert.equal(a.org.estado().falhas, 1)
  assert.match(a.org.estado().ultimoErro, /deveria ser "Novo Nome"/)
})

test('I1: homônimo surgindo: a pasta ganha o CNPJ e o ZIP sai com os arquivos', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[1], 'Cliente 1')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  const empresa = `Cliente 1 ${CNPJS[0]}`
  const nova = path.join(empresa, '2026', '11-Novembro', 'Entradas', 'NF-e')
  assert.ok(!a.existe('Cliente 1'))
  assert.ok(noZip(a, nova, `${empresa} NF-e Entradas Novembro 2026.zip`).includes(`XML/${n.chave}-nfe.xml`))
})

test('I1: homônimo sumindo: a pasta volta ao nome sem CNPJ', async (t) => {
  const a = comClientes(t)
  apelido(a, a.ids[1], 'Cliente 1')
  const n = a.nota()
  assert.ok(n.relativo.startsWith('Cliente 1'))
  const empresa = `Cliente 1 ${CNPJS[0]}`
  const novoCaminho = n.relativo.replace('Cliente 1', empresa)
  fs.renameSync(a.abs('Cliente 1'), a.abs(empresa))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(novoCaminho, n.chave)
  apelido(a, a.ids[1], 'Outro Nome')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.ok(!a.existe(empresa))
  assert.ok(noZip(a, a.tipo(), ZIP_NFE).includes(`XML/${n.chave}-nfe.xml`))
})

test('I1: escritório renomeado que também é cliente: a pasta acompanha', async (t) => {
  const a = comClientes(t)
  a.db.prepare("UPDATE clientes SET papel = 'escritorio', tambem_cliente = 1, razao_social = 'Escritorio Velho' WHERE id = ?").run(a.ids[0])
  const n = a.nota()
  assert.ok(n.relativo.startsWith('Escritorio Velho'))
  a.servico.editarEscritorio({ razao: 'Escritorio Novo', uf: 'CE' })
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.ok(!a.existe('Escritorio Velho'))
  const base = path.join('Escritorio Novo', '2026', '11-Novembro', 'Entradas', 'NF-e')
  assert.ok(noZip(a, base, 'Escritorio Novo NF-e Entradas Novembro 2026.zip').includes(`XML/${n.chave}-nfe.xml`))
})

test('I1: destino já existente: junta sem mexer no que já estava lá', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  fs.mkdirSync(a.abs('Novo Nome'))
  fs.writeFileSync(a.abs('Novo Nome', 'de-alguem.txt'), 'x')
  apelido(a, a.ids[0], 'Novo Nome')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, n.chave), n.relativo.replace('Cliente 1', 'Novo Nome'))
  assert.ok(a.existe(n.relativo.replace('Cliente 1', 'Novo Nome')), 'a nota está no disco no lugar novo')
  assert.ok(!a.existe(n.relativo))
  assert.equal(fs.readFileSync(a.abs('Novo Nome', 'de-alguem.txt'), 'utf8'), 'x')
})

test('I1: sem reconciliar injetado, a divergência também rejeita', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  await assert.rejects(a.gerar(), /deveria ser "Novo Nome"/)
})

test('I1: pasta com notas de outro cliente nunca é renomeada', async (t) => {
  const a = comClientes(t)
  const minha = a.nota()
  const outra = a.nota({ cliente: a.ids[1] })
  // A nota do segundo cliente aponta para a pasta do primeiro.
  fs.mkdirSync(path.dirname(a.abs(outra.relativo.replace('Cliente 2', 'Cliente 1'))), { recursive: true })
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(outra.relativo.replace('Cliente 2', 'Cliente 1'), outra.chave)
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe({ clienteId: a.ids[1] }), {}), /deveria ser "Cliente 2"/)
  assert.ok(a.existe(minha.relativo), 'a pasta do primeiro cliente fica')
  assert.equal(caminhoDe(a, minha.chave), minha.relativo)
})

test('I1: evento guardado na pasta de outra empresa não é divergência da nota', async (t) => {
  const a = comClientes(t)
  a.nota({ cliente: a.ids[1] })
  const n = a.nota()
  const rel = path.join('Cliente 2', '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e', `${n.chave}-evento-110111-1.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), '<evento/>')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(n.chave, rel)
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.ok(a.existe('Cliente 2'), 'a pasta da outra empresa fica')
  assert.ok(a.existe(a.tipo(), ZIP_NFE))
})

// Maiúsculas iguais só no disco do Windows, onde o app roda.
test('I2: diferença de maiúsculas ou de barras no banco não apaga os PDFs', { skip: process.platform !== 'win32' && 'disco sem diferença de maiúsculas só no Windows' }, async (t) => {
  for (const formato of [(c) => c.replace('Cliente 1', 'CLIENTE 1'), (c) => c.replace('Cliente 1', 'CLIENTE 1').replace(/\\/g, '/')]) {
    const a = prepararDisco(t)
    const n = a.nota()
    a.db.prepare('UPDATE notas SET caminho_xml = ?').run(formato(n.relativo))
    await a.gerar()
    const pdf = a.abs(a.tipo(), 'PDF', `${n.chave}-nfe.pdf`)
    assert.ok(fs.existsSync(pdf), 'não é órfão')
    fs.writeFileSync(pdf, 'marca')
    await a.gerar()
    assert.equal(fs.readFileSync(pdf, 'utf8'), 'marca', 'nem é regerado')
    assert.ok(noZip(a, a.tipo(), ZIP_NFE).includes(`PDF/${n.chave}-nfe.pdf`))
  }
})

test('I3: excluir "Cliente 1" e cadastrar outro com o mesmo nome: o ZIP novo não leva nada da excluída e os arquivos dela ficam', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  const base = a.tipo()
  const pdfVelho = path.join(base, 'PDF', `${velha.chave}-nfe.pdf`)
  const xmlVelho = path.join(base, 'XML', `${velha.chave}-nfe.xml`)
  const resumoVelho = path.join(AVULSOS, `${velha.chave}-resumo.xml`)
  fs.mkdirSync(path.dirname(a.abs(resumoVelho)), { recursive: true })
  fs.writeFileSync(a.abs(resumoVelho), '<res/>')
  assert.ok(a.existe(pdfVelho))
  a.servico.excluir(CNPJS[0])
  const { cliente } = a.servico.cadastrar({ cnpj: '27865757000102', razao: 'Cliente 1 Ltda', uf: 'CE', apelido: 'Cliente 1' })
  const nova = a.nota({ cliente: cliente.id })
  await a.gerador.gerarGrupo(a.grupoDe({ clienteId: cliente.id }), {})
  assert.deepEqual(noZip(a, base, ZIP_NFE), [`PDF/${nova.chave}-nfe.pdf`, PDF_NFE, XLSX_NFE, `XML/${nova.chave}-nfe.xml`].sort())
  for (const f of [xmlVelho, pdfVelho, resumoVelho]) assert.ok(a.existe(f), f)
})

test('I3: arquivo desconhecido fica fora do ZIP e vai para o log', async (t) => {
  const logs = []
  const a = prepararDisco(t, { logger: { info() {}, error() {}, warn: (m, d) => logs.push([m, d]) } })
  a.nota()
  fs.mkdirSync(a.abs(a.tipo(), 'XML'), { recursive: true })
  fs.writeFileSync(a.abs(a.tipo(), 'XML', 'de-alguem.xml'), 'x')
  await a.gerar()
  assert.ok(!noZip(a, a.tipo(), ZIP_NFE).some((f) => f.includes('de-alguem')))
  assert.ok(a.existe(a.tipo(), 'XML', 'de-alguem.xml'))
  const log = logs.find(([m]) => /fora do ZIP/.test(m))
  assert.ok(log[1].arquivos.some((f) => f.includes('de-alguem')))
})

test('ZIP leva cancelamento e carta de correção da nota; os outros eventos e os resumos ficam só na pasta', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  const base = a.tipo()
  const evento = (tipo) => {
    const rel = path.join(AVULSOS, `${n.chave}-evento-${tipo}-1.xml`)
    fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
    fs.writeFileSync(a.abs(rel), '<evento/>')
    a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, ?, '1', ?)").run(n.chave, tipo, rel)
  }
  for (const tipo of ['110111', '110110', '210210', '610600']) evento(tipo)
  const resumo = path.join(AVULSOS, `${n.chave}-resumo.xml`)
  fs.writeFileSync(a.abs(resumo), '<res/>')
  await a.gerar()
  assert.deepEqual(noZip(a, base, ZIP_NFE), [
    `Eventos/${n.chave}-evento-110110-1.xml`,
    `Eventos/${n.chave}-evento-110111-1.xml`,
    `PDF/${n.chave}-nfe.pdf`,
    PDF_NFE,
    XLSX_NFE,
    `XML/${n.chave}-nfe.xml`,
  ].sort())
  assert.ok(a.existe(resumo))
})

test('ZIP de entradas não leva o cancelamento da nota de saída', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  const saida = a.nota({ direcao: 'saida' })
  const rel = path.join(AVULSOS, `${saida.chave}-evento-110111-1.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), '<evento/>')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(saida.chave, rel)
  await a.gerar()
  assert.ok(!noZip(a, a.tipo(), ZIP_NFE).some((f) => f.startsWith('Eventos/')))
  await a.gerar({ direcao: 'saida' })
  assert.ok(noZip(a, a.tipo('NF-e', '11-Novembro', 'Saidas'), 'Cliente 1 NF-e Saidas Novembro 2026.zip').includes(`Eventos/${saida.chave}-evento-110111-1.xml`))
})

test('I3: PDF com XML ao lado nunca é órfão; sem XML e sem nota, é apagado', async (t) => {
  const a = prepararDisco(t)
  a.nota()
  await a.gerar()
  const base = a.tipo()
  fs.writeFileSync(a.abs(base, 'XML', '999-nfe.xml'), '<x/>')
  fs.writeFileSync(a.abs(base, 'PDF', '999-nfe.pdf'), 'pdf')
  fs.writeFileSync(a.abs(base, 'PDF', '888-nfe.pdf'), 'pdf')
  await a.gerar()
  assert.ok(a.existe(base, 'PDF', '999-nfe.pdf'))
  assert.ok(!a.existe(base, 'PDF', '888-nfe.pdf'))
  assert.ok(!noZip(a, base, ZIP_NFE).some((f) => f.includes('999')))
})

function notaV5(a, { competencia = '2026-11', mes = 'Novembro', chave }) {
  const rel = path.join('Cliente 1', '2026', mes, 'NF-e', 'Entradas', `${chave}-nfe.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), nfeProc({ det: item(1) }))
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml, atualizado_em, data_emissao) VALUES (?, ?, 'nfe', 'entrada', 'completa', ?, ?, ?, ?)").run(a.ids[0], chave, competencia, rel, ANTIGA, `${competencia}-10`)
  return rel
}
const camada = (a, v) => {
  for (const [c, valor] of [['pastas_versao', '2'], ['pastas_layout', v]]) a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(c, valor)
}
const layout = (a) => a.db.prepare("SELECT valor FROM sistema WHERE chave = 'pastas_layout'").pluck().get()

test('I4: nota completa fora do formato novo rejeita o grupo, sem ZIP nem assinatura', async (t) => {
  const a = prepararDisco(t)
  notaV5(a, { chave: '1'.repeat(44) })
  await assert.rejects(a.gerar(), /formato antigo/)
  assert.ok(!a.existe(a.tipo(), ZIP_NFE))
})

test('I4: nota completa com XML em Eventos e Resumos (ainda sem PDF) não rejeita', async (t) => {
  const a = prepararDisco(t)
  const n = a.nota()
  const rel = path.join(AVULSOS, `${n.chave}-resumo.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), '<res/>')
  a.db.prepare('UPDATE notas SET caminho_xml = ?').run(rel)
  assert.equal((await a.gerar()).parou, false)
})

test('I4: pasta volta depois de abrir: a passada migra e o grupo gera os PDFs', async (t) => {
  const a = comClientes(t)
  camada(a, '5')
  const chave = '1'.repeat(44)
  notaV5(a, { chave })
  const fora = `${a.raiz}-fora`
  fs.renameSync(a.raiz, fora)
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }))

  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.org.estado().situacao, 'indisponivel')
  assert.equal(a.prontos(), 0)
  assert.equal(layout(a), '5')
  assert.ok(a.logs.some(([n, m]) => n === 'warn' && /indisponível/.test(m)))

  fs.renameSync(fora, a.raiz)
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(layout(a), VERSAO_XML)
  assert.equal(a.prontos(), 1)
  assert.ok(a.existe(a.tipo(), 'XML', `${chave}-nfe.xml`))
  assert.ok(ehPdf(a.abs(a.tipo(), 'PDF', `${chave}-nfe.pdf`)))
  assert.ok(a.logs.some(([n, m, d]) => n === 'info' && /Migração retomada/.test(m) && d.movidos >= 1))
})

test('I4: XML travado só afeta o grupo dele; depois de soltar, gera tudo', async (t) => {
  let travado = true
  const presa = '2'.repeat(44)
  const a = comClientes(t, {
    fsOpsMigracao: {
      renameSync: (de, para) => {
        if (travado && de.includes(presa)) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
        return fs.renameSync(de, para)
      },
    },
  })
  camada(a, '5')
  notaV5(a, { chave: '1'.repeat(44), competencia: '2026-10', mes: 'Outubro' })
  notaV5(a, { chave: presa })
  notaV5(a, { chave: '3'.repeat(44) })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(layout(a), '5', 'segue pendente')
  assert.equal(a.prontos(), 1, 'outubro terminou')
  assert.ok(a.existe(a.tipo('NF-e', '10-Outubro'), 'Relatorio NF-e Entradas Outubro 2026.xlsx'))
  assert.equal(a.org.estado().falhas, 1)
  assert.match(a.org.estado().ultimoErro, /formato antigo/)
  assert.ok(!a.existe(a.tipo(), ZIP_NFE))

  travado = false
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(layout(a), VERSAO_XML)
  assert.equal(a.prontos(), 2)
  assert.ok(ehPdf(a.abs(a.tipo(), 'PDF', `${presa}-nfe.pdf`)))
})

test('M1: a raiz some no meio da conferência: para sem apagar a linha do grupo', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
  const raiz = a.raiz
  const fora = `${raiz}-fora`
  t.after(() => fs.rmSync(fora, { recursive: true, force: true }))
  let leituras = 0
  Object.defineProperty(a.config, 'pastaXmls', {
    configurable: true,
    get() {
      if (++leituras === 2) fs.renameSync(raiz, fora)
      return raiz
    },
  })
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.equal(a.prontos(), 1)
})

test('M4: a raiz some logo depois de gerar: não marca pronto e fica indisponível', async (t) => {
  const fora = []
  const a = prepararOrganizador(t, {
    renomear: async (de, para) => {
      await fs.promises.rename(de, para)
      if (para.endsWith('.zip')) {
        fora.push(`${a.raiz}-fora`)
        fs.renameSync(a.raiz, fora[0])
      }
    },
  })
  t.after(() => fora.forEach((f) => fs.rmSync(f, { recursive: true, force: true })))
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 0)
  assert.equal(a.org.estado().situacao, 'indisponivel')
})

test('I7: situacao conferindo com andamento durante a conferência', async (t) => {
  const a = prepararOrganizador(t)
  a.nota()
  a.org.agendar()
  await a.org.aguardar()
  const original = fs.promises.readdir
  const vistos = []
  t.mock.method(fs.promises, 'readdir', async (...args) => {
    vistos.push(a.org.estado())
    return original(...args)
  })
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  t.mock.restoreAll()
  assert.equal(vistos[0].situacao, 'conferindo')
  assert.equal(vistos[0].total, 1)
  assert.equal(a.org.estado().situacao, 'parada')
})

test('falta da Tarefa 4: mesma chave em dois clientes com evento conta nos dois grupos', (t) => {
  const a = preparar(t)
  const chave = '7'.repeat(44)
  const ins = a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, status, competencia, caminho_xml, atualizado_em) VALUES (?, ?, 'nfe', 'completa', '2026-10', 'x.xml', '2026-10-01 10:00:00')")
  ins.run(a.ids[0], chave)
  ins.run(a.ids[1], chave)
  a.evento(chave)
  const lista = a.grupos.pendentes()
  assert.deepEqual(lista.map((g) => [g.clienteId, g.eventos]).sort(), [[a.ids[0], 1], [a.ids[1], 1]].sort())
  a.grupos.marcarPronto(lista[0])
  a.evento(chave, 2)
  assert.deepEqual(a.grupos.pendentes().map((g) => [g.clienteId, g.eventos, g.eventosAntes]).sort(), [[lista[0].clienteId, 2, 1], [lista[1].clienteId, 2, null]].sort())
})

test('falta da Tarefa 6: conferir usa o filtro DO_GRUPO: grupo só com notas fora da carteira não apaga a linha, mesmo sem relatório', async (t) => {
  const a = prepararOrganizador(t)
  const n = a.nota()
  const comum = a.nota({ competencia: '2026-10' })
  a.org.agendar()
  await a.org.aguardar()
  assert.equal(a.prontos(), 2)
  const assinaturaAntes = a.db.prepare("SELECT gerado_em FROM pasta_grupos WHERE competencia = '2026-11'").pluck().get()
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(path.join('Cliente 1', 'fora-da-carteira', 'x.xml'), n.chave)
  fs.rmSync(a.abs(a.tipo(), XLSX_NFE))
  fs.rmSync(a.abs(a.tipo('NF-e', '10-Outubro'), 'Relatorio NF-e Entradas Outubro 2026.xlsx'))
  fs.rmSync(a.abs(a.tipo('NF-e', '10-Outubro'), 'Cliente 1 NF-e Entradas Outubro 2026.zip'))
  a.org.agendar({ conferirArquivos: true })
  await a.org.aguardar()
  assert.ok(noZip(a, a.tipo('NF-e', '10-Outubro'), 'Cliente 1 NF-e Entradas Outubro 2026.zip').includes(`XML/${comum.chave}-nfe.xml`), 'o ZIP refeito traz a nota do grupo comum')
  assert.equal(a.db.prepare("SELECT gerado_em FROM pasta_grupos WHERE competencia = '2026-11'").pluck().get(), assinaturaAntes, 'a linha do grupo fora da carteira fica')
  assert.ok(!a.existe(a.tipo(), XLSX_NFE), 'o grupo não é refeito')
  assert.ok(a.existe(a.tipo('NF-e', '10-Outubro'), 'Relatorio NF-e Entradas Outubro 2026.xlsx'), 'o grupo comum é refeito')
})

test('marcarPronto exige eventos', (t) => {
  const a = preparar(t)
  a.nota()
  const [g] = a.grupos.pendentes()
  const { eventos, ...semEventos } = g
  assert.equal(eventos, 0)
  assert.throws(() => a.grupos.marcarPronto(semEventos), /eventos/)
})

// ---------- I-2: a pasta da empresa nos dois lados ou sumida ----------

const NF_E_NOVA = path.join('Novo Nome', '2026', '11-Novembro', 'Entradas', 'NF-e')
const relNovo = (rel) => rel.replace('Cliente 1', 'Novo Nome')
/** Mesmo arquivo do lado novo, com o conteúdo dado. */
const noLadoNovo = (a, rel, conteudo) => {
  fs.mkdirSync(path.dirname(a.abs(relNovo(rel))), { recursive: true })
  fs.writeFileSync(a.abs(relNovo(rel)), conteudo)
}
const pendente = (a, id = a.ids[0]) => a.db.prepare('SELECT valor FROM sistema WHERE chave = ?').pluck().get(`pasta_pendente:${id}`)
const emBusy = () => Object.assign(new Error('aberto'), { code: 'EBUSY' })
/** O nome novo sai, mas a origem não pode ser apagada: arquivo aberto com leitura compartilhada. */
function travarAoApagar(t, trecho) {
  const original = fs.unlinkSync
  const m = t.mock.method(fs, 'unlinkSync', (p, ...resto) => {
    if (String(p).includes(trecho)) throw emBusy()
    return original(p, ...resto)
  })
  return { soltar: () => m.mock.restore() }
}
/** Nem o nome novo sai: arquivo aberto sem compartilhar nada. */
function travarDeVez(t, trecho) {
  const mocks = ['linkSync', 'copyFileSync', 'unlinkSync'].map((nome) => {
    const original = fs[nome]
    return t.mock.method(fs, nome, (de, ...resto) => {
      if (String(de).includes(trecho)) throw emBusy()
      return original(de, ...resto)
    })
  })
  return { soltar: () => mocks.forEach((m) => m.mock.restore()) }
}
const mensagemDaPasta = /A pasta da empresa está como "Cliente 1" e deveria ser "Novo Nome"\. Feche os arquivos abertos dessa pasta; o Smart Fiscal tenta de novo na próxima captura\./

test('I-2: rename falhou e a captura criou a pasta nova: junta, aponta notas e eventos e o ZIP sai com tudo', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  const nova = a.nota()
  assert.ok(nova.relativo.startsWith('Novo Nome'))
  const relEvento = path.join('Cliente 1', '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e', `${velha.chave}-evento-110111-1.xml`)
  fs.mkdirSync(path.dirname(a.abs(relEvento)), { recursive: true })
  fs.writeFileSync(a.abs(relEvento), '<evento/>')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(velha.chave, relEvento)
  const conteudo = fs.readFileSync(a.abs(velha.relativo))

  await a.gerador.gerarGrupo(a.grupoDe(), {})

  assert.ok(!a.existe('Cliente 1'), 'a pasta antiga vazia sai')
  assert.equal(caminhoDe(a, velha.chave), relNovo(velha.relativo))
  assert.deepEqual(fs.readFileSync(a.abs(relNovo(velha.relativo))), conteudo)
  assert.equal(a.db.prepare('SELECT caminho_xml FROM eventos').pluck().get(), relNovo(relEvento))
  const nomes = noZip(a, NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip')
  for (const n of [velha, nova]) assert.ok(nomes.includes(`XML/${n.chave}-nfe.xml`))
  assert.ok(nomes.includes(`Eventos/${velha.chave}-evento-110111-1.xml`))
})

test('I-2: caminho no banco com barra invertida também é juntado, mantendo a barra', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  const comInvertida = velha.relativo.replaceAll('/', '\\')
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(comInvertida, velha.chave)
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, velha.chave), comInvertida.replace('Cliente 1', 'Novo Nome'))
  assert.ok(a.existe(relNovo(velha.relativo)))
})

test('I-2: mesmo caminho e mesmo conteúdo nos dois lados: aponta para o destino e apaga a origem', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, n.relativo, fs.readFileSync(a.abs(n.relativo)))
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  assert.ok(a.existe(relNovo(n.relativo)))
  assert.ok(!a.existe(n.relativo))
})

test('I-2: o mesmo arquivo pelas duas pastas (junction): nada é apagado, o grupo sai e o ZIP leva a nota', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.symlinkSync(a.abs('Cliente 1'), a.abs('Novo Nome'), 'junction')
  t.after(() => fs.rmSync(a.abs('Novo Nome'), { recursive: true, force: true }))
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.ok(a.existe(n.relativo), 'fica: apagar levaria o único exemplar')
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  assert.equal(pendente(a), undefined)
  assert.ok(noZip(a, NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip').includes(`XML/${n.chave}-nfe.xml`))
})

test('I-2: dois nomes do mesmo arquivo em pastas de verdade diferentes: os dois ficam e o grupo sai', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.mkdirSync(path.dirname(a.abs(relNovo(n.relativo))), { recursive: true })
  const conteudo = fs.readFileSync(a.abs(n.relativo))
  fs.linkSync(a.abs(n.relativo), a.abs(relNovo(n.relativo)))
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.deepEqual(fs.readFileSync(a.abs(relNovo(n.relativo))), conteudo)
  assert.equal(pendente(a), undefined)
})

test('I-2: sem ino não dá para garantir que são dois arquivos: não apaga', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, n.relativo, fs.readFileSync(a.abs(n.relativo)))
  const original = fs.statSync
  t.mock.method(fs, 'statSync', (caminho, opcoes) => {
    const s = original(caminho, opcoes)
    return opcoes?.bigint ? { ...s, ino: 0n } : s
  })
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.ok(e.message.includes(path.basename(n.relativo)), e.message)
    assert.match(e.message, /identidade/)
    assert.doesNotMatch(e.message, /Feche/)
    return true
  })
  assert.ok(a.existe(n.relativo))
  assert.ok(a.existe(relNovo(n.relativo)))
  assert.equal(pendente(a), 'Cliente 1')
})

test('I-2: conteúdo diferente mantém os dois e rejeita com o nome do arquivo; os outros arquivos são levados', async (t) => {
  const a = comClientes(t)
  const presa = a.nota()
  const solta = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, presa.relativo, '<outro/>')
  const antes = fs.readFileSync(a.abs(presa.relativo))
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.ok(e.message.includes(path.basename(presa.relativo)), e.message)
    assert.match(e.message, /conteúdo diferente/)
    return true
  })
  assert.deepEqual(fs.readFileSync(a.abs(presa.relativo)), antes, 'o da origem fica')
  assert.equal(fs.readFileSync(a.abs(relNovo(presa.relativo)), 'utf8'), '<outro/>', 'o do destino fica')
  assert.equal(caminhoDe(a, presa.chave), presa.relativo)
  assert.equal(caminhoDe(a, solta.chave), relNovo(solta.relativo))
  assert.ok(!a.existe(solta.relativo))
  assert.ok(!a.existe(NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip'))
})

test('I-2: arquivo preso não sai, o banco dele não muda e a mensagem não manda mover à mão; depois de soltar, junta', async (t) => {
  const a = comClientes(t)
  const presa = a.nota()
  const solta = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const trava = travarDeVez(t, presa.chave)
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), mensagemDaPasta)
  assert.equal(caminhoDe(a, presa.chave), presa.relativo)
  assert.ok(a.existe(presa.relativo))
  assert.equal(caminhoDe(a, solta.chave), relNovo(solta.relativo))
  trava.soltar()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, presa.chave), relNovo(presa.relativo))
  assert.ok(!a.existe('Cliente 1'))
})

test('I-2: origem removida à mão com os arquivos já no destino: reaponta e o grupo sai', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.mkdirSync(a.abs('Novo Nome'))
  fs.renameSync(a.abs('Cliente 1', '2026'), a.abs('Novo Nome', '2026'))
  fs.rmdirSync(a.abs('Cliente 1'))
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  assert.ok(noZip(a, NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip').includes(`XML/${n.chave}-nfe.xml`))
})

test('I-2: origem removida: só reaponta quem tem arquivo; quem não tem em nenhum lado fica e rejeita com o nome', async (t) => {
  const a = comClientes(t)
  const achada = a.nota()
  const perdida = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, achada.relativo, fs.readFileSync(a.abs(achada.relativo)))
  fs.rmSync(a.abs('Cliente 1'), { recursive: true })
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.ok(e.message.includes(path.basename(perdida.relativo)), e.message)
    return true
  })
  assert.equal(caminhoDe(a, achada.chave), relNovo(achada.relativo))
  assert.equal(caminhoDe(a, perdida.chave), perdida.relativo, 'não altera')
})

test('I-2: pasta com nota de outro cliente não é tocada, mesmo com os dois lados existindo', async (t) => {
  const a = comClientes(t)
  const minha = a.nota()
  const outra = a.nota({ cliente: a.ids[1] })
  const naPrimeira = outra.relativo.replace('Cliente 2', 'Cliente 1')
  fs.mkdirSync(path.dirname(a.abs(naPrimeira)), { recursive: true })
  fs.renameSync(a.abs(outra.relativo), a.abs(naPrimeira))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(naPrimeira, outra.chave)
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, minha.relativo.replace('11-Novembro', '10-Outubro'), '<x/>')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.match(e.message, /"Cliente 1" e deveria ser "Novo Nome".*notas de outra empresa/s)
    assert.doesNotMatch(e.message, /Feche/)
    return true
  })
  assert.equal(caminhoDe(a, minha.chave), minha.relativo)
  assert.ok(a.existe(minha.relativo))
  assert.ok(a.existe(naPrimeira))
})

test('I-2: pasta de destino com nota de outro cliente também não é tocada', async (t) => {
  const a = comClientes(t)
  const minha = a.nota()
  const outra = a.nota({ cliente: a.ids[1] })
  const naNova = outra.relativo.replace('Cliente 2', 'Novo Nome')
  fs.mkdirSync(path.dirname(a.abs(naNova)), { recursive: true })
  fs.renameSync(a.abs(outra.relativo), a.abs(naNova))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(naNova, outra.chave)
  apelido(a, a.ids[0], 'Novo Nome')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), /deveria ser "Novo Nome"/)
  assert.ok(a.existe(minha.relativo))
  assert.equal(caminhoDe(a, minha.chave), minha.relativo)
})

test('I-2: formato antigo não é reconciliado: a raiz NF-e não é renomeada', async (t) => {
  const a = comClientes(t)
  camada(a, '5')
  const rel = path.join('NF-e', 'Cliente 1', '2026-11', '1-nfe.xml')
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), '<x/>')
  a.db.prepare("INSERT INTO notas (cliente_id, chave, modelo, tipo, status, competencia, caminho_xml) VALUES (?, '1', 'nfe', 'entrada', 'completa', '2026-11', ?)").run(a.ids[0], rel)
  assert.deepEqual(a.servico.reconciliarPasta(a.db.prepare('SELECT * FROM clientes WHERE id = ?').get(a.ids[0])), [])
  assert.ok(a.existe(rel))
  assert.ok(!a.existe('Cliente 1'))
  assert.equal(caminhoDe(a, '1'), rel)
})

// ---------- I-3: migração retomada ----------

const UMA_HORA = 3600e3

function comMigracaoPresa(t, opcoes = {}) {
  let agora = Date.parse('2026-11-05T12:00:00Z')
  let presa = true
  let tentativas = 0
  const chave = '2'.repeat(44)
  const a = comClientes(t, {
    agora: () => agora,
    fsOpsMigracao: {
      renameSync: (de, para) => {
        if (String(de).includes(chave)) tentativas++
        if (presa && String(de).includes(chave)) throw Object.assign(new Error('aberto'), { code: 'EBUSY' })
        return fs.renameSync(de, para)
      },
    },
    ...opcoes,
  })
  camada(a, '5')
  notaV5(a, { chave })
  const passada = async () => {
    a.org.agendar()
    await a.org.aguardar()
  }
  const logs = () => a.logs.filter(([, m]) => /Migração retomada/.test(m))
  return { ...a, passada, logs, tentativas: () => tentativas, soltar: () => (presa = false), passar: (ms) => (agora += ms) }
}

test('I-3: captura em andamento não migra; ao terminar, migra', async (t) => {
  let capturando = 'em andamento'
  const a = comMigracaoPresa(t, { capturaEmAndamento: () => capturando })
  a.soltar()
  await a.passada()
  assert.equal(a.tentativas(), 0)
  assert.equal(layout(a), '5')
  assert.deepEqual(a.logs(), [])
  capturando = null
  await a.passada()
  assert.equal(a.tentativas(), 1)
  assert.equal(layout(a), VERSAO_XML)
})

test('I-3: dois resultados iguais não repetem dentro de 1 hora e repetem depois; o log só muda com o resultado', async (t) => {
  const a = comMigracaoPresa(t)
  await a.passada() // numera a pasta do mês: houve avanço
  await a.passada()
  await a.passada()
  const duas = a.tentativas()
  assert.ok(duas >= 2, String(duas))
  assert.equal(a.logs().length, 2, 'mesmo resultado: não repete o log')
  await a.passada()
  a.passar(UMA_HORA - 1)
  await a.passada()
  assert.equal(a.tentativas(), duas, 'dentro de 1 hora não tenta')

  a.passar(1)
  await a.passada()
  assert.ok(a.tentativas() > duas, 'depois de 1 hora tenta')
  assert.equal(a.logs().length, 2)

  a.soltar()
  a.passar(UMA_HORA)
  await a.passada()
  assert.equal(layout(a), VERSAO_XML)
  assert.equal(a.logs().length, 3, 'resultado novo: novo log')
})

test('rodada 3: a espera de 1 hora zera depois de trocar a pasta', async (t) => {
  const a = comMigracaoPresa(t)
  await a.passada()
  await a.passada()
  await a.passada()
  const antes = a.tentativas()
  await a.passada()
  assert.equal(a.tentativas(), antes, 'está na espera')
  const nova = `${a.raiz}-nova`
  t.after(() => fs.rmSync(nova, { recursive: true, force: true }))
  fs.cpSync(a.raiz, nova, { recursive: true })
  a.config.pastaXmls = nova
  await a.passada()
  assert.ok(a.tentativas() > antes, 'pasta nova tenta na hora')
})

test('I-3: progresso na tentativa não faz esperar', async (t) => {
  const a = comMigracaoPresa(t)
  const outra = '3'.repeat(44)
  await a.passada()
  notaV5(a, { chave: outra })
  await a.passada()
  assert.ok(a.existe(a.tipo(), 'XML', `${outra}-nfe.xml`), 'moveu um: não é falta de avanço')
  const outraNova = '4'.repeat(44)
  notaV5(a, { chave: outraNova })
  await a.passada()
  assert.ok(a.existe(a.tipo(), 'XML', `${outraNova}-nfe.xml`))
})

// ---------- rodada 3: o que fica na pasta antiga prende o grupo ----------

const eventoNa = (a, chave, pasta = 'Cliente 1') => {
  const rel = path.join(pasta, '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e', `${chave}-evento-110111-1.xml`)
  fs.mkdirSync(path.dirname(a.abs(rel)), { recursive: true })
  fs.writeFileSync(a.abs(rel), '<evento/>')
  a.db.prepare("INSERT INTO eventos (chave, tp_evento, n_seq, caminho_xml) VALUES (?, '110111', '1', ?)").run(chave, rel)
  return rel
}
const noArquivo = (nome) => (e) => {
  assert.ok(e.message.includes(nome), e.message)
  return true
}
/** Serviço e gerador novos sobre o mesmo banco: como depois de reabrir o app. */
function reaberto(a) {
  const servico = criarServicoClientes({ db: a.db, config: a.config, logger: silencioso })
  return criarGerador({ db: a.db, config: a.config, logger: a.deps.logger, reconciliarPasta: (c) => servico.reconciliarPasta(c) })
}

test('rodada 3: evento travado de vez rejeita mesmo com as notas movidas, também depois de reabrir, e o ZIP sai com ele ao destravar', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const relEvento = eventoNa(a, velha.chave)
  const nomeEvento = path.basename(relEvento)
  const trava = travarDeVez(t, 'evento-110111')

  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(nomeEvento))
  assert.equal(caminhoDe(a, velha.chave), relNovo(velha.relativo), 'as notas foram')
  assert.equal(pendente(a), 'Cliente 1')
  assert.ok(a.existe(relEvento))
  assert.equal(a.db.prepare('SELECT caminho_xml FROM eventos').pluck().get(), relEvento)

  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(nomeEvento))
  await assert.rejects(reaberto(a).gerarGrupo(a.grupoDe(), {}), noArquivo(nomeEvento))
  assert.ok(!a.existe(NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip'))

  trava.soltar()
  await reaberto(a).gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.ok(!a.existe('Cliente 1'))
  assert.ok(noZip(a, NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip').includes(`Eventos/${nomeEvento}`))
})

test('rodada 4: evento travado ao apagar com link físico: sobra inofensiva, o grupo sai com ele no ZIP e o log sai uma vez por volta', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const relEvento = eventoNa(a, velha.chave)
  const outroEvento = path.join(path.dirname(relEvento), `${velha.chave}-evento-110110-1.xml`)
  fs.writeFileSync(a.abs(outroEvento), '<outro-evento/>')
  travarAoApagar(t, 'evento-1101')
  const logs = []
  const servico = criarServicoClientes({ db: a.db, config: a.config, logger: { info() {}, error() {}, warn: (m, d) => logs.push([m, d]) } })
  const gerador = criarGerador({ db: a.db, config: a.config, logger: a.deps.logger, reconciliarPasta: (c) => servico.reconciliarPasta(c) })

  await gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe(relEvento), 'a origem fica')
  assert.equal(a.db.prepare('SELECT caminho_xml FROM eventos').pluck().get(), relNovo(relEvento))
  assert.ok(noZip(a, NF_E_NOVA, 'Novo Nome NF-e Entradas Novembro 2026.zip').includes(`Eventos/${path.basename(relEvento)}`))
  assert.equal(logs.filter(([m]) => /nas duas pastas/.test(m)).length, 1)
})

test('rodada 4: sem link físico e origem travada ao apagar: manda fechar e, ao soltar, a cópia igual leva a origem embora', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.mkdirSync(a.abs('Novo Nome'))
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('sem link'), { code: 'EPERM' })
  })
  const trava = travarAoApagar(t, n.chave)
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), mensagemDaPasta)
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo), 'o banco aponta para o destino')
  assert.ok(a.existe(n.relativo))
  assert.equal(pendente(a), 'Cliente 1')
  trava.soltar()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.ok(!a.existe(n.relativo))
  assert.equal(pendente(a), undefined)
})

test('rodada 3: resumo sem linha no banco travado também prende o grupo; depois de soltar, sai da pasta antiga', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  const relResumo = path.join('Cliente 1', '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e', `${velha.chave}-resumo.xml`)
  fs.mkdirSync(path.dirname(a.abs(relResumo)), { recursive: true })
  fs.writeFileSync(a.abs(relResumo), '<res/>')
  a.nota()
  const trava = travarDeVez(t, '-resumo.xml')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(path.basename(relResumo)))
  await assert.rejects(reaberto(a).gerarGrupo(a.grupoDe(), {}), noArquivo(path.basename(relResumo)))
  assert.equal(pendente(a), 'Cliente 1')
  trava.soltar()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe('Novo Nome', '2026', '11-Novembro', 'Eventos e Resumos', 'NF-e', `${velha.chave}-resumo.xml`))
})

test('rodada 3: evento na pasta do escritório, sem nenhuma junção, não prende o grupo', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  const relEvento = eventoNa(a, n.chave, 'Escritorio')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe(relEvento), 'fica onde está')
  assert.ok(a.existe(a.tipo(), ZIP_NFE))
})

test('rodada 3: relatório, ZIP e PDF na pasta antiga não são pendência nem conflito, e nenhum é sobrescrito', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const antiga = path.join('Cliente 1', '2026', '11-Novembro', 'Entradas', 'NF-e')
  const nomes = ['Relatorio NF-e Entradas Novembro 2026.xlsx', 'Cliente 1 NF-e Entradas Novembro 2026.zip', path.join('PDF', 'Entradas', `${n.chave}-nfe.pdf`)]
  for (const nome of nomes) {
    fs.mkdirSync(path.dirname(a.abs(antiga, nome)), { recursive: true })
    fs.writeFileSync(a.abs(antiga, nome), 'da pasta antiga')
    fs.mkdirSync(path.dirname(a.abs(NF_E_NOVA, nome)), { recursive: true })
    fs.writeFileSync(a.abs(NF_E_NOVA, nome), 'da pasta nova')
  }
  // Só este é igual dos dois lados: sai da origem depois da comparação.
  const igual = 'Relatorio NF-e Entradas Novembro 2026.pdf'
  fs.writeFileSync(a.abs(antiga, igual), 'igual')
  fs.writeFileSync(a.abs(NF_E_NOVA, igual), 'igual')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  for (const nome of nomes) assert.equal(fs.readFileSync(a.abs(antiga, nome), 'utf8'), 'da pasta antiga', nome)
  assert.ok(!a.existe(antiga, igual))
})

test('rodada 3: origem sumida reaponta o que existe no destino e remove a chave', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const relEvento = eventoNa(a, velha.chave)
  const trava = travarDeVez(t, 'evento-110111')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(path.basename(relEvento)))
  trava.soltar()
  fs.mkdirSync(path.dirname(a.abs(relNovo(relEvento))), { recursive: true })
  fs.copyFileSync(a.abs(relEvento), a.abs(relNovo(relEvento)))
  fs.rmSync(a.abs('Cliente 1'), { recursive: true })
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.equal(a.db.prepare('SELECT caminho_xml FROM eventos').pluck().get(), relNovo(relEvento))
})

test('rodada 3: chave de pasta que voltou a ser a certa é removida', async (t) => {
  const a = comClientes(t)
  a.nota()
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Cliente 1')
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
})

test('rodada 3: com a chave e nota de outro cliente na pasta, o motivo real aparece e nada é mexido', async (t) => {
  const a = comClientes(t)
  const velha = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const relEvento = eventoNa(a, velha.chave)
  const trava = travarDeVez(t, 'evento-110111')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(path.basename(relEvento)))
  trava.soltar()
  const outra = a.nota({ cliente: a.ids[1] })
  const naAntiga = outra.relativo.replace('Cliente 2', 'Cliente 1')
  fs.mkdirSync(path.dirname(a.abs(naAntiga)), { recursive: true })
  fs.renameSync(a.abs(outra.relativo), a.abs(naAntiga))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(naAntiga, outra.chave)
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.match(e.message, /notas de outra empresa/)
    assert.doesNotMatch(e.message, /Feche/)
    return true
  })
  assert.equal(pendente(a), 'Cliente 1')
  assert.ok(a.existe(relEvento))
})

test('rodada 3: excluir o cliente remove a chave dele', async (t) => {
  const a = comClientes(t)
  a.nota()
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Antiga')
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[1]}`, 'Outra')
  a.servico.excluir(CNPJS[0])
  assert.equal(pendente(a), undefined)
  assert.equal(pendente(a, a.ids[1]), 'Outra')
})

test('rodada 3: duas pastas antigas com sobra: uma não apaga a pendência da outra', async (t) => {
  const a = comClientes(t)
  a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Mais Antiga')
  const relSobra = path.join('Mais Antiga', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'presa.xml')
  fs.mkdirSync(path.dirname(a.abs(relSobra)), { recursive: true })
  fs.writeFileSync(a.abs(relSobra), '<x/>')
  fs.mkdirSync(a.abs('Novo Nome'))
  const trava = travarDeVez(t, 'Entradas')
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo('presa.xml'))
  assert.deepEqual(pendente(a).split('\n').sort(), ['Cliente 1', 'Mais Antiga'])
  trava.soltar()
  await a.gerador.gerarGrupo(a.grupoDe(), {})
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe('Novo Nome', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', 'presa.xml'))
})

// ---------- rodada 3: juntar sem sobrescrever ----------

test('rodada 3: existsSync enganado e arquivo diferente no destino: o destino fica e o conflito aparece', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, n.relativo, '<outro/>')
  const antes = fs.readFileSync(a.abs(n.relativo))
  const noDestino = a.abs(relNovo(n.relativo))
  const original = fs.existsSync
  t.mock.method(fs, 'existsSync', (p) => (String(p) === noDestino ? false : original(p)))
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), /conteúdo diferente/)
  assert.equal(fs.readFileSync(noDestino, 'utf8'), '<outro/>')
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), antes)
  assert.equal(caminhoDe(a, n.chave), n.relativo)
  assert.equal(pendente(a), 'Cliente 1')
})

test('rodada 3: disco sem link físico junta por cópia, confere e apaga a origem, sem sobrescrever o que é diferente', async (t) => {
  const a = comClientes(t)
  const leva = a.nota()
  const diferente = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  noLadoNovo(a, diferente.relativo, '<outro/>')
  const conteudo = fs.readFileSync(a.abs(leva.relativo))
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('sem link'), { code: 'EPERM' })
  })
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), /conteúdo diferente/)
  assert.deepEqual(fs.readFileSync(a.abs(relNovo(leva.relativo))), conteudo)
  assert.ok(!a.existe(leva.relativo))
  assert.equal(caminhoDe(a, leva.chave), relNovo(leva.relativo))
  assert.equal(fs.readFileSync(a.abs(relNovo(diferente.relativo)), 'utf8'), '<outro/>')
  assert.ok(a.existe(diferente.relativo))
})

test('rodada 3: cópia com tamanho errado não apaga a origem nem deixa o arquivo pela metade', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  a.nota()
  const conteudo = fs.readFileSync(a.abs(n.relativo))
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('sem link'), { code: 'EPERM' })
  })
  t.mock.method(fs, 'copyFileSync', (de, para) => fs.writeFileSync(para, 'pela metade'))
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), noArquivo(path.basename(n.relativo)))
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.equal(caminhoDe(a, n.chave), n.relativo)
  assert.ok(!a.existe(relNovo(n.relativo)))
})

// ---------- rodada 4: nada some, nada truncado, motivo real ----------

const semLink = (t) =>
  t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('sem link'), { code: 'EPERM' })
  })
const reconciliar = (a) => a.servico.reconciliarPasta(a.db.prepare('SELECT * FROM clientes WHERE id = ?').get(a.ids[0]))
const statFalso = (t, trocar) => {
  const original = fs.statSync
  t.mock.method(fs, 'statSync', (caminho, opcoes) => {
    const s = original(caminho, opcoes)
    return opcoes?.bigint ? trocar(s) : s
  })
}
/** Cliente renomeado, com a nota na pasta antiga e a pasta nova já criada. */
function renomeado(t) {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.mkdirSync(a.abs('Novo Nome'))
  return { a, n, conteudo: fs.readFileSync(a.abs(n.relativo)) }
}

for (const [nome, adulterar] of [
  ['stats verdadeiros', () => {}],
  ['ino de pasta instável', (t) => {
    let n = 0n
    statFalso(t, (s) => (s.isDirectory() ? { ...s, ino: ++n + 1000n } : s))
  }],
  ['ino de pasta instável e nlink 2', (t) => {
    let n = 0n
    statFalso(t, (s) => (s.isDirectory() ? { ...s, ino: ++n + 1000n } : { ...s, nlink: 2n }))
  }],
]) {
  test(`rodada 4: junction com hard link fora dali, ${nome}: nenhum arquivo some e nada fica preso`, (t) => {
    const a = comClientes(t)
    const n = a.nota()
    apelido(a, a.ids[0], 'Novo Nome')
    const conteudo = fs.readFileSync(a.abs(n.relativo))
    const fora = path.join(a.raiz, 'fora.xml')
    fs.linkSync(a.abs(n.relativo), fora)
    fs.symlinkSync(a.abs('Cliente 1'), a.abs('Novo Nome'), 'junction')
    t.after(() => fs.rmSync(a.abs('Novo Nome'), { recursive: true, force: true }))
    adulterar(t)
    assert.deepEqual(reconciliar(a), [])
    t.mock.restoreAll()
    assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
    assert.deepEqual(fs.readFileSync(fora), conteudo)
    assert.equal(pendente(a), undefined)
  })
}

test('rodada 4: junction sem link físico: não apaga nada e não prende', (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  const conteudo = fs.readFileSync(a.abs(n.relativo))
  fs.symlinkSync(a.abs('Cliente 1'), a.abs('Novo Nome'), 'junction')
  t.after(() => fs.rmSync(a.abs('Novo Nome'), { recursive: true, force: true }))
  semLink(t)
  assert.deepEqual(reconciliar(a), [])
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.deepEqual(fs.readdirSync(path.dirname(a.abs(n.relativo))), [path.basename(n.relativo)], 'sem reserva nem .tmp')
})

for (const [nome, preparo] of [
  ['link certo', () => {}],
  ['sem link físico', semLink],
]) {
  test(`rodada 4: ino 0 com o destino livre, ${nome}: o nome novo sai sem consultar ino e o cliente conclui`, (t) => {
    const { a, n, conteudo } = renomeado(t)
    preparo(t)
    statFalso(t, (s) => ({ ...s, ino: 0n }))
    assert.deepEqual(reconciliar(a), [])
    assert.deepEqual(reconciliar(a), [])
    t.mock.restoreAll()
    assert.ok(!a.existe(n.relativo))
    assert.deepEqual(fs.readFileSync(a.abs(relNovo(n.relativo))), conteudo)
    assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
    assert.equal(pendente(a), undefined)
  })
}

test('rodada 4: ino 0 com conteúdo diferente: nada apagado, nenhum sobrescrito, motivo é o conflito', (t) => {
  const { a, n, conteudo } = renomeado(t)
  noLadoNovo(a, n.relativo, '<outro/>')
  statFalso(t, (s) => ({ ...s, ino: 0n }))
  const [problema] = reconciliar(a)
  t.mock.restoreAll()
  assert.match(problema, /conteúdo diferente/)
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.equal(fs.readFileSync(a.abs(relNovo(n.relativo)), 'utf8'), '<outro/>')
})

test('rodada 4: sem link com corte no meio da cópia: nada truncado com nome final e a volta seguinte conclui, sem conflito', (t) => {
  const { a, n, conteudo } = renomeado(t)
  semLink(t)
  const copia = fs.copyFileSync
  let cortou = false
  t.mock.method(fs, 'copyFileSync', (de, para, modo) => {
    if (cortou) return copia(de, para, modo)
    cortou = true
    fs.mkdirSync(path.dirname(para), { recursive: true })
    fs.writeFileSync(para, '<no', { flag: 'wx' })
    throw Object.assign(new Error('rede'), { code: 'EIO' })
  })
  const [problema] = reconciliar(a)
  assert.match(problema, /EIO/)
  assert.doesNotMatch(problema, /Feche/)
  assert.ok(!a.existe(relNovo(n.relativo)), 'nada com o nome final')
  assert.deepEqual(reconciliar(a), [])
  assert.deepEqual(fs.readFileSync(a.abs(relNovo(n.relativo))), conteudo)
  assert.ok(!a.existe(n.relativo))
  assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  assert.equal(pendente(a), undefined)
})

test('rodada 4: falha ao dar o nome final tira a reserva, propaga e deixa a origem', (t) => {
  const { a, n, conteudo } = renomeado(t)
  semLink(t)
  const renomear = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('rede'), { code: 'EIO' })
  })
  assert.match(reconciliar(a).join(' '), /EIO/)
  assert.ok(!a.existe(relNovo(n.relativo)), 'sem reserva vazia')
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.equal(caminhoDe(a, n.chave), n.relativo)
  renomear.mock.restore()
  assert.deepEqual(reconciliar(a), [])
  assert.deepEqual(fs.readFileSync(a.abs(relNovo(n.relativo))), conteudo)
})

for (const [nome, preparo] of [
  ['sem link físico', semLink],
  ['com link físico', () => {}],
]) {
  test(`rodada 4: reserva abandonada de 0 byte, ${nome}, é substituída e não vira conflito`, (t) => {
    const { a, n, conteudo } = renomeado(t)
    noLadoNovo(a, n.relativo, '')
    preparo(t)
    assert.deepEqual(reconciliar(a), [])
    assert.deepEqual(fs.readFileSync(a.abs(relNovo(n.relativo))), conteudo)
    assert.ok(!a.existe(n.relativo))
    assert.equal(caminhoDe(a, n.chave), relNovo(n.relativo))
  })
}

test('rodada 4: origem de 0 byte e destino de 0 byte são iguais, não reserva', (t) => {
  const { a, n } = renomeado(t)
  fs.writeFileSync(a.abs(n.relativo), '')
  noLadoNovo(a, n.relativo, '')
  semLink(t)
  const renomear = t.mock.method(fs, 'renameSync')
  assert.deepEqual(reconciliar(a), [])
  assert.equal(renomear.mock.callCount(), 0)
  assert.ok(!a.existe(n.relativo))
})

test('rodada 4: destino com conteúdo e origem vazia é conflito, nunca reserva', (t) => {
  const { a, n } = renomeado(t)
  fs.writeFileSync(a.abs(n.relativo), '')
  noLadoNovo(a, n.relativo, '<do-destino/>')
  semLink(t)
  assert.match(reconciliar(a).join(' '), /conteúdo diferente/)
  assert.equal(fs.readFileSync(a.abs(relNovo(n.relativo)), 'utf8'), '<do-destino/>')
})

/** Pendência que sobrou numa pasta que agora é de outro cliente. */
function chaveNaPastaDeOutro(t) {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  fs.mkdirSync(path.dirname(a.abs(relNovo(n.relativo))), { recursive: true })
  fs.renameSync(a.abs(n.relativo), a.abs(relNovo(n.relativo)))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(relNovo(n.relativo), n.chave)
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Cliente 1')
  apelido(a, a.ids[1], 'Cliente 1')
  const outra = a.nota({ cliente: a.ids[1] })
  assert.ok(outra.relativo.startsWith('Cliente 1'))
  return { a, n, outra }
}

test('rodada 4: chave sem XML do cliente, na pasta que é de outro: sai a chave e nada é movido', (t) => {
  const { a, outra } = chaveNaPastaDeOutro(t)
  assert.deepEqual(reconciliar(a), [])
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe(outra.relativo))
  assert.ok(!a.existe(relNovo(outra.relativo)))
  assert.deepEqual(reconciliar(a), [])
})

test('rodada 4: evento do outro cliente na pasta também tem dono: sai a chave', (t) => {
  const { a, outra } = chaveNaPastaDeOutro(t)
  const relEvento = eventoNa(a, outra.chave)
  assert.deepEqual(reconciliar(a), [])
  assert.equal(pendente(a), undefined)
  assert.ok(a.existe(relEvento))
})

test('rodada 4: chave na pasta de outro, restando XML sem linha dele: rejeita com o nome e o motivo, sem mover', (t) => {
  const { a, outra } = chaveNaPastaDeOutro(t)
  const solto = path.join(path.dirname(outra.relativo), 'sem-dono.xml')
  fs.writeFileSync(a.abs(solto), '<x/>')
  const [problema] = reconciliar(a)
  assert.match(problema, /sem-dono\.xml/)
  assert.match(problema, /outra empresa/)
  assert.doesNotMatch(problema, /Feche/)
  assert.equal(pendente(a), 'Cliente 1')
  assert.ok(a.existe(solto))
  assert.ok(!a.existe(relNovo(solto)))
})

test('rodada 4: pasta que continua no banco do cliente segue na guarda, mesmo sem XML solto', (t) => {
  const a = comClientes(t)
  const n = a.nota()
  const outra = a.nota({ cliente: a.ids[1] })
  const naPrimeira = outra.relativo.replace('Cliente 2', 'Cliente 1')
  fs.mkdirSync(path.dirname(a.abs(naPrimeira)), { recursive: true })
  fs.renameSync(a.abs(outra.relativo), a.abs(naPrimeira))
  a.db.prepare('UPDATE notas SET caminho_xml = ? WHERE chave = ?').run(naPrimeira, outra.chave)
  apelido(a, a.ids[0], 'Novo Nome')
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Cliente 1')
  assert.match(reconciliar(a).join(' '), /notas de outra empresa/)
  assert.equal(pendente(a), 'Cliente 1')
  assert.ok(a.existe(n.relativo))
})

test('rodada 4: renomear a pasta com erro que não é trava mostra o erro, sem mandar fechar', (t) => {
  const a = comClientes(t)
  const n = a.nota()
  apelido(a, a.ids[0], 'Novo Nome')
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('rede'), { code: 'EIO' })
  })
  const [problema] = reconciliar(a)
  assert.match(problema, /EIO/)
  assert.ok(problema.includes(path.basename(n.relativo)), problema)
  assert.doesNotMatch(problema, /Feche/)
})

test('rodada 4: pendência na própria pasta diz o arquivo e o motivo, sem "está como X e deveria ser X"', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Cliente 1')
  a.db.prepare("UPDATE sistema SET valor = 'antigo' WHERE chave = 'pastas_layout'").run()
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), (e) => {
    assert.doesNotMatch(e.message, /deveria ser/)
    assert.doesNotMatch(e.message, /Feche/)
    assert.ok(e.message.includes(path.basename(n.relativo)), e.message)
    assert.match(e.message, /organização das pastas ainda não terminou/)
    return true
  })
})

test('rodada 4: pendência na própria pasta aponta o XML sem linha no banco, quando houver', async (t) => {
  const a = comClientes(t)
  const n = a.nota()
  const solto = path.join(path.dirname(n.relativo), 'solto.xml')
  fs.writeFileSync(a.abs(solto), '<x/>')
  a.db.prepare('INSERT INTO sistema (chave, valor) VALUES (?, ?)').run(`pasta_pendente:${a.ids[0]}`, 'Cliente 1')
  a.db.prepare("UPDATE sistema SET valor = 'antigo' WHERE chave = 'pastas_layout'").run()
  await assert.rejects(a.gerador.gerarGrupo(a.grupoDe(), {}), /solto\.xml/)
})

test('rodada 5: mesmo ino informado para arquivos de conteúdo diferente: o banco não aponta para o outro, nada some e é conflito', (t) => {
  const { a, n, conteudo } = renomeado(t)
  noLadoNovo(a, n.relativo, '<outro/>')
  statFalso(t, (s) => ({ ...s, ino: 42n }))
  const [problema] = reconciliar(a)
  t.mock.restoreAll()
  assert.match(problema, /conteúdo diferente/)
  assert.equal(caminhoDe(a, n.chave), n.relativo)
  assert.deepEqual(fs.readFileSync(a.abs(n.relativo)), conteudo)
  assert.equal(fs.readFileSync(a.abs(relNovo(n.relativo)), 'utf8'), '<outro/>')
  assert.ok(pendente(a))
})
