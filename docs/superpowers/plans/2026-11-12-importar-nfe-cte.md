# Importar com NF-e e CT-e: plano de implementação

> **Para quem for executar:** use subagent-driven-development (recomendado) ou executing-plans, tarefa por tarefa. Os passos usam caixas (`- [ ]`) para marcar o andamento.

**Objetivo:** o Importar XMLs passa a aceitar NF-e, NFS-e e CT-e, mais os eventos dos três, e organiza tudo como a captura organizaria. Nota sem cliente vai para "Sem cliente cadastrado" e segue sozinha para o cliente quando ele for cadastrado.

**Arquitetura:** um leitor por tipo em `importacaoTipos.js` reaproveita as extrações que já existem. `importacao.js` escolhe o leitor pela raiz do XML e grava. `notasSemCliente.js` varre a pasta das notas sem cliente e reimporta pelo mesmo serviço.

**Stack:** Node (CommonJS), better-sqlite3, fast-xml-parser, fflate, node:test e React 19 no painel.

**Spec:** `docs/superpowers/specs/2026-11-12-importar-nfe-cte-design.md`

## Restrições gerais

- Só NF-e (`nfeProc`, mod 55), CT-e (`cteProc`, mod 57) e NFS-e (`NFSe`), mais `procEventoNFe`, `procEventoCTe` e o `evento` da NFS-e. O resto vira `nao-suportado`.
- Chave da NF-e e do CT-e com 44 dígitos e da NFS-e com 50. Fora disso, o motivo é `invalido`.
- Linha nova com `nsu NULL` e `origem='importada'`. A NF-e que completa um resumo mantém o `origem` que já tinha.
- Carteira = `papel = 'cliente' OR tambem_cliente = 1`.
- Cancelamentos: NF-e e CT-e `110111`; NFS-e `101101` e `105102`.
- Limites atuais: 5 MB por arquivo, 300 MB por ZIP e 64 MB por envio.
- Textos da tela, exatamente: subtítulo "NF-e, NFS-e e CT-e obtidas fora do Smart Fiscal"; área de soltar "Solte aqui XMLs de NF-e, NFS-e ou CT-e, ou um ZIP com eles."; `nao-suportado` "tipo não suportado (só NF-e, NFS-e e CT-e)"; `sem-protocolo` "nota sem autorização da SEFAZ"; `homologacao` "nota de homologação (teste)"; `arquivo-grande` "grande demais para ser uma nota".
- Não rodar `npx prettier`. Os testes não podem depender da data do dia. Rodar: `node --test --test-timeout=60000`, com a saída mandada para um arquivo.

## Foco da revisão

1. **NF-e importada que já está no cliente como resumo:** a linha deve virar `completa` e o arquivo de resumo deve sair. Coberto na Tarefa 2.
2. **XML com BOM, declaração `<?xml?>` ou prefixo `nfe:` na raiz:** o tipo tem de ser reconhecido. Coberto na Tarefa 1.
3. **O mesmo arquivo importado duas vezes quando foi para "Sem cliente cadastrado":** não pode duplicar nem dar erro. Coberto na Tarefa 2.
4. **Arquivo da pasta sem cliente ilegível ou de tipo estranho na varredura:** fica onde está, a varredura segue e não há exceção. Coberto na Tarefa 3.
5. **Evento de NF-e de um cliente que ainda não tem a nota:** fica com o cliente pelo CNPJ da chave e na direção calculada pela chave. Coberto na Tarefa 2.

---

### Tarefa 1: leitores por tipo

**Arquivos:**
- Criar: `src/services/importacaoTipos.js`
- Criar: `test/apoio/nfe.js`, um gerador de `nfeProc` e `procEventoNFe` para os testes
- Teste: `test/importacao-tipos.test.js`

