'use strict'

// Troca de pasta: mesma pasta por outro endereço, sobras na origem, parada, andamento e tentativas.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { abrirBanco } = require('../src/db')
const { criarServicoPastas, MARCA } = require('../src/services/pastas')

const REL = (n) => path.join('Foo', '2026', '11-Novembro', 'Entradas', 'NF-e', 'XML', `${n}-nfe.xml`)

function preparar(t, { marca = true, opcoes = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-troca-'))
  const atual = path.join(base, 'atual')
  const nova = path.join(base, 'nova')
  fs.mkdirSync(atual)
  fs.mkdirSync(nova)
  const db = abrirBanco(':memory:')
  const logs = []
  const logger = { info() {}, warn: (m, d) => logs.push([m, d]), error: (m, d) => logs.push([m, d]) }
  const config = { pastaXmls: atual, pastaExports: path.join(base, 'exportacoes'), raiz: path.join(base, 'dados'), pastaEstoque: path.join(base, 'estoque') }
  const links = []
  t.after(() => {
    // Junction no Windows sai com rmdir; no Linux vira link simbólico, que sai com unlink.
    for (const l of links) (process.platform === 'win32' ? fs.rmdirSync : fs.unlinkSync)(l)
    db.close()
    fs.rmSync(base, { recursive: true, force: true })
  })
  if (marca) fs.writeFileSync(path.join(atual, MARCA), '')
  const esperas = []
  const novoServico = (extra = {}) => criarServicoPastas({ db, config, logger, dormir: async (ms) => esperas.push(ms), ...opcoes, ...extra })
  const nota = (n, conteudo = `<${n}/>`) => {
    const rel = REL(n)
    fs.mkdirSync(path.dirname(path.join(atual, rel)), { recursive: true })
    fs.writeFileSync(path.join(atual, rel), conteudo)
    db.prepare("INSERT OR IGNORE INTO clientes (id, cnpj, razao_social, uf, cert_arquivo, cert_senha_enc) VALUES (1, '11222333000181', 'Foo', 'CE', 'x.pfx', 'a:b:c')").run()
    db.prepare("INSERT INTO notas (cliente_id, chave, status, competencia, caminho_xml) VALUES (1, ?, 'completa', '2026-11', ?)").run(n, rel)
    return rel
  }
  const link = (alvo, nome = 'alias') => {
    const caminho = path.join(base, nome)
    fs.symlinkSync(alvo, caminho, 'junction')
    links.push(caminho)
    return caminho
  }
  const valor = (chave) => db.prepare('SELECT valor FROM sistema WHERE chave = ?').get(chave)?.valor
  const arquivos = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((i) => i.isFile()).map((i) => path.relative(d, path.join(i.parentPath, i.name))).sort()
  return { base, atual, nova, db, config, logs, esperas, novoServico, pastas: novoServico(), nota, link, valor, arquivos }
}

/** Faz fsp.copyFile esperar `portao` na chamada `qual`; `entrou` resolve quando chegou lá. */
function seguraCopia(t, qual = 1) {
  const original = fsp.copyFile
  let chamadas = 0
  let soltar
  let dentro
  const portao = new Promise((r) => (soltar = r))
  const entrou = new Promise((r) => (dentro = r))
  t.mock.method(fsp, 'copyFile', async (...args) => {
    if (++chamadas === qual) {
      dentro()
      await portao
    }
    return original(...args)
  })
  return { soltar, entrou }
}

const erroCom = (code) => Object.assign(new Error(code), { code })

// ---------- C1: mesma pasta por outro endereço ----------

test('C1: outra entrada (junction) para a mesma pasta só troca o endereço: nenhum arquivo some', async (t) => {
  const a = preparar(t)
  const rels = [a.nota('1'), a.nota('2')]
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  const r = await a.pastas.mudarPrincipal(alias)
  assert.equal(r.movidos, 0)
  assert.equal(r.mudou, true)
  assert.equal(r.raiz, alias)
  assert.deepEqual(a.arquivos(a.atual), antes, 'nada some nem aparece, nem a sonda')
  for (const rel of rels) assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.valor('pasta_xmls'), alias)
  assert.equal(a.valor('pasta_principal'), alias)
  assert.equal(a.config.pastaXmls, alias)
})

test('C1: junction de pasta sem marca também é a mesma pasta, em vez de recusar ou copiar', async (t) => {
  const a = preparar(t, { marca: false })
  a.nota('1')
  const alias = a.link(a.atual)
  const r = await a.pastas.mudarPrincipal(alias)
  assert.deepEqual([r.movidos, r.mudou], [0, true])
  assert.ok(fs.existsSync(path.join(a.atual, REL('1'))))
})

test('C1: pasta de exportações por junction também não perde nada', async (t) => {
  const a = preparar(t)
  fs.mkdirSync(a.config.pastaExports)
  fs.writeFileSync(path.join(a.config.pastaExports, 'a.zip'), 'zip')
  const alias = a.link(a.config.pastaExports)
  const r = await a.pastas.mudar('exports', alias)
  assert.deepEqual([r.movidos, r.mudou], [0, true])
  assert.equal(fs.readFileSync(path.join(a.config.pastaExports, 'a.zip'), 'utf8'), 'zip')
  assert.equal(a.valor('pasta_exports'), alias)
  assert.equal(a.valor('pasta_principal'), undefined)
})

