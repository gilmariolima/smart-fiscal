# Importar XMLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tela "Importar XMLs" que recebe XML/ZIP de NFS-e por arrastar e soltar e grava como nota capturada.

**Architecture:** Serviço `importacao.js` reaproveita `dadosNfse`, `criarArmazenamento().salvar` e o mesmo INSERT da captura de NFS-e; a rota `POST /api/importar` (só PC local) chama o serviço e depois `ctx.organizador.agendar({ conferirArquivos: true })`. Tela React nova acima de Exportar.

**Tech Stack:** Node (express 5, better-sqlite3, node:test), fflate (unzip), React 19 + Vite.

**Spec:** `docs/superpowers/specs/2026-11-08-importar-xmls-design.md`

## Global Constraints

- Só NFS-e; qualquer outro arquivo é ignorado com motivo.
- Única dependência nova: `fflate`. Instalar com `npm install fflate --ignore-scripts`.
- Rodar testes com `node --test --test-timeout=60000`; nunca `npx prettier`.
- Textos da tela em português, sem animação, visual enxuto.
- Não toca em NSU, não consulta SEFAZ/ADN.
- Motivos de ignorado (valores exatos): `'nao-xml'`, `'invalido'`, `'nao-nfse'`, `'cnpj-nao-cadastrado'`, `'zip-invalido'`.

## Review Focus

- XML com BOM ou em ISO-8859-1 → deve ser lido igual (usar `decodificarXml` de `extracaoNfse`). Teste na Tarefa 1.
- Mesmo XML duas vezes no mesmo lote → 1 importada + 1 "já existia". Teste na Tarefa 1.
- Nome de arquivo com maiúscula (`NOTA.XML`, `Lote.ZIP`) → reconhecido. Teste na Tarefa 1.
- ZIP com pastas dentro e arquivos não-XML → só os XML entram, o resto vira `nao-xml`. Teste na Tarefa 1.
- Corpo acima do limite → 413 com mensagem, não derruba o servidor. Teste na Tarefa 2.

---

### Task 1: Coluna `origem` + serviço de importação

**Files:**
- Modify: `src/db/index.js` (lista `COLUNAS_NOVAS`)
- Create: `src/services/importacao.js`
- Test: `test/importacao.test.js`
- Modify: `package.json` / `package-lock.json` (fflate)

**Interfaces:**
- Produces: `criarServicoImportacao({ db, config, logger, agora? }) → { importar(arquivos: Array<{ nome: string, bytes: Buffer }>) → { importadas: { entrada: number, saida: number }, jaExistiam: number, ignoradas: Array<{ nome: string, motivo: string }>, clientesAfetados: number[] } }` (síncrono).

- [ ] **Step 1: Instalar fflate** — `npm install fflate --ignore-scripts`; conferir que entra em `dependencies`.
- [ ] **Step 2: Escrever os testes que falham** em `test/importacao.test.js`. Montagem igual a `test/captura-nfse.test.js` (banco `:memory:`, `pastaXmls` temporária, cliente `CNPJ_MOCK_OK`), XMLs de `xmlNfse`/`chaveNfse`/`PRESTADOR_MOCK` de `src/sefaz/adn-mock`. ZIP de teste com `zipSync` do fflate. Testes:
  - `importa entrada e saída com origem importada`: um XML com tomador = cliente e outro com prestador = cliente → `importadas` = `{ entrada: 1, saida: 1 }`; notas com `modelo 'nfse'`, `status 'completa'`, `origem 'importada'`, `nsu` nulo; XMLs em `Cliente 1/2026/10-Outubro/NFS-e/Entradas/XML/<chave>-nfse.xml` e `.../Saidas/XML/...`.
  - `CNPJ não cadastrado é ignorado`: prestador e tomador fora da carteira → `ignoradas` = `[{ nome, motivo: 'cnpj-nao-cadastrado' }]`, nenhuma nota.
  - `nota já existente conta como já existia`: importar o mesmo arquivo duas vezes (e duas vezes no mesmo lote) → `jaExistiam` certo, 1 nota só.
  - `nota entre dois clientes grava nos dois`: segundo cliente `99888777000100` cadastrado como prestador → 1 saída para ele, 1 entrada para o cliente 1.
  - `zip com pastas e arquivos misturados`: ZIP `Lote.ZIP` com `a/1.xml`, `a/b/2.XML`, `leia.txt` → 2 importadas, `leia.txt` com `'nao-xml'`.
  - `zip corrompido e arquivos que não são NFS-e`: bytes aleatórios `x.zip` → `'zip-invalido'`; `nota.pdf` → `'nao-xml'`; XML `<nfeProc/>` → `'nao-nfse'`; XML quebrado `<NFSe>` → `'invalido'`; o resto do lote é gravado.
  - `XML com BOM e em ISO-8859-1`: mesmo resultado que o UTF-8 simples.
  - `cancelamento já existente marca a nota`: evento `101101` com a chave inserido antes em `eventos` → nota com `cancelada = 1`.
  - `banco novo tem a coluna origem com padrão captura`: `INSERT` sem origem → `'captura'`.