**Interfaces:**
- Produz `lerDocumento(texto: string) → { tipo: 'nota', modelo: 'nfe'|'cte'|'nfse', d } | { tipo: 'evento', modelo, e } | { motivo }`.
  - Para nota, `d` tem estes campos: `{ chave, competencia, emitente_cnpj, emitente_nome, emitente_ie, destinatario_cnpj, destinatario_nome, numero, serie, data_emissao, valor_total, tipo_nf, partes }`. `partes` é o que `donos` precisa (CT-e: o objeto de `dadosCte`; NFS-e: o objeto de `dadosNfse`).
  - Para evento, `e` tem `{ chave, tp_evento, n_seq, descricao, data_evento, protocolo }`.
- Produz `donos(modelo, d, porCnpj: Map<cnpj, cliente>) → Array<[cliente, 'entrada'|'saida'|'outro']>`.
- Produz `nomeArquivo(modelo, chave)`, que repassa para `nomes.nfe`, `nomes.cte` ou `nomes.nfse`.
- Produz `CANCELAMENTOS = { nfe: ['110111'], cte: ['110111'], nfse: ['101101', '105102'] }`.
- Produz `test/apoio/nfe.js`: `chaveNfe(cnpjEmit, n)`, `nfeProc({ chave, emit, dest, nNF, dhEmi = '2026-10-08T10:00:00-03:00', tpAmb = '1', cStat = '100', mod = '55', vNF = '100.00' })` e `procEventoNfe({ chave, emit, tpEvento = '110111' })`. Modelo: `xmlNfeProc` e `xmlCancelamento` de `src/sefaz/mock-client.js`. Para a chave, `gerarChave`, que já é exportado.

- [ ] **Passo 1: escrever os testes que falham**, em `test/importacao-tipos.test.js`:
  - `nfeProc` com `mod 55` e `cStat 100` dá `{ tipo: 'nota', modelo: 'nfe' }`, com a chave e `competencia === '2026-10'`.
  - `cteProc` (de `test/apoio/cte.js`) dá `modelo 'cte'`. `xmlNfse` dá `modelo 'nfse'`.
  - `procEventoNfe`, `procEventoCte` e `xmlEventoNfse` dão `{ tipo: 'evento' }`, cada um com o seu modelo e `tp_evento`.
  - `nfeProc` com `mod: '65'` e `cteProc` com `<mod>67</mod>` dão `motivo 'nao-suportado'`. Também dão `nao-suportado`: `<NFe>` sem `nfeProc`, `<resNFe>` e `<qualquer/>`.
  - `cStat: '110'` dá `sem-protocolo`. Um `nfeProc` sem `<protNFe>` também dá. `cStat 150` passa.
  - `tpAmb: '2'` dá `homologacao`, tanto na NF-e quanto no CT-e.
  - Chave de 43 dígitos dá `invalido`. Texto que não é XML também dá `invalido`.
  - BOM, declaração `<?xml?>` e raiz `<nfe:nfeProc xmlns:nfe=...>` são reconhecidos.
  - `donos('nfe')`: só o emitente cadastrado dá `[[emit,'saida']]`; só o destinatário dá `[[dest,'entrada']]`; os dois dão os dois.
  - `donos('cte')`: o tomador dá `entrada` e o remetente dá `outro`. Com dois clientes no CT-e, cada um ganha o seu papel.
  - `donos('nfse')`: o mesmo resultado do `donos` de hoje, com o intermediário em último caso.

- [ ] **Passo 2: rodar e conferir que falha.** `node --test test/importacao-tipos.test.js` dá FAIL porque o módulo não existe.