test('C1: pasta realmente diferente não fica com a sonda e os arquivos são levados', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual([r.movidos, r.mudou], [1, true])
  assert.ok(fs.existsSync(path.join(a.nova, rel)))
  assert.ok(!fs.existsSync(path.join(a.atual, rel)))
  assert.ok(!a.arquivos(a.nova).some((f) => f.includes('sonda')))
})

test('C1: falha ao gravar a sonda recusa a troca e nada muda', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  const original = fsp.writeFile
  t.mock.method(fsp, 'writeFile', async (arquivo, ...resto) => {
    if (String(arquivo).includes('sonda')) throw erroCom('EACCES')
    return original(arquivo, ...resto)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /Não consegui gravar .*EACCES/)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.equal(a.valor('pasta_principal'), undefined)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.deepEqual(a.arquivos(a.nova), [])
})

test('C1: a sonda é apagada mesmo quando a conferência falha', async (t) => {
  const a = preparar(t)
  a.nota('1')
  const original = fsp.open
  t.mock.method(fsp, 'open', async (arquivo, ...resto) => {
    if (String(arquivo).includes('sonda')) throw erroCom('EIO')
    return original(arquivo, ...resto)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EIO/)
  assert.deepEqual(a.arquivos(a.nova), [])
})

test('C1: mesmo arquivo físico nos dois lados (sonda enganada) recusa em vez de apagar', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  fs.writeFileSync(path.join(a.nova, MARCA), '')
  fs.mkdirSync(path.dirname(path.join(a.nova, rel)), { recursive: true })
  fs.linkSync(path.join(a.atual, rel), path.join(a.nova, rel))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /Nada mudou/)
  assert.ok(fs.existsSync(path.join(a.atual, rel)), 'a origem fica')
  assert.equal(a.config.pastaXmls, a.atual)
})

// ---------- I5: falha ao apagar a origem e erro no commit ----------

test('I5: EBUSY ao apagar um arquivo não desfaz a troca: conta o que sobrou e segue com os outros', async (t) => {
  const a = preparar(t)
  const presa = a.nota('1')
  const solta = a.nota('2')
  const original = fsp.rm
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (arquivo === path.join(a.atual, presa)) throw erroCom('EBUSY')
    return original(arquivo, ...resto)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual([r.movidos, r.mudou], [2, true])
  assert.deepEqual(r.avisos, ['1 arquivo não saiu da pasta antiga. Pode apagá-lo depois.'])
  assert.ok(fs.existsSync(path.join(a.atual, presa)))
  assert.ok(!fs.existsSync(path.join(a.atual, solta)), 'o resto saiu')
  assert.ok(fs.existsSync(path.join(a.nova, presa)))
  assert.equal(a.config.pastaXmls, a.nova)
  assert.ok(a.logs.some(([m]) => /não saiu da pasta antiga/.test(m)))
})

test('I5: vários arquivos presos usam o plural', async (t) => {
  const a = preparar(t)
  a.nota('1')
  a.nota('2')
  const original = fsp.rm
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (String(arquivo).startsWith(a.atual) && String(arquivo).endsWith('.xml')) throw erroCom('EPERM')
    return original(arquivo, ...resto)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual(r.avisos, ['2 arquivos não saíram da pasta antiga. Pode apagá-los depois.'])
})

test('I5: arquivo diferente mantido na origem vira aviso com o nome', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  fs.writeFileSync(path.join(a.nova, MARCA), '')
  fs.mkdirSync(path.dirname(path.join(a.nova, rel)), { recursive: true })
  fs.writeFileSync(path.join(a.nova, rel), 'outro conteúdo')
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.avisos.length, 1)
  assert.match(r.avisos[0], /1 arquivo diferente já estava na pasta nova e ficou na antiga/)
  assert.ok(r.avisos[0].includes(rel))
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
})

test('I5: erro na transação: "Nada mudou", banco e config como estavam, origem inteira', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  a.db.exec("CREATE TRIGGER falha BEFORE INSERT ON sistema WHEN NEW.chave = 'pasta_principal' BEGIN SELECT RAISE(ABORT, 'falhou'); END")
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), (e) => e.message === `Nada mudou: continua em ${a.atual}.`)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.equal(a.valor('pasta_xmls'), undefined)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.ok(!fs.existsSync(path.join(a.nova, rel)), 'o que esta tentativa criou sai do destino')
  assert.equal(a.pastas.movendoAgora(), false)
})

test('I5: erro na transação da mesma pasta por outro endereço também avisa "Nada mudou"', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  const alias = a.link(a.atual)
  a.db.exec("CREATE TRIGGER falha BEFORE INSERT ON sistema WHEN NEW.chave = 'pasta_principal' BEGIN SELECT RAISE(ABORT, 'falhou'); END")
  await assert.rejects(a.pastas.mudarPrincipal(alias), /^Error: Nada mudou: continua em /)
  assert.equal(a.valor('pasta_xmls'), undefined, 'a transação desfaz pasta_xmls')
  assert.equal(a.config.pastaXmls, a.atual)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
})

// ---------- I6: parada ----------