- [ ] **Step 3: Rodar e ver falhar** — `node --test test/importacao.test.js` → FAIL (módulo não existe).
- [ ] **Step 4: Coluna** — acrescentar `['notas', 'origem', "TEXT NOT NULL DEFAULT 'captura'"]` em `COLUNAS_NOVAS`.
- [ ] **Step 5: Implementar `src/services/importacao.js`.** Pontos fixos:
  - Expandir: nome terminando em `.zip` (sem diferenciar maiúscula) → `unzipSync`; erro → `zip-invalido`; entradas que terminam em `/` são pastas e saem; dentro do ZIP o `nome` reportado é `lote.zip/caminho`.
  - Não termina em `.xml` → `nao-xml`.
  - Texto com `decodificarXml(bytes)`; sem `<NFSe` na raiz (testar `parser`/`dadosNfse` → sem `chave`) separar: se o XML não tem `NFSe` → `nao-nfse`; se tem mas `dadosNfse` lança ou volta sem chave → `invalido`.
  - Dono: índice `cnpj → cliente` de `SELECT * FROM clientes` (todos, inclusive desativados e sem certificado). Prestador cliente → saída; tomador cliente → entrada; os dois → grava nos dois; nenhum → `cnpj-nao-cadastrado`.
  - Já existe `(cliente_id, chave)` → `jaExistiam++`, sem regravar.
  - Grava com `criarArmazenamento({ config, db }).salvar({ cliente, modelo: 'nfse', direcao, competencia: d.competencia, nomeArquivo: nomes.nfse(d.chave), xml })` e INSERT com as mesmas colunas da captura de NFS-e mais `origem = 'importada'`, `nsu = NULL`; `cancelada` pelo mesmo SELECT de cancelamentos (`101101`, `105102`).
  - Banco numa `db.transaction` por lote; `clientesAfetados` sem repetição.
- [ ] **Step 6: Rodar e ver passar** — `node --test test/importacao.test.js` → PASS; `node --test test/db.test.js test/captura-nfse.test.js` → PASS.
- [ ] **Step 7: Commit** — `git add src/db/index.js src/services/importacao.js test/importacao.test.js package.json package-lock.json` / `git commit -m "Serviço de importação de XMLs de NFS-e"`.

### Task 2: Rota `POST /api/importar`

**Files:**
- Modify: `src/contexto.js` (expor `importacao`)
- Modify: `src/web/server.js`
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: `criarServicoImportacao` (Tarefa 1).
- Produces: `POST /api/importar` com corpo `{ arquivos: [{ nome: string, base64: string }] }` → 200 com o resumo da Tarefa 1; `ctx.importacao`.

