# Captura de NFS-e por procuração — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar a NFS-e de clientes sem certificado próprio usando um certificado procurador (e-CPF do dono) pelo ADN.

**Architecture:** `fabricaAdn` passa a usar o certificado procurador para clientes sem A1 (`cnpjConsulta` = CNPJ do cliente); o procurador é guardado em `sistema` + `pastaCerts/procurador.pfx`; o ciclo inclui esses clientes só na NFS-e; cadastro por rotas locais e um cartão na tela Escritório.

**Tech Stack:** Node (better-sqlite3, node:test), node-forge, React 19.

**Spec:** `docs/superpowers/specs/2026-11-09-captura-procuracao-nfse-design.md`

## Global Constraints

- Só NFS-e; NF-e e CT-e nunca rodam para quem não tem A1.
- Sem dependência nova, sem mudança de esquema (usa `sistema` + um `.pfx`).
- Procurador só vale para cliente **sem** `cert_arquivo`; quem tem A1 não muda.
- Rodar testes com `node --test --test-timeout=60000`; nunca `npx prettier`.
- Textos em português, visual enxuto, sem animação.
- Chaves em `sistema`: `procurador_senha_enc`, `procurador_titular`, `procurador_validade`.
- Mensagem do E2245: `Sem procuração para este cliente no certificado procurador.`

## Review Focus

- `.pfx` do procurador com senha errada → erro claro, sem derrubar (Tarefa 1).
- Cliente sem A1 **sem procurador cadastrado** → fica fora da captura, como hoje (Tarefa 3).
- Cliente sem A1 com procurador → NF-e e CT-e **nunca** são consultadas, só NFS-e (Tarefa 3).
- Remover o procurador → cliente sem A1 volta a ficar fora (Tarefa 3).
- Rotas `/api/procurador*` de fora do PC → 403 (Tarefa 5).

---

### Task 1: Guardar e ler o procurador

**Files:**
- Modify: `src/services/clientes.js`
- Test: `test/procurador.test.js`

**Interfaces:**
- Produces, no serviço de clientes: `salvarProcurador({ pfx, senha }) → { titular, validade }`; `removerProcurador() → void`; `obterProcurador() → { titular, validade, diasParaVencer } | null`.
- Produces, exportado do módulo: `lerProcuradorCert({ db, config }) → { pfx: Buffer, passphrase: string } | null`.

- [ ] **Step 1: Testes que falham** em `test/procurador.test.js` (montagem como `test/cliente-sem-certificado.test.js`, com `pastaCerts` temporária e `montarAmbiente`; usar `gerarPfx` de `test/apoio/certificado` — se ele não gerar e-CPF, gerar um e-CNPJ serve, o procurador aceita qualquer A1 válido):
  - `salvarProcurador grava arquivo e linhas em sistema`: depois de salvar, existe `pastaCerts/procurador.pfx`, e `sistema` tem `procurador_senha_enc` (≠ senha em claro), `procurador_titular`, `procurador_validade`; `obterProcurador()` devolve `{ titular, validade, diasParaVencer }` sem senha.
  - `salvarProcurador recusa certificado vencido`: com um pfx vencido (data forçada por `agora`), lança com a data.
  - `salvarProcurador aceita e-CPF (sem CNPJ)`: um pfx cujo titular não tem CNPJ é aceito (não lança "é um e-CNPJ?").
  - `removerProcurador limpa arquivo e sistema`: some o arquivo e as três chaves; `obterProcurador()` → null.
  - `lerProcuradorCert devolve pfx e senha, ou null`: sem procurador → null; com procurador → `{ pfx, passphrase }` com a senha descriptografada.
- [ ] **Step 2: Rodar e ver falhar** — `node --test test/procurador.test.js` → FAIL.
- [ ] **Step 3: Implementar em `src/services/clientes.js`.** Reusar `lerCertificado`, `diasParaVencer`, `criptografar`/`descriptografar`, `config.masterKey`, `config.pastaCerts` e o mesmo padrão tmp+rename de `gravarPfx`. Validação do procurador: só recusa vencido (`diasParaVencer < 0`), não exige CNPJ. Gravar/ler `sistema` com os prepared statements já existentes (`gravarSistema`; um `SELECT valor FROM sistema WHERE chave=?`). `lerProcuradorCert({ db, config })` é função de módulo exportada, lê o arquivo e descriptografa a senha.
- [ ] **Step 4: Rodar e ver passar** — `node --test test/procurador.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Guardar e ler o certificado procurador"`.

### Task 2: fabricaAdn usa o procurador

**Files:**
- Modify: `src/sefaz/adn.js`, `src/contexto.js`
- Test: `test/procurador.test.js`

**Interfaces:**
- Consumes: `lerProcuradorCert` (Tarefa 1).
- Produces: `criarFabricaAdn(config, obterProcurador?) → (cliente) => clienteAdn`, onde `obterProcurador()` devolve `{ pfx, passphrase } | null`.