- [ ] **Passo 3: implementar `importacaoTipos.js`.**
  - Lê com `decodificarXml` e tira o BOM, valida com `XMLValidator` e acha a raiz com `XMLParser({ removeNSPrefix: true, ignoreAttributes: true })`.
  - NF-e: `dadosNfeProc(xmlParaJson(texto))`. O `mod`, o `tpAmb` e o `cStat` vêm de `nfeProc.NFe.infNFe.ide` e de `protNFe.infProt`.
  - CT-e: `dadosCte(texto)`. O `cStat` vem de `protocolo.cStat` e o `tpAmb` de `ambiente`.
  - NFS-e: `dadosNfse`, mapeado para os campos de `d`. O `donos` atual sai de `importacao.js` e vem para cá.
  - Eventos: `dadosEvento` (NF-e), `dadosEventoCte`, com `tpEvento`, `nSeq` e `dataEvento` renomeados para os nomes de `e`, e `dadosEventoNfse`.
  - A ordem das checagens é esta: XML válido, raiz conhecida, modelo, chave, ambiente, protocolo.

- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/importacao-tipos.test.js` dá PASS.

- [ ] **Passo 5: commit.** `git add src/services/importacaoTipos.js test/apoio/nfe.js test/importacao-tipos.test.js && git commit -m "Importar: leitores de NF-e, CT-e e NFS-e"`

### Tarefa 2: o importador grava os três tipos, os eventos e as notas sem cliente

**Arquivos:**
- Modificar: `src/services/importacao.js` (o `ler`, o `donos` e o `importar` inteiros)
- Teste: `test/importacao.test.js`. Os testes atuais passam para o formato novo do resultado, e entram os novos.

**Interfaces:**
- Consome tudo o que a Tarefa 1 produz.
- Produz `importar(arquivos, { soDaCarteira = false } = {}) → { importadas: { nfe: {entrada, saida}, cte: {entrada, saida, outro}, nfse: {entrada, saida} }, eventos, semCliente, jaExistiam, ignoradas, clientesAfetados }`. Com `soDaCarteira: true`, uma nota sem dono não é gravada em "Sem cliente cadastrado" e conta como `cnpj-nao-cadastrado`. A Tarefa 3 usa essa opção.

- [ ] **Passo 1: escrever os testes que falham.**
  - **NF-e:** a saída de um cliente vai para `Cliente 1/2026/10-Outubro/NF-e/Saidas/XML/<chave>-nfe.xml` com `modelo 'nfe'`, `origem 'importada'` e `nsu null`. NF-e entre dois clientes grava os dois.
  - **NF-e que era resumo:** inserir antes a linha `status 'resumo'` e o arquivo de resumo em `caminhoDa({ categoria: 'resumo' })`. Depois de importar, a linha vira `completa`, o `origem` continua `'captura'`, o arquivo de resumo sumiu e o resultado conta `importadas.nfe.entrada === 1`.
  - **CT-e:** com o tomador cadastrado, o CT-e vai para `CT-e/Entradas` e o resultado tem `importadas.cte.entrada === 1`. Com o remetente cadastrado, vai para `CT-e/Outros` e conta em `outro`.
  - **Eventos:** cancelamento de NF-e importado depois da nota deixa `cancelada = 1` e o XML vai para `NF-e/Eventos e Resumos/`. Importado antes da nota, a nota entra já com `cancelada = 1`. Cancelamento de CT-e funciona igual. Evento de NF-e sem a nota no app, mas com o emitente da chave cadastrado, é gravado com `direcaoPelaChave`. Evento de NFS-e sem a nota vai para os ignorados como `cnpj-nao-cadastrado`. O mesmo evento duas vezes conta em `jaExistiam`.
  - **Sem cliente:** com escritório cadastrado (`papel 'escritorio'`, apelido `Escritorio`), uma NF-e sem dono vai para `Escritorio/Sem cliente cadastrado/2026/10-Outubro/NF-e/Entradas/XML/<chave>-nfe.xml`, `semCliente === 1` e nenhuma linha no banco. O mesmo para CT-e e NFS-e. Importar de novo não dá erro e conta `semCliente` outra vez sem duplicar o arquivo. Sem escritório, a nota vai para os ignorados como `cnpj-nao-cadastrado`. Com `soDaCarteira: true`, também.
  - **ZIP misto** com uma NF-e, um CT-e, uma NFS-e e um `resNFe`: as três notas são importadas e o `resNFe` vai para os ignorados como `nao-suportado`.
  - Os testes atuais de NFS-e passam a usar `r.importadas.nfse`. O teste de `nao-nfse` vira `nao-suportado`.

- [ ] **Passo 2: rodar e conferir que falha.** `node --test test/importacao.test.js` dá FAIL.

- [ ] **Passo 3: implementar.**
  - **Mantém:** `expandir` e as transações aninhadas por nota.
  - **Prepared statements:**
    - `nota(cliente_id, chave)`.
    - `inserir`, com o `modelo` como parâmetro.
    - `completar` (UPDATE dos campos, de `status='completa'` e de `caminho_xml`, sem mexer em `origem`).
    - `escritorio`: `papel='escritorio'`.
    - `evento(chave, tp, seq)` e `inserirEvento`.
    - `marcarCancelada`.
    - `primeiroDono`: `SELECT cliente_id FROM notas WHERE chave = ? ORDER BY id LIMIT 1`.
  - **Já existia:** a linha existe com `status = 'completa'`. Se a linha existe com outro status, a nota completa o resumo e chama `armazenamento.tirarResumo(caminho)`, com falha só registrada no log.
  - **Sem dono:** se há escritório e `!soDaCarteira`, chama `armazenamento.salvar({ cliente: escritorio, foraDaCarteira: true, modelo, direcao: 'entrada', competencia, nomeArquivo, xml })`.
  - **Evento:**
    - O dono é o `primeiroDono`. Sem ele, para NF-e e CT-e, o cliente da carteira com o CNPJ `chave.slice(6, 20)`. Para NFS-e, nenhum.
    - Salva com `categoria: 'evento'`, `modelo`, `direcao: nota?.tipo || direcaoPelaChave(chave, dono.cnpj)` e `competencia: nota?.competencia || competenciaDe(data_evento)`.
    - Cancelamento → `marcarCancelada`.
  - **`cancelada` da nota nova:** consulta o evento de cancelamento do modelo antes de inserir.

- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/importacao.test.js test/importacao-tipos.test.js` dá PASS.