test('I6: parada antes do commit: fica como estava, sem .tmp, e repetir continua de onde parou', async (t) => {
  const a = preparar(t)
  const [r1, r2, r3] = [a.nota('1'), a.nota('2'), a.nota('3')]
  const { soltar, entrou } = seguraCopia(t, 2)
  const troca = a.pastas.mudarPrincipal(a.nova)
  await entrou
  const parou = a.pastas.pararTroca()
  soltar()
  const r = await troca
  await parou
  assert.equal(r.mudou, false)
  assert.equal(r.interrompida, true)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.equal(a.valor('pasta_principal'), undefined)
  for (const rel of [r1, r2, r3]) assert.ok(fs.existsSync(path.join(a.atual, rel)), 'a origem fica inteira')
  assert.ok(fs.existsSync(path.join(a.nova, r1)), 'o que já foi copiado continua no destino')
  assert.ok(!fs.existsSync(path.join(a.nova, r3)), 'parou entre arquivos')
  assert.ok(!a.arquivos(a.nova).some((f) => f.endsWith('.tmp')))
  assert.equal(a.pastas.movendoAgora(), false)

  // Depois de reabrir o app, escolher a pasta de novo termina a troca.
  t.mock.restoreAll()
  const r2a = await a.novoServico().mudarPrincipal(a.nova)
  assert.deepEqual([r2a.movidos, r2a.mudou], [3, true])
  for (const rel of [r1, r2, r3]) {
    assert.ok(fs.existsSync(path.join(a.nova, rel)))
    assert.ok(!fs.existsSync(path.join(a.atual, rel)))
  }
})

test('I6: parada depois do commit: para de apagar, avisa e o endereço novo vale', async (t) => {
  const a = preparar(t)
  const rels = [a.nota('1'), a.nota('2'), a.nota('3')]
  const original = fsp.rm
  let apagados = 0
  let pedido = null
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (String(arquivo).startsWith(a.atual) && String(arquivo).endsWith('.xml') && ++apagados === 1) pedido = a.pastas.pararTroca()
    return original(arquivo, ...resto)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  await pedido
  assert.equal(r.mudou, true)
  assert.equal(apagados, 1, 'parou de apagar')
  assert.equal(a.config.pastaXmls, a.nova)
  assert.equal(a.valor('pasta_principal'), a.nova)
  for (const rel of rels) assert.ok(fs.existsSync(path.join(a.nova, rel)))
  assert.equal(rels.filter((rel) => fs.existsSync(path.join(a.atual, rel))).length, 2)
  assert.deepEqual(r.avisos, ['2 arquivos não saíram da pasta antiga. Pode apagá-los depois.'])
  assert.ok(a.logs.some(([m]) => /interrompida depois/.test(m)))
})

test('I6: pararTroca sem troca resolve na hora e, depois dela, nenhuma troca começa', async (t) => {
  const a = preparar(t)
  a.nota('1')
  await a.pastas.pararTroca()
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /fechando/)
  assert.equal(a.config.pastaXmls, a.atual)
})

test('I6: erro de um arquivo durante a parada não apaga o que já foi copiado', async (t) => {
  const a = preparar(t)
  const [r1] = [a.nota('1'), a.nota('2')]
  const original = fsp.copyFile
  let chamadas = 0
  t.mock.method(fsp, 'copyFile', async (...args) => {
    if (++chamadas === 2) {
      a.pastas.pararTroca()
      throw erroCom('EBUSY')
    }
    return original(...args)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.interrompida, true)
  assert.ok(fs.existsSync(path.join(a.nova, r1)))
  assert.deepEqual(a.esperas, [], 'parando, não espera a próxima tentativa')
})

// ---------- I7: andamento ----------

test('I7: estado().movendo mostra tipo, feitos, total e fase, e volta a null', async (t) => {
  const a = preparar(t)
  a.nota('1')
  a.nota('2')
  assert.equal(a.pastas.estado().movendo, null)
  const { soltar, entrou } = seguraCopia(t, 2)
  const troca = a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual(a.pastas.estado().movendo, { tipo: 'xmls', feitos: 0, total: 0, fase: 'copiando' }, 'desde antes do primeiro await')
  await entrou
  assert.deepEqual(a.pastas.estado().movendo, { tipo: 'xmls', feitos: 1, total: 2, fase: 'copiando' })

  const fases = []
  const original = fsp.rm
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (String(arquivo).startsWith(a.atual) && String(arquivo).endsWith('.xml')) fases.push(a.pastas.estado().movendo)
    return original(arquivo, ...resto)
  })
  soltar()
  await troca
  assert.deepEqual(fases, [{ tipo: 'xmls', feitos: 0, total: 2, fase: 'apagando' }, { tipo: 'xmls', feitos: 1, total: 2, fase: 'apagando' }])
  assert.equal(a.pastas.estado().movendo, null)
})

test('I7: estado() devolve cópia: quem lê não muda o andamento', async (t) => {
  const a = preparar(t)
  a.nota('1')
  const { soltar, entrou } = seguraCopia(t)
  const troca = a.pastas.mudarPrincipal(a.nova)
  await entrou
  a.pastas.estado().movendo.total = 99
  assert.equal(a.pastas.estado().movendo.total, 1)
  soltar()
  await troca
})

test('I7: estado() não olha o disco', async (t) => {
  const a = preparar(t)
  a.nota('1')
  const proibido = () => assert.fail('estado() não pode ir ao disco')
  for (const nome of ['readdirSync', 'statSync', 'existsSync']) t.mock.method(fs, nome, proibido)
  a.pastas.estado()
  t.mock.restoreAll()
})