- [ ] **Step 1: Testes que falham** (em `test/procurador.test.js`): construir `criarFabricaAdn(config, obterProcurador)` com uma `pastaCerts` real (sem `sefazMock`), um cliente **com** `cert_arquivo` e outro **sem**. Espiar qual pfx foi aberto (p.ex. gravar pfx distintos e inspecionar o `cnpjConsulta` montando a URL com um `requisitar` injetado via `criarClienteAdn`? mais simples: testar a decisão por efeito) — asserts:
  - cliente com A1 → o ADN é montado com o certificado do cliente (procurador não é chamado).
  - cliente sem A1 e `obterProcurador()` devolve certificado → o ADN é montado e `consultarLote` chama a URL com `cnpjConsulta=<cnpj do cliente>` (verificar via `requisitar` injetável ou um mock de `obterProcurador` que conte as chamadas).
  - cliente sem A1 e `obterProcurador()` → null → devolve o cliente "indisponível" de hoje.
- [ ] **Step 2: Rodar e ver falhar** — FAIL.
- [ ] **Step 3: Implementar.** Em `adn.js`, `criarFabricaAdn(config, obterProcurador)`: no ramo não-mock, se `cliente.cert_arquivo` existe usa o A1 do cliente (como hoje); senão, `const proc = obterProcurador?.()`; se `proc`, `criarClienteAdn({ cnpj: cliente.cnpj, pfx: proc.pfx, passphrase: proc.passphrase, producao })`; senão o "indisponível" atual. O ramo `sefazMock` não muda. Em `contexto.js`, passar `() => lerProcuradorCert({ db: banco, config })` como 2º argumento.
- [ ] **Step 4: Rodar e ver passar** — PASS; `node --test test/adn.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "fabricaAdn usa o procurador para clientes sem certificado"`.

### Task 3: Ciclo inclui clientes sem A1 na NFS-e

**Files:**
- Modify: `src/services/ciclo.js`
- Test: `test/cliente-sem-certificado.test.js`

**Interfaces:**
- Consumes: comportamento da `fabricaAdn` (Tarefa 2); `sistema.procurador_senha_enc` (Tarefa 1) como sinal de "há procurador".

- [ ] **Step 1: Testes que falham** em `test/cliente-sem-certificado.test.js` (o `montar` já tem o mock do ADN; cadastrar o procurador gravando as linhas em `sistema` direto no banco, ou por `clientes.salvarProcurador`):
  - `com procurador, cliente sem A1 roda só NFS-e no ciclo automático`: cadastra cliente sem A1 com `auto_nfse=1`, grava procurador, `executarCiclo({ automatica: true })` → há resultado de NFS-e para ele e **não** há NF-e nem CT-e; o mock do ADN recebeu uma chamada com o CNPJ dele.
  - `sem procurador, cliente sem A1 continua fora`: sem procurador, o mesmo ciclo não consulta nada para ele (como hoje).
  - `auto_nfse=0 no cliente sem A1 é respeitado`: com procurador mas `auto_nfse=0`, não roda.
  - `captura manual de CNPJ sem A1 vale com procurador e erra sem ele`: `executarCiclo({ cnpj })` roda NFS-e com procurador; sem procurador devolve o erro "sem certificado".
  - `NF-e/CT-e nunca para quem não tem A1`: mesmo com `auto_nfe=1`/`auto_cte=1`, o cliente sem A1 não dispara captura de NF-e nem CT-e.
- [ ] **Step 2: Rodar e ver falhar** — FAIL.
- [ ] **Step 3: Implementar.** `sql.temProcurador` = `SELECT 1 FROM sistema WHERE chave='procurador_senha_enc'`. `sql.ativosSemCert` = `ativo=1 AND papel='cliente' AND cert_arquivo=''`. Quando há procurador, a lista do ciclo (ramo `!cnpj && !cnpjs`) vira `ativos ∪ ativosSemCert`. Em `executarCiclo`, `temCertProprio = !!cliente.cert_arquivo`; `comNfe` e `comCte` recebem `&& temCertProprio`; `comNfse = liga(cliente,'nfse') && (temCertProprio || temProcurador())`. Em `clientesAlvo`, o ramo de um `cnpj` sem `cert_arquivo` passa a ser aceito quando `temProcurador()` (roda só NFS-e); senão mantém o erro atual.
- [ ] **Step 4: Rodar e ver passar** — `node --test test/cliente-sem-certificado.test.js test/ciclo.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Ciclo captura NFS-e de clientes sem certificado pelo procurador"`.

### Task 4: E2245 vira mensagem clara

**Files:**
- Modify: `src/services/capturaNfse.js`
- Test: `test/captura-nfse.test.js`