- [ ] **Step 1: Testes que falham** em `test/web.test.js` (helper `montar`/`pedir` existente):
  - `importar grava a NFS-e e devolve o resumo`: XML de entrada para `CNPJ_MOCK_OK` → 200, `importadas.entrada === 1`, nota no banco com `origem 'importada'`.
  - `importar só no próprio PC`: `montar(t, {}, { ehLocal: () => false })` → 403 com `erro` contendo `próprio computador`.
  - `importar recusa durante a captura`: com `capturaOcupada` verdadeira (usar `atrasoSefazMs` e disparar `/api/captura` antes, como os testes de 409 existentes) → 409.
  - `importar sem arquivos dá 400`: corpo `{ arquivos: [] }` → 400 `Arraste ao menos um arquivo XML ou ZIP.`.
  - `corpo grande demais dá 413`: corpo acima do limite → 413 com `erro`.
- [ ] **Step 2: Rodar e ver falhar** — `node --test --test-name-pattern=importar test/web.test.js` → FAIL (404).
- [ ] **Step 3: Implementar.**
  - `contexto.js`: `importacao: criarServicoImportacao(deps)`.
  - `server.js`: `LIMITE_IMPORTACAO = '64mb'`; antes do `express.json` geral, middleware só para `POST /importar` que recusa com 403 quando `!ehLocal(req)` (mensagem `A importação só pode ser feita no próprio computador do sistema.`) antes de ler o corpo e aplica `express.json({ limit: LIMITE_IMPORTACAO })`. Erro de tamanho (`type === 'entity.too.large'`) → 413 `Arquivos grandes demais para uma importação só. Separe em partes menores.` (verificar se o tratador de erro já cobre; senão, cobrir).
  - Rota: `capturaOcupada()` → 409 `Espere a captura terminar para importar.`; lista vazia ou ausente → 400; converte base64 → Buffer; `ctx.importacao.importar(...)`; se `clientesAfetados.length` → `ctx.organizador.agendar({ conferirArquivos: true })`; responde o resumo.
- [ ] **Step 4: Rodar e ver passar** — `node --test test/web.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Rota de importação de XMLs"`.

### Task 3: Tela Importar XMLs

**Files:**
- Create: `painel/src/telas/Importar.jsx`
- Modify: `painel/src/App.jsx` (rota `importar`), `painel/src/layout/MenuLateral.jsx` (item antes de Exportar), `painel/src/estilo.css` (área de soltar)

**Interfaces:**
- Consumes: `POST /api/importar` (Tarefa 2), `api.post` de `painel/src/api.js`.

- [ ] **Step 1: Menu e rota** — item `{ para: '/importar', rotulo: 'Importar XMLs', icone: 'fa-file-arrow-up' }` logo antes de Exportar; rota `{ path: 'importar', element: <Importar /> }`.
- [ ] **Step 2: Tela.** Título "Importar XMLs"; texto curto "Solte aqui XMLs de NFS-e ou um ZIP com eles. O Smart Fiscal acha o cliente pelo CNPJ e organiza como uma nota capturada."; área de soltar (`onDragOver`/`onDrop`) que também abre o `<input type="file" multiple accept=".xml,.zip">` ao clicar; base64 por arquivo (mesma conversão de `arquivoBase64.js`, sem o limite de tamanho do certificado — extrair a conversão para uma função sem limite e manter `arquivoBase64` usando-a); botão desabilitado e texto "Importando…" enquanto envia; erro em `faixa faixa-erro`; resultado em `faixa faixa-ok` com: "N notas importadas (X entradas, Y saídas).", "M já estavam no Smart Fiscal.", e lista das ignoradas com nome e motivo em português (`cnpj-nao-cadastrado` → "CNPJ não cadastrado em Clientes", `nao-xml` → "não é XML", `nao-nfse` → "não é NFS-e", `invalido` → "XML ilegível", `zip-invalido` → "ZIP corrompido").
- [ ] **Step 3: Build** — `npx vite build painel` → sem erro.
- [ ] **Step 4: Conferir no navegador** contra um servidor com dados fictícios (porta 3032, `SEFAZ_MOCK=1`), soltando um XML via `input` e vendo o resultado; print com Chrome headless.
- [ ] **Step 5: Suite completa** — `node --test --test-timeout=60000` → todos passam.
- [ ] **Step 6: Commit** — `git commit -m "Tela Importar XMLs"`.