// ---------- I11: tentativas ----------

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ETIMEDOUT', 'EIO', 'UNKNOWN']) {
  test(`I11: ${code} passageiro tenta de novo com espera crescente e a troca termina`, async (t) => {
    const a = preparar(t)
    const rel = a.nota('1')
    const original = fsp.copyFile
    let chamadas = 0
    t.mock.method(fsp, 'copyFile', async (...args) => {
      if (++chamadas <= 3) throw erroCom(code)
      return original(...args)
    })
    const r = await a.pastas.mudarPrincipal(a.nova)
    assert.equal(r.mudou, true)
    assert.equal(chamadas, 4)
    assert.deepEqual(a.esperas, [500, 2000, 5000])
    assert.ok(fs.existsSync(path.join(a.nova, rel)))
  })
}

test('I11: esgotadas as tentativas, desfaz e diz que nada mudou', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  t.mock.method(fsp, 'copyFile', async () => {
    throw erroCom('EBUSY')
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EBUSY.*Nada mudou/)
  assert.deepEqual(a.esperas, [500, 2000, 5000])
  assert.equal(a.config.pastaXmls, a.atual)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
})

test('I11: erro que não é passageiro não tenta de novo', async (t) => {
  const a = preparar(t)
  a.nota('1')
  let chamadas = 0
  t.mock.method(fsp, 'copyFile', async () => {
    chamadas++
    throw erroCom('ENOSPC')
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /ENOSPC/)
  assert.equal(chamadas, 1)
  assert.deepEqual(a.esperas, [])
})

test('I11: aoMudarTroca avisa no começo e no fim, mesmo quando a troca falha', async (t) => {
  const a = preparar(t)
  const avisos = []
  const cancelar = a.pastas.aoMudarTroca((trocando) => avisos.push(trocando))
  a.nota('1')
  await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual(avisos, [true, false])
  await assert.rejects(a.pastas.mudarPrincipal('relativa'))
  assert.deepEqual(avisos, [true, false, true, false])
  cancelar()
  await assert.rejects(a.pastas.mudarPrincipal('relativa'))
  assert.equal(avisos.length, 4)
})

test('I11: erro em quem escuta não atrapalha a troca', async (t) => {
  const a = preparar(t)
  a.pastas.aoMudarTroca(() => {
    throw new Error('sem bloqueio')
  })
  a.nota('1')
  assert.equal((await a.pastas.mudarPrincipal(a.nova)).mudou, true)
})

// ---------- menores ----------

test('M2: banco com XMLs e 0 arquivos na pasta atual recusa a troca', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  fs.rmSync(path.join(a.atual, rel))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /A pasta atual está sem os arquivos\. Confira se a rede está conectada\./)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.deepEqual(a.arquivos(a.nova), [], 'nem a marca é gravada')
})

test('M2: sem XML no banco, pasta atual vazia pode trocar', async (t) => {
  const a = preparar(t)
  assert.equal((await a.pastas.mudarPrincipal(a.nova)).mudou, true)
})

test('M6: desktop.ini e Thumbs.db não contam para pasta vazia', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  fs.writeFileSync(path.join(a.nova, 'desktop.ini'), '[.ShellClassInfo]')
  fs.writeFileSync(path.join(a.nova, 'Thumbs.db'), 'x')
  assert.equal((await a.pastas.mudarPrincipal(a.nova)).mudou, true)
  assert.ok(fs.existsSync(path.join(a.nova, rel)))
  assert.ok(fs.existsSync(path.join(a.nova, 'desktop.ini')), 'o arquivo do Windows fica')
})

test('M8: pasta sem marca acha o XML do banco pela listagem, sem existsSync por nota e sem olhar maiúsculas', async (t) => {
  const a = preparar(t, { marca: false })
  a.nota('1')
  const ruim = path.join(a.atual, 'FOO', 'outro.xml')
  a.db.prepare("UPDATE notas SET caminho_xml = ? WHERE chave = '1'").run(REL('1').replace('Foo', 'FOO').replace(/\\/g, '/'))
  const original = fs.existsSync
  const consultas = []
  t.mock.method(fs, 'existsSync', (p) => {
    consultas.push(String(p))
    return original(p)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.movidos, 1)
  assert.ok(!consultas.some((c) => c.endsWith('1-nfe.xml')))
  assert.ok(fs.existsSync(path.join(a.nova, REL('1'))))
  assert.ok(!fs.existsSync(ruim))
})

test('M8: pasta sem marca deixa o .xml que não é do app', async (t) => {
  const a = preparar(t, { marca: false })
  const rel = a.nota('1')
  fs.writeFileSync(path.join(a.atual, 'de-alguem.xml'), 'x')
  await a.pastas.mudarPrincipal(a.nova)
  assert.ok(fs.existsSync(path.join(a.atual, 'de-alguem.xml')))
  assert.ok(fs.existsSync(path.join(a.nova, rel)))
})

test('M16: clique duplo responde que a pasta já está sendo trocada', async (t) => {
  const a = preparar(t)
  a.nota('1')
  const primeira = a.pastas.mudarPrincipal(a.nova)
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /^Error: A pasta já está sendo trocada\.$/)
  await primeira
})

// ---------- C-1: cache da rede engana a primeira sonda ----------

const SONDA = '.sonda-smart-fiscal'
const sondasEm = (a, d) => a.arquivos(d).filter((n) => n.includes(SONDA))