- [ ] **Passo 5: commit.** `git commit -am "Importar grava NF-e, CT-e, eventos e notas sem cliente"`, incluindo os testes.

### Tarefa 3: levar as notas sem cliente ao cadastrar

**Arquivos:**
- Criar: `src/services/notasSemCliente.js`
- Modificar: `src/contexto.js`, para expor `ctx.notasSemCliente`
- Modificar: `src/web/server.js`, na rota `POST /api/clientes` (por volta da linha 792)
- Modificar: `src/servidor.js`, logo depois de `corrigirNotasDoEscritorio` (por volta da linha 51)
- Teste: `test/notas-sem-cliente.test.js` e `test/web.test.js`

**Interfaces:**
- Consome `importacao.importar(arquivos, { soDaCarteira: true })`.
- Produz `criarNotasSemCliente({ db, config, logger, importacao }) → { levar(): Promise<{ levadas, ficaram, falhas }> }`.
- Decisão: o `resgatarDeForaDaCarteira` da captura continua como está (uso único e só NF-e). A varredura nova roda sempre e cobre os três tipos, e as duas não se atrapalham porque a importação conta duplicadas. É um desvio pequeno da spec, que falava em substituir.

- [ ] **Passo 1: escrever os testes que falham**, em `test/notas-sem-cliente.test.js`:
  - Importar uma NF-e, um CT-e e uma NFS-e de um CNPJ que não está cadastrado: os arquivos vão para "Sem cliente cadastrado".
  - Cadastrar esse CNPJ e rodar `levar()`: o resultado é `{ levadas: 3, ficaram: 0, falhas: 0 }`, há três linhas no banco do cliente, os arquivos sumiram da pasta sem cliente e as pastas vazias também.
  - Arquivo cujo CNPJ continua sem cadastro: `ficaram: 1` e o arquivo continua no lugar.
  - Arquivo ilegível (`lixo-nfe.xml` com `abc`): `ficaram: 1`, sem exceção e o arquivo continua no lugar.
  - Sem escritório ou sem a pasta: `{ levadas: 0, ficaram: 0, falhas: 0 }`.
  - Em `test/web.test.js`: `POST /api/clientes` com `semCertificado: true` de um CNPJ que tem nota na pasta sem cliente; depois de esperar a varredura (`await` da promessa exposta em `ctx`, ou repetir a checagem até a linha aparecer), a nota está no banco.