**Interfaces:**
- Consumes: o erro do ADN (`erro` com `E2245`) já devolvido por `adn.js`.

- [ ] **Step 1: Teste que falha** em `test/captura-nfse.test.js`: um cliente cujo mock do ADN responde erro `HTTP 400: E2245 Não há procuração...` (via `mock.falhar(cnpj, '...E2245...')`) → `capturarCliente` termina com `ok` e grava em `nfse_ultimo_erro` exatamente `Sem procuração para este cliente no certificado procurador.`; a captura de outro cliente no mesmo ciclo não é afetada.
- [ ] **Step 2: Rodar e ver falhar** — FAIL.
- [ ] **Step 3: Implementar.** Em `capturaNfse.js`, ao tratar o erro da consulta, se o texto contém `E2245`, trocar a mensagem gravada em `nfse_ultimo_erro` pela frase do Global Constraints; os demais erros seguem como hoje.
- [ ] **Step 4: Rodar e ver passar** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "E2245 do ADN vira aviso de sem procuração"`.

### Task 5: Rotas do procurador

**Files:**
- Modify: `src/web/server.js`, `src/contexto.js`
- Test: `test/web.test.js`

**Interfaces:**
- Consumes: `clientes.salvarProcurador`, `removerProcurador`, `obterProcurador` (Tarefa 1).
- Produces: `GET /api/procurador`, `POST /api/procurador/certificado`, `POST /api/procurador/remover`; `ctx.clientes` já expõe os métodos.

- [ ] **Step 1: Testes que falham** em `test/web.test.js`:
  - `GET /api/procurador sem cadastro → { procurador: null }`; depois de `POST /api/procurador/certificado` → `{ procurador: { titular, validade } }`.
  - `POST /api/procurador/certificado` com senha errada → 400 com a mensagem do certificado.
  - `POST /api/procurador/remover` → 200 e o `GET` volta a `null`.
  - As três rotas de fora do PC (`ehLocal: () => false`) → 403.
- [ ] **Step 2: Rodar e ver falhar** — FAIL (404/200 sem gate).
- [ ] **Step 3: Implementar.** Acrescentar `procurador` ao `ROTA_CERTIFICADO` (continua exigindo PC local e corpo maior do `.pfx`). `GET /api/procurador` → `{ procurador: ctx.clientes.obterProcurador() }`. `POST /api/procurador/certificado` → `exigirLocal`, `lerPfx(req.body)`, `comoErroHttp(() => ctx.clientes.salvarProcurador({ pfx, senha: req.body.senha }))`. `POST /api/procurador/remover` → `exigirLocal`, `ctx.clientes.removerProcurador()`.
- [ ] **Step 4: Rodar e ver passar** — `node --test test/web.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Rotas do certificado procurador"`.

### Task 6: Tela do procurador

**Files:**
- Create: `painel/src/telas/Procurador.jsx`
- Modify: `painel/src/telas/Cadastro.jsx` (renderizar o cartão no modo escritório), `painel/src/telas/Clientes.jsx` (coluna "pelo procurador"), `painel/src/estilo.css`
- Test: build + conferência no navegador

**Interfaces:**
- Consumes: `GET/POST /api/procurador*` (Tarefa 5); `api` e `arquivoBase64` de `painel/src`.

- [ ] **Step 1: Cartão `Procurador.jsx`.** Usa `useApi('/api/procurador')`. Sem procurador: texto "Para puxar a NFS-e de clientes sem certificado, cadastre aqui o certificado com procuração no portal nacional." + enviar `.pfx`/`.p12` (via `arquivoBase64`) e senha → `POST /api/procurador/certificado`. Com procurador: titular, validade (aviso se vence em < 30 dias), botões Trocar e Remover (`POST /api/procurador/remover`). Erro em `faixa faixa-erro`, sucesso recarrega. Só aparece com `cadastroLiberado` (PC local).
- [ ] **Step 2: Renderizar** o `<Procurador />` na página Escritório (`Cadastro.jsx`, `modo === 'escritorio'`), abaixo do formulário do escritório.
- [ ] **Step 3: Clientes.** Na coluna Certificado, quando o cliente não tem A1 e `GET /api/procurador` indica que há procurador, mostrar "pelo procurador" no lugar de "Sem certificado".
- [ ] **Step 4: Build** — `npx vite build painel` → sem erro.
- [ ] **Step 5: Conferir no navegador** num servidor fictício (porta 3032, `cliente:demo`): cadastrar um procurador (usar um `.pfx` de teste gerado por `test/apoio/certificado` ou um dos certificados da pasta Estágio), ver o cartão preenchido e a coluna "pelo procurador" num cliente sem A1; print com Chrome.
- [ ] **Step 6: Suite completa** — `node --test --test-timeout=60000` → todos passam.
- [ ] **Step 7: Commit** — `git commit -m "Tela do certificado procurador"`.