/** Responde às consultas da sonda: `decidir(n)` devolve o erro da n-ésima consulta, ou nada para consultar de verdade. */
function consultaDaSonda(t, decidir) {
  const original = fsp.open
  let n = 0
  t.mock.method(fsp, 'open', async (arquivo, ...resto) => {
    if (String(arquivo).includes(SONDA)) {
      const erro = decidir(++n)
      if (erro) throw erro
    }
    return original(arquivo, ...resto)
  })
}
const naoVista = () => erroCom('ENOENT')

/** Altera o stat com bigint: `mudar(stats, caminho)` devolve os campos a sobrescrever. */
function statAlterado(t, mudar) {
  const original = fsp.stat
  t.mock.method(fsp, 'stat', async (caminho, opcoes) => {
    const s = await original(caminho, opcoes)
    return opcoes?.bigint ? { ...s, ...mudar(s, String(caminho)) } : s
  })
}

/** Coloca no destino uma cópia de verdade do arquivo: outra pasta, mesmo conteúdo (troca retomada). */
function jaCopiado(a, rel) {
  fs.writeFileSync(path.join(a.nova, MARCA), '')
  fs.mkdirSync(path.dirname(path.join(a.nova, rel)), { recursive: true })
  fs.copyFileSync(path.join(a.atual, rel), path.join(a.nova, rel))
}

test('C-1: junction com a primeira sonda não vista e a segunda vista: nenhum arquivo some e movidos 0', async (t) => {
  const a = preparar(t)
  a.nota('1')
  a.nota('2')
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  consultaDaSonda(t, (n) => (n <= 2 ? naoVista() : null))
  const r = await a.pastas.mudarPrincipal(alias)
  assert.deepEqual([r.movidos, r.mudou, r.raiz], [0, true, alias])
  assert.deepEqual(a.arquivos(a.atual), antes)
  assert.equal(a.valor('pasta_principal'), alias)
  assert.equal(a.esperas.length, 1, 'a segunda sonda apareceu na segunda consulta dela')
})

test('C-1: junction com ino 0 e sonda nunca vista: recusa e nenhum arquivo some', async (t) => {
  const a = preparar(t)
  a.nota('1')
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  consultaDaSonda(t, naoVista)
  statAlterado(t, () => ({ ino: 0n }))
  await assert.rejects(a.pastas.mudarPrincipal(alias), /não dá para garantir que são pastas diferentes.*Nada mudou: continua em/s)
  assert.deepEqual(a.arquivos(a.atual), antes)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.equal(a.valor('pasta_principal'), undefined)
})

test('C-1: ino 0 em um lado só também recusa, com pastas realmente diferentes', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  jaCopiado(a, rel)
  statAlterado(t, (s, caminho) => (caminho.startsWith(a.nova) ? { ino: 0n } : {}))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /não dá para garantir/)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.ok(fs.existsSync(path.join(a.nova, rel)), 'o que já estava no destino fica')
})

test('C-1: mesmo ino e dev diferente: recusa', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  fs.writeFileSync(path.join(a.nova, MARCA), '')
  fs.mkdirSync(path.dirname(path.join(a.nova, rel)), { recursive: true })
  fs.linkSync(path.join(a.atual, rel), path.join(a.nova, rel))
  statAlterado(t, (s, caminho) => (caminho.startsWith(a.nova) ? { dev: s.dev + 1n } : {}))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /mesmo arquivo.*Nada mudou/s)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
})

test('C-1: troca retomada em pasta realmente diferente: espera, conclui e apaga da origem', async (t) => {
  const a = preparar(t)
  const rels = [a.nota('1'), a.nota('2')]
  for (const rel of rels) jaCopiado(a, rel)
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual([r.movidos, r.mudou, r.raiz], [2, true, a.nova])
  for (const rel of rels) {
    assert.ok(!fs.existsSync(path.join(a.atual, rel)), 'saiu da origem')
    assert.ok(fs.existsSync(path.join(a.nova, rel)))
  }
  assert.deepEqual(a.esperas, Array(15).fill(1000), '15 s, de 1 em 1 s')
  assert.deepEqual(sondasEm(a, a.nova), [])
})

test('C-1: intervalo e limite da segunda sonda são injetáveis', async (t) => {
  const a = preparar(t, { opcoes: { esperaDaSonda: { intervaloMs: 10, limiteMs: 30 } } })
  jaCopiado(a, a.nota('1'))
  await a.pastas.mudarPrincipal(a.nova)
  assert.deepEqual(a.esperas, [10, 10, 10])
})

test('C-1: sem nenhum arquivo já existente não há segunda sonda nem espera', async (t) => {
  const a = preparar(t)
  a.nota('1')
  let consultas = 0
  consultaDaSonda(t, () => {
    consultas++
  })
  await a.pastas.mudarPrincipal(a.nova)
  assert.equal(consultas, 1)
  assert.deepEqual(a.esperas, [])
})

test('C-1: segunda sonda com erro diferente de ENOENT recusa com "Nada mudou" e é apagada', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  const criado = a.nota('2')
  jaCopiado(a, rel)
  consultaDaSonda(t, (n) => (n === 1 ? naoVista() : erroCom('EIO')))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EIO.*Nada mudou: continua em/s)
  assert.equal(a.config.pastaXmls, a.atual)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.ok(fs.existsSync(path.join(a.atual, criado)))
  assert.ok(!fs.existsSync(path.join(a.nova, criado)), 'sai do destino o que esta tentativa criou')
  assert.ok(fs.existsSync(path.join(a.nova, rel)), 'o que já estava fica')
  assert.deepEqual(sondasEm(a, a.nova), [])
})