- [ ] **Passo 2: rodar e conferir que falha.**

- [ ] **Passo 3: implementar.**
  - A lista de pastas é a mesma lógica de `pastasForaDaCarteira`, em `captura.js:348`: nome atual e nomes antigos do escritório + `PASTAS.foraDaCarteira`.
  - A varredura pega cada `*-(nfe|cte|nfse).xml`, chama `importar([{ nome, bytes }], { soDaCarteira: true })` e cede a vez (`setImmediate`) a cada arquivo.
  - Remove o arquivo quando a importação deu `importadas > 0` ou `jaExistiam > 0` e nenhum ignorado. Depois remove as pastas vazias até a raiz "Sem cliente cadastrado", sem incluí-la.
  - Se `clientesAfetados` não estiver vazio, chama `ctx.organizador.agendar({ conferirArquivos: true })`. Quem faz isso é quem chamou, na rota e no `servidor.js`.
  - Na rota, a chamada vai depois do `res.status(201)` e sem `await` na resposta, com `.catch` que registra no log. No `servidor.js`, a chamada leva `await` antes do painel.

- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/notas-sem-cliente.test.js test/web.test.js` dá PASS.

- [ ] **Passo 5: commit.** `git commit -m "Notas sem cliente vão ao cliente quando ele é cadastrado"`

### Tarefa 4: tela e rota

**Arquivos:**
- Modificar: `painel/src/telas/Importar.jsx`
- Modificar: `src/web/server.js:616-627`, só o comentário (o formato novo passa direto)
- Teste: `test/web.test.js`, no bloco do importar (por volta da linha 2228)

**Interfaces:** consome o resultado da Tarefa 2.

- [ ] **Passo 1: ajustar o teste da rota** `importar grava a NFS-e e devolve o resumo` para `r.importadas.nfse.entrada === 1`. Acrescentar um teste que envia uma NF-e e confere `importadas.nfe`.
- [ ] **Passo 2: implementar a tela.**
  - Uma linha por tipo que teve nota, na ordem NF-e, CT-e, NFS-e. Por exemplo: "NF-e: 120 entradas, 30 saídas" e "CT-e: 15 entradas, 2 em Outros". Cada parte só aparece se for maior que zero, e o `plural` de `formato.js` cuida do singular.
  - Depois, quando houver: "N eventos", "N sem cliente cadastrado (vão para o cliente quando ele for cadastrado)" e "N já estavam no Smart Fiscal".
  - Textos e motivos novos exatamente como nas Restrições gerais. `nao-nfse` sai do `MOTIVOS`.
  - Se nada foi importado e não houve sem cliente nem eventos, mostra "Nenhuma nota nova."
- [ ] **Passo 3: rodar o build e todos os testes.** `npx vite build painel` e depois `node --test --test-timeout=60000 > %TEMP%\testes.txt`. O resumo tem de mostrar 0 falhas.
- [ ] **Passo 4: conferir no navegador** com dados fictícios (porta 3032, `SEFAZ_MOCK=1`): soltar um ZIP com NF-e, CT-e, NFS-e e um `resNFe` e tirar um print do resultado.
- [ ] **Passo 5: commit.** `git commit -m "Tela Importar mostra NF-e, CT-e e NFS-e"`