test('C-1: falha ao gravar a segunda sonda recusa com "Nada mudou"', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  jaCopiado(a, rel)
  const original = fsp.writeFile
  let gravacoes = 0
  t.mock.method(fsp, 'writeFile', async (arquivo, ...resto) => {
    if (String(arquivo).includes(SONDA) && ++gravacoes === 2) throw erroCom('EACCES')
    return original(arquivo, ...resto)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EACCES.*Nada mudou/s)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
})

test('C-1: fechar o app durante a espera interrompe sem mudar nada', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  jaCopiado(a, rel)
  const pastas = a.novoServico({
    dormir: async () => {
      pastas.pararTroca()
    },
  })
  const r = await pastas.mudarPrincipal(a.nova)
  assert.equal(r.interrompida, true)
  assert.equal(r.mudou, false)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
  assert.deepEqual(sondasEm(a, a.nova), [])
})

// ---------- I-1: resultado da última troca ----------

test('I-1: antes de qualquer troca, ultimaTroca é null', (t) => {
  assert.equal(preparar(t).pastas.estado().ultimaTroca, null)
})

test('I-1: falha na troca fica em ultimaTroca, com o erro de verdade', async (t) => {
  const a = preparar(t)
  a.nota('1')
  t.mock.method(fsp, 'copyFile', async () => {
    throw erroCom('ENOSPC')
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /ENOSPC/)
  const u = a.pastas.estado().ultimaTroca
  assert.equal(u.tipo, 'xmls')
  assert.equal(u.ok, false)
  assert.match(u.mensagem, /ENOSPC.*Nada mudou/s)
  assert.deepEqual(u.avisos, [])
})

test('I-1: sucesso com avisos fica em ultimaTroca', async (t) => {
  const a = preparar(t)
  const presa = a.nota('1')
  const original = fsp.rm
  t.mock.method(fsp, 'rm', async (arquivo, ...resto) => {
    if (String(arquivo) === path.join(a.atual, presa)) throw erroCom('EBUSY')
    return original(arquivo, ...resto)
  })
  await a.pastas.mudarPrincipal(a.nova)
  const u = a.pastas.estado().ultimaTroca
  assert.equal(u.ok, true)
  assert.equal(u.tipo, 'xmls')
  assert.ok(u.mensagem.includes(a.nova))
  assert.deepEqual(u.avisos, ['1 arquivo não saiu da pasta antiga. Pode apagá-lo depois.'])
})

test('I-1: a troca seguinte substitui a anterior e estado() devolve cópia', async (t) => {
  const a = preparar(t)
  await assert.rejects(a.pastas.mudarPrincipal(path.join(a.atual, 'dentro')))
  assert.equal(a.pastas.estado().ultimaTroca.ok, false)
  await a.pastas.mudarPrincipal(a.nova)
  assert.equal(a.pastas.estado().ultimaTroca.ok, true)
  a.pastas.estado().ultimaTroca.avisos.push('x')
  assert.deepEqual(a.pastas.estado().ultimaTroca.avisos, [])
})

test('I-1: troca interrompida fica como não concluída', async (t) => {
  const a = preparar(t)
  a.nota('1')
  a.nota('2')
  const portao = seguraCopia(t)
  const troca = a.pastas.mudarPrincipal(a.nova)
  await portao.entrou
  a.pastas.pararTroca()
  portao.soltar()
  await troca
  const u = a.pastas.estado().ultimaTroca
  assert.equal(u.ok, false)
  assert.match(u.mensagem, /interrompida.*Nada mudou/s)
})

// ---------- I11: data do arquivo ----------

test('I11: EPERM em utimes não repete nem derruba a cópia: a troca termina sem esperas, com um log só', async (t) => {
  const a = preparar(t)
  const rels = [a.nota('1'), a.nota('2')]
  const utimes = t.mock.method(fsp, 'utimes', async () => {
    throw erroCom('EPERM')
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.movidos, 2)
  assert.deepEqual(a.esperas, [])
  assert.equal(utimes.mock.callCount(), 2, 'cada arquivo tenta uma vez')
  assert.equal(a.logs.filter(([m]) => /Data do arquivo/.test(m)).length, 1)
  for (const rel of rels) assert.ok(fs.existsSync(path.join(a.nova, rel)))
})

// ---------- rodada 3: dar o nome final sem sobrescrever ----------

test('rodada 3: junction, sonda não vista, link com EPERM e existsSync falso: recusa e nenhum arquivo some', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  const conteudo = fs.readFileSync(path.join(a.atual, rel))
  consultaDaSonda(t, naoVista)
  t.mock.method(fsp, 'link', async () => {
    throw erroCom('EPERM')
  })
  const existe = fs.existsSync
  t.mock.method(fs, 'existsSync', (p) => (String(p) === path.join(alias, rel) ? false : existe(p)))
  await assert.rejects(a.pastas.mudarPrincipal(alias), /Nada mudou: continua em/)
  assert.deepEqual(a.arquivos(a.atual), antes)
  assert.deepEqual(fs.readFileSync(path.join(a.atual, rel)), conteudo)
  assert.equal(a.config.pastaXmls, a.atual)
})

test('rodada 3: a recusa não apaga o "criado" que é o próprio original', async (t) => {
  const a = preparar(t)
  a.nota('1')
  a.nota('2')
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  consultaDaSonda(t, naoVista)
  // Cache da rede: o primeiro nome parece criado, embora o alvo seja o próprio original.
  const link = fsp.link
  let n = 0
  t.mock.method(fsp, 'link', async (...args) => {
    if (++n > 1) return link(...args)
  })
  await assert.rejects(a.pastas.mudarPrincipal(alias), /Nada mudou: continua em/)
  assert.deepEqual(a.arquivos(a.atual), antes)
  assert.ok(a.logs.some(([m]) => /não apagado/.test(m)), 'registra no log')
})

test('rodada 3: origem ilegível ao desfazer: o criado não é apagado e vai para o log', async (t) => {
  const a = preparar(t)
  const um = a.nota('1')
  const dois = a.nota('2')
  const copia = fsp.copyFile
  t.mock.method(fsp, 'copyFile', async (de, ...resto) => {
    if (String(de).includes(path.basename(dois))) throw erroCom('ENOSPC')
    return copia(de, ...resto)
  })
  const stat = fsp.stat
  t.mock.method(fsp, 'stat', async (caminho, opcoes) => {
    if (opcoes?.bigint && String(caminho) === path.join(a.atual, um)) throw erroCom('EIO')
    return stat(caminho, opcoes)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /Nada mudou/)
  assert.ok(fs.existsSync(path.join(a.atual, um)))
  assert.ok(fs.existsSync(path.join(a.nova, um)), 'na dúvida, fica')
  assert.ok(a.logs.some(([m, d]) => /não apagado/.test(m) && d.exemplos.includes(um)))
})

test('origem fora do ar ao desfazer: uma linha só no log, com o total e alguns exemplos', async (t) => {
  const a = preparar(t)
  const notas = Array.from({ length: 8 }, (_, i) => a.nota(String(i + 1)))
  const ultima = notas.at(-1)
  const copia = fsp.copyFile
  t.mock.method(fsp, 'copyFile', async (de, ...resto) => {
    if (String(de).includes(path.basename(ultima))) throw erroCom('ENOSPC')
    return copia(de, ...resto)
  })
  const stat = fsp.stat
  t.mock.method(fsp, 'stat', async (caminho, opcoes) => {
    if (opcoes?.bigint && String(caminho).startsWith(a.atual)) throw erroCom('ENOENT')
    return stat(caminho, opcoes)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /Nada mudou/)
  const linhas = a.logs.filter(([m]) => /não apagado/.test(m))
  assert.equal(linhas.length, 1)
  const [, d] = linhas[0]
  assert.equal(d.arquivos, 7)
  assert.equal(d.exemplos.length, 5)
  assert.equal(d.erro, 'ENOENT')
  assert.equal(d.pasta, a.nova)
})

test('rodada 3: ao desfazer, o que esta tentativa criou de verdade sai do destino', async (t) => {
  const a = preparar(t)
  const um = a.nota('1')
  const dois = a.nota('2')
  const copia = fsp.copyFile
  t.mock.method(fsp, 'copyFile', async (de, ...resto) => {
    if (String(de).includes(path.basename(dois))) throw erroCom('ENOSPC')
    return copia(de, ...resto)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /Nada mudou/)
  assert.ok(fs.existsSync(path.join(a.atual, um)))
  assert.ok(!fs.existsSync(path.join(a.nova, um)))
})

test('rodada 3: disco sem link físico em pastas diferentes: a troca conclui e não sobrescreve arquivo diferente', async (t) => {
  const a = preparar(t)
  const leva = a.nota('1', '<um/>')
  const igual = a.nota('2', '<dois/>')
  const diferente = a.nota('3', '<da-origem/>')
  jaCopiado(a, igual)
  fs.mkdirSync(path.dirname(path.join(a.nova, diferente)), { recursive: true })
  fs.writeFileSync(path.join(a.nova, diferente), '<do-destino/>')
  t.mock.method(fsp, 'link', async () => {
    throw erroCom('EPERM')
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.mudou, true)
  assert.equal(r.movidos, 2)
  assert.equal(a.config.pastaXmls, a.nova)
  assert.equal(fs.readFileSync(path.join(a.nova, leva), 'utf8'), '<um/>')
  assert.ok(!fs.existsSync(path.join(a.atual, leva)))
  assert.ok(!fs.existsSync(path.join(a.atual, igual)))
  assert.equal(fs.readFileSync(path.join(a.nova, diferente), 'utf8'), '<do-destino/>')
  assert.equal(fs.readFileSync(path.join(a.atual, diferente), 'utf8'), '<da-origem/>')
  assert.deepEqual(a.arquivos(a.nova).filter((n) => n.endsWith('.tmp')), [])
})

const semLink = (t) =>
  t.mock.method(fsp, 'link', async () => {
    throw erroCom('EPERM')
  })

test('rodada 4: sem link e reserva com erro: a cópia falha e nada é apagado', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  semLink(t)
  const abrir = fsp.open
  t.mock.method(fsp, 'open', async (caminho, ...resto) => {
    if (String(caminho).endsWith('.xml')) throw erroCom('ENOSPC')
    return abrir(caminho, ...resto)
  })
  const copia = fsp.copyFile
  t.mock.method(fsp, 'copyFile', async (de, para, modo) => {
    if (String(de).endsWith('.tmp')) throw erroCom('ENOSPC')
    return copia(de, para, modo)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /ENOSPC.*Nada mudou/s)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
})

test('rodada 4: sem link, a escrita direta com o nome final cortaria o arquivo: nunca fica truncado', async (t) => {
  const a = preparar(t)
  const bom = `<nota>${'x'.repeat(5000)}</nota>`
  const rel = a.nota('1', bom)
  semLink(t)
  const copia = fsp.copyFile
  let cortou = false
  t.mock.method(fsp, 'copyFile', async (de, para, modo) => {
    if (!String(de).endsWith('.tmp') || cortou) return copia(de, para, modo)
    cortou = true
    fs.writeFileSync(para, bom.slice(0, 100), { flag: 'wx' })
    throw erroCom('EIO')
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.mudou, true)
  assert.equal(fs.readFileSync(path.join(a.nova, rel), 'utf8'), bom)
})

test('rodada 4: sem link e nome final que não sai: sem reserva vazia, "Nada mudou" e a origem fica', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1', '<um/>')
  semLink(t)
  const copia = fsp.copyFile
  t.mock.method(fsp, 'copyFile', async (de, para, modo) => {
    if (String(de).endsWith('.tmp')) throw erroCom('ENOSPC')
    return copia(de, para, modo)
  })
  const renomear = fsp.rename
  t.mock.method(fsp, 'rename', async (de, para) => {
    if (String(de).endsWith('.tmp')) throw erroCom('ENOSPC')
    return renomear(de, para)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /ENOSPC.*Nada mudou/s)
  assert.ok(!fs.existsSync(path.join(a.nova, rel)))
  assert.equal(fs.readFileSync(path.join(a.atual, rel), 'utf8'), '<um/>')
  assert.equal(a.config.pastaXmls, a.atual)
})

test('rodada 4: nome final que não sai na primeira é repetido e a troca conclui com o arquivo inteiro', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1', '<um/>')
  semLink(t)
  const renomear = fsp.rename
  let falhou = false
  t.mock.method(fsp, 'rename', async (de, para) => {
    if (String(de).endsWith('.tmp') && !falhou) {
      falhou = true
      throw erroCom('EIO')
    }
    return renomear(de, para)
  })
  const r = await a.pastas.mudarPrincipal(a.nova)
  assert.equal(r.mudou, true)
  assert.equal(fs.readFileSync(path.join(a.nova, rel), 'utf8'), '<um/>')
  assert.ok(falhou)
  assert.ok(a.esperas.length > 0, 'esperou e repetiu')
})

for (const [nome, preparo] of [
  ['sem link físico', semLink],
  ['com link físico', () => {}],
]) {
  test(`rodada 4: reserva abandonada de 0 byte, ${nome}: é substituída e a troca conclui sem "conteúdo diferente"`, async (t) => {
    const a = preparar(t)
    const rel = a.nota('1', '<um/>')
    fs.mkdirSync(path.dirname(path.join(a.nova, rel)), { recursive: true })
    fs.writeFileSync(path.join(a.nova, rel), '')
    fs.writeFileSync(path.join(a.nova, MARCA), '')
    preparo(t)
    const r = await a.pastas.mudarPrincipal(a.nova)
    assert.equal(r.mudou, true)
    assert.equal(fs.readFileSync(path.join(a.nova, rel), 'utf8'), '<um/>')
    assert.ok(!fs.existsSync(path.join(a.atual, rel)))
    assert.ok(!a.logs.some(([m]) => /diferente/.test(m)))
  })
}

test('rodada 4: junction com link falhando continua não apagando nada, nem por reserva', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1', '<um/>')
  const alias = a.link(a.atual)
  const antes = a.arquivos(a.atual)
  consultaDaSonda(t, naoVista)
  semLink(t)
  await assert.rejects(a.pastas.mudarPrincipal(alias), /Nada mudou: continua em/)
  assert.deepEqual(a.arquivos(a.atual), antes)
  assert.equal(fs.readFileSync(path.join(a.atual, rel), 'utf8'), '<um/>')
})

test('rodada 3: segunda sonda não depende de existsSync: erro na consulta recusa com "Nada mudou"', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  jaCopiado(a, rel)
  consultaDaSonda(t, (n) => (n === 1 ? naoVista() : erroCom('EIO')))
  const existe = fs.existsSync
  t.mock.method(fs, 'existsSync', (p) => (String(p) === a.atual ? false : existe(p)))
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EIO.*Nada mudou: continua em/s)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
})

test('rodada 3: pasta atual ilegível na segunda sonda recusa com "Nada mudou"', async (t) => {
  const a = preparar(t)
  const rel = a.nota('1')
  jaCopiado(a, rel)
  const stat = fsp.stat
  t.mock.method(fsp, 'stat', async (caminho, ...resto) => {
    if (String(caminho) === a.atual) throw erroCom('EIO')
    return stat(caminho, ...resto)
  })
  await assert.rejects(a.pastas.mudarPrincipal(a.nova), /EIO.*Nada mudou: continua em/s)
  assert.ok(fs.existsSync(path.join(a.atual, rel)))
  assert.equal(a.config.pastaXmls, a.atual)
})
