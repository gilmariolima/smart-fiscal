# Buscar notas antigas — plano de implementação

> **Para quem for executar:** use subagent-driven-development (recomendado) ou executing-plans, tarefa por tarefa. Os passos usam caixas (`- [ ]`) para marcar o andamento.

**Objetivo:** aba "Notas antigas", onde o usuário escolhe um cliente com certificado e cola chaves de NF-e. O app baixa cada nota pela SVRS, uma por minuto, numa fila guardada no banco, e passa cada XML pelo Importar.

**Arquitetura:** `src/sefaz/svrs.js` faz o POST com TLS de cliente e lê o `stringJson` da página. `src/services/buscaAntiga.js` cuida da fila (tabela `busca_antiga`), do ritmo e da chamada ao Importar. As rotas `/api/busca-antiga` atendem a tela `NotasAntigas.jsx`.

**Stack:** Node (CommonJS), https, node-forge, better-sqlite3, node:test e React 19.

**Spec:** `docs/superpowers/specs/2026-11-12-buscar-notas-antigas-design.md`

## Restrições gerais

- **Pedido HTTP:**
  - endereço `POST https://dfe-portal.svrs.rs.gov.br/NfeSSL/DownloadXmlDfe`;
  - corpo urlencoded com `sistema=Nfe`, `OrigemSite=0`, `Ambiente=1` e `ChaveAcessoDfe=<chave>`;
  - timeout de 60 s.
- **Resposta:** o XML vem em `var stringJson = { "xml": ... };`. O motivo vem no texto depois de "Consulta realizada em : <data>".
- **Motivos reconhecidos:** `/difere do CNPJ base dos envolvidos/i` dá `nao-envolvido`; `/múltiplas consultas/i` dá `bloqueado`.
- **Ritmo:**
  - 60 s entre consultas;
  - no bloqueio, pausa de 5 min e mais 30 s no intervalo, até 180 s;
  - depois de 20 consultas sem bloqueio, menos 15 s, até 60 s;
  - quando não pode rodar, verifica de novo a cada 30 s;
  - ao iniciar, espera 60 s;
  - no máximo 3 tentativas para erro de rede, HTTP 5xx ou motivo desconhecido.
- **Situações:** `fila`, `baixada`, `ja-existia`, `nao-envolvido`, `nao-nfe`, `erro`.
- **Textos da tela, exatamente:**
  - título "Notas antigas"; subtítulo "NF-e com mais de 90 dias, pela SVRS";
  - caixa de texto "Cole as chaves de acesso (uma por linha ou como vierem)";
  - situações "Na fila", "Baixada", "Já estava no Smart Fiscal", "Certificado não é de envolvido", "Não é NF-e", "Erro";
  - botões "Limpar concluídas · Pausar/Continuar", com a ação afirmativa à direita.
- **Menu:** rota `#/notas-antigas`, ícone `fa-clock-rotate-left`, item logo abaixo de "Importar XMLs".
- **Rotas:** só no PC local (`exigirLocal`).
- **Testes:** sem rede e sem esperar o relógio (temporizador injetado). Não rodar `npx prettier`. `src/web/server.js` e `src/servidor.js` têm CRLF no disco: editar com a ferramenta de edição.

## Foco da revisão

1. **App fechado no meio de uma consulta:** a chave continua `fila` e é consultada de novo ao abrir, sem duplicar a nota. Coberto na Tarefa 3.
2. **Chave colada com pontuação ou em blocos de 4** (`3522 1009 ...`): reconhecida. Já uma sequência de mais de 44 dígitos seguidos não pode virar chave. Coberto na Tarefa 3.
3. **Cliente excluído com chaves na fila:** as linhas somem (`ON DELETE CASCADE`) e o serviço não quebra. Coberto na Tarefa 3.
4. **A SVRS devolve um HTML inesperado** (manutenção de domingo, página de erro): conta como tentativa e, depois de 3, vira `erro` com o texto. Coberto nas Tarefas 1 e 3.
5. **Pausar no meio de uma consulta:** a consulta em curso termina e grava, e a próxima não começa. Coberto na Tarefa 3.

---

### Tarefa 1: cliente SVRS

**Arquivos:**
- Criar: `src/sefaz/certificado.js`, com o `agenteDoCertificado(pfx, passphrase)` que sai de `src/sefaz/adn.js:25-35`. O `adn.js` e o `cte.js` passam a importar daqui; o `cte.js` tem uma cópia em `:26` e só troca se for a mesma.
- Criar: `src/sefaz/svrs.js`
- Teste: `test/svrs.test.js`

**Interfaces:**
- Produz `lerRespostaSvrs(html) → { xml } | { motivo: 'nao-envolvido'|'bloqueado'|'erro', mensagem }`.
- Produz `criarClienteSvrs({ pfx, passphrase, requisitar? }) → { baixarNfe(chave): Promise<{ xml } | { motivo, mensagem }> }`.
  - `requisitar(corpo) → Promise<{ status, html }>` vem injetado nos testes. O padrão é `https.request` com o agente.
  - Erro de rede ou status ≥ 500 dá `{ motivo: 'erro', mensagem, repetir: true }`.
  - Motivo desconhecido também leva `repetir: true`.
- Produz `criarFabricaSvrs(config) → (cliente) => clienteSvrs`.
  - O certificado vem de `config.pastaCerts` e `descriptografar`.
  - Com `config.sefazMock`, usa uma SVRS falsa: entrega `nfeProc` (gerado com `xmlNfeProc` do `mock-client`, ou um modelo local no mesmo formato) quando o CNPJ do emitente da chave é o do cliente, e responde "difere do CNPJ base" nos outros casos.
- Produz `src/sefaz/certificado.js`: `agenteDoCertificado(pfx, passphrase) → https.Agent`.

- [ ] **Passo 1: escrever os testes que falham:**
  - `lerRespostaSvrs` com estas páginas:
    - `<script>var stringJson = {\n "xml": "<nfeProc ...>...</nfeProc>"\n};</script>` devolve `{ xml }`, com o XML igual ao original e as aspas escapadas tratadas;
    - "Consulta realizada em : 12/11/2026 14:03:21 CNPJ base do certificado digital (CNPJ8) informado difere do CNPJ base dos envolvidos (CNPJ8)." devolve `nao-envolvido`;
    - "IP não autorizado devido múltiplas consultas" devolve `bloqueado`;
    - "Consulta realizada em : X NF-e inexistente na base" devolve `erro`, com a mensagem `NF-e inexistente na base`;
    - um HTML sem nada disso devolve `erro`.
  - `baixarNfe`, com um `requisitar` falso:
    - envia exatamente o corpo `sistema=Nfe&OrigemSite=0&Ambiente=1&ChaveAcessoDfe=<chave>`;
    - status 503 e erro de rede dão `{ motivo: 'erro', repetir: true }`.
  - `criarFabricaSvrs` com `sefazMock`: para a chave cujo emitente é `CNPJ_MOCK_OK`, devolve `{ xml }` com `<nfeProc`; para outra, devolve `nao-envolvido`.
  - `agenteDoCertificado` (movido): os testes do `adn` continuam passando.
- [ ] **Passo 2: rodar e conferir que falha.** `node --test test/svrs.test.js` dá FAIL porque o módulo não existe.
- [ ] **Passo 3: implementar.**
  - O `stringJson` é extraído com `/var\s+stringJson\s*=\s*(\{[\s\S]*?\});/` e lido com `JSON.parse`.
  - A mensagem é o texto sem tags, depois de "Consulta realizada em : <data hora>". Corta antes de "Entrar com" e de "Janela de Manutenção".
- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/svrs.test.js test/adn.test.js test/cte-cliente.test.js` dá PASS.
- [ ] **Passo 5: commit.** `git commit -m "Cliente da SVRS para baixar NF-e pela chave"`

### Tarefa 2: tabela `busca_antiga`

**Arquivos:**
- Modificar: `src/db/migrations.sql`, acrescentando a tabela exatamente como na spec, com `ON DELETE CASCADE`.
- Teste: `test/db.test.js`

**Interfaces:** produz a tabela `busca_antiga(id, cliente_id, chave, situacao, mensagem, tentativas, criado_em, atualizado_em, UNIQUE(cliente_id, chave))`.

- [ ] **Passo 1: escrever o teste que falha.** Com o banco novo, inserir na tabela funciona, e um `DELETE` do cliente apaga as linhas dele. Conferir antes se as foreign keys estão ligadas em `abrirBanco` com `PRAGMA foreign_keys`. Se não estiverem, o serviço apaga as linhas à mão ao excluir o cliente e o teste confere esse caminho. Registrar o que for decidido.
- [ ] **Passo 2: rodar e conferir que falha.**
- [ ] **Passo 3: implementar.**
- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/db.test.js`.
- [ ] **Passo 5: commit.** `git commit -m "Tabela da fila de notas antigas"`

### Tarefa 3: serviço da fila

**Arquivos:**
- Criar: `src/services/buscaAntiga.js`
- Modificar: `src/contexto.js`, para expor `ctx.buscaAntiga` com `fabricaSvrs: fabricaSvrs || criarFabricaSvrs(config)`. O parâmetro `fabricaSvrs` é opcional em `criarContexto`.
- Teste: `test/busca-antiga.test.js`

**Interfaces:**
- Consome: `criarFabricaSvrs`, da Tarefa 1; `importacao.importar(arquivos, { soDaCarteira })`, da 1.13.0.
- Produz `criarBuscaAntiga({ db, config, logger, importacao, fabricaSvrs, podeRodar = () => null, aoImportar = () => {}, agora = () => new Date(), temporizador = { setTimeout, clearTimeout } })`, que devolve:
  - `adicionar(clienteId, texto) → { adicionadas, repetidas, naoNfe }`. Lança `Error` com `codigo: 404` para cliente inexistente ou sem certificado.
  - `estado() → { pausada, rodando, motivo, intervaloS, proximaEm, voltaAs, total, pendentes }`.
  - `listar({ situacao } = {}) → linhas[]`: até 500, `ORDER BY id DESC`, com `cnpj` e `nome` do cliente.
  - `pausar()`, `continuar()`, `limparConcluidas() → n`, `iniciar()` e `parar()`.
  - `processarProxima() → Promise<string|null>`, exportado para os testes. Processa uma chave e devolve a situação final, ou `null` quando a fila está vazia.
  - `configurar({ podeRodar, aoImportar })`: troca os ganchos depois de criado; o servidor liga na Tarefa 4.
  - Intervalo base: `config.buscaAntigaIntervaloMs || 60000`. O `config.js` lê `BUSCA_ANTIGA_INTERVALO_MS`, opcional, só para a demonstração. Os outros tempos da spec ficam fixos.

- [ ] **Passo 1: escrever os testes que falham.** Usam o banco `:memory:`, a SVRS falsa (fábrica injetada, com respostas por chave), um temporizador falso que guarda os callbacks com os atrasos e a pasta temporária. O Importar é o real, com `criarServicoImportacao`.
  - `adicionar`:
    - acha 2 chaves no texto `"a 3522 1009 3747 5100 0142 5500 2000 0673 1810 0328 3126, b;<chave2>"`;
    - uma sequência de 45 dígitos não vira chave;
    - a repetida conta em `repetidas`;
    - modelo 65 vira `nao-nfe`;
    - colar de novo uma chave em `erro` volta para `fila` com `tentativas = 0`;
    - cliente sem certificado lança 404.
  - `processarProxima`:
    - a SVRS devolve um XML de NF-e do cliente: a chave vira `baixada`, a nota fica no banco com `origem='importada'` e `aoImportar` é chamado com `[clienteId]`;
    - a nota já está completa com arquivo: vira `ja-existia` e a SVRS não é chamada;
    - `nao-envolvido` vira `nao-envolvido`, com a mensagem;
    - `bloqueado` deixa a chave em `fila` com `tentativas` igual, e `estado().intervaloS === 90` e `voltaAs` = agora + 5 min;
    - erro de rede três vezes vira `erro` na terceira;
    - o XML devolvido é de homologação: vira `erro` com "nota de homologação (teste)";
    - certificado vencido (`cert_validade` no passado): vira `erro` "Certificado vencido", sem chamar a SVRS.
  - **Ritmo** (com o temporizador falso):
    - depois de `iniciar()`, o primeiro agendamento é de 60 000 ms;
    - depois de uma consulta, o próximo é de 60 000 ms;
    - depois de um bloqueio, é de 300 000 ms;
    - com `podeRodar` devolvendo um motivo, reagenda a cada 30 000 ms e `estado().motivo` mostra esse texto;
    - pausado, não agenda nada;
    - `pausar()` grava `busca_antiga_pausada` e um serviço novo sobre o mesmo banco nasce pausado;
    - `continuar()` agenda de novo.
  - `limparConcluidas` apaga só `baixada`, `ja-existia` e `nao-nfe`.
  - **Cliente excluído:** com a linha na fila, o cliente é apagado. `processarProxima` não lança erro e a linha some, por cascata ou pela limpeza.
  - **Pausa no meio:** `pausar()` chamado enquanto o `baixarNfe` falso está pendente. A chave termina `baixada` e nenhum agendamento novo é feito.
- [ ] **Passo 2: rodar e conferir que falha.** `node --test test/busca-antiga.test.js`.
- [ ] **Passo 3: implementar.**
  - Uma consulta por vez: a flag `ocupado` impede duas ao mesmo tempo.
  - A situação vai para o banco antes de agendar a próxima.
  - Os motivos do Importar são traduzidos com o mesmo mapa de textos da tela: copiar as 4 entradas usadas para um `MOTIVOS_IMPORTAR` no serviço (`sem-protocolo`, `homologacao`, `invalido`, `nao-suportado`).
- [ ] **Passo 4: rodar e conferir que passa.**
- [ ] **Passo 5: commit.** `git commit -m "Fila das notas antigas: uma consulta por minuto e importação"`

### Tarefa 4: ligar no servidor e rotas

**Arquivos:**
- Modificar: `src/servidor.js`, depois da varredura das notas sem cliente.
  - Chama `ctx.buscaAntiga.iniciar()` com `podeRodar`. O motivo é um destes textos: "Esperando a captura terminar" (agendador rodando ou ciclo em andamento), "Esperando a troca da pasta" (`pastas.movendoAgora()`) e "Escolha a pasta principal na tela Pastas" (sem pasta, quando `exigirPasta`).
  - Liga `aoImportar` a `ctx.organizador.agendar({ conferirArquivos: true })`.
  - Como esses ganchos dependem do agendador, o `criarBuscaAntiga` recebe `podeRodar` e `aoImportar` por `configurar({ podeRodar, aoImportar })`, chamado aqui antes de `iniciar()`.
  - No fechamento, chama `parar()`.
- Modificar: `src/web/server.js`, com as rotas da spec perto de `/api/importar`. O 404 da `adicionar` vira `ErroHttp(404, 'Cliente sem certificado: escolha um cliente com certificado A1.')`. Sem chave válida dá 400 "Cole ao menos uma chave de 44 dígitos.".
- Teste: `test/web.test.js`

**Interfaces:** consome `ctx.buscaAntiga` da Tarefa 3, mais o `configurar`.

- [ ] **Passo 1: escrever os testes que falham.**
  - `POST /api/busca-antiga {cnpj: CNPJ_MOCK_OK, texto}` devolve 200 com `adicionadas: 1`.
  - `GET /api/busca-antiga` devolve a linha em `fila` e o `estado`.
  - `POST /pausar` e depois `GET`: `estado.pausada === true`. `POST /continuar` volta para `false`.
  - `POST /limpar` devolve 200.
  - Cliente sem certificado dá 404. Texto sem chave dá 400. Pedido de fora do PC dá 403.
- [ ] **Passo 2: rodar e conferir que falha.**
- [ ] **Passo 3: implementar.**
- [ ] **Passo 4: rodar e conferir que passa.** `node --test test/web.test.js test/busca-antiga.test.js`, depois a suíte inteira.
- [ ] **Passo 5: commit.** `git commit -m "Rotas e início da busca de notas antigas"`

### Tarefa 5: tela

**Arquivos:**
- Criar: `painel/src/telas/NotasAntigas.jsx`
- Modificar: `painel/src/App.jsx` (rota `notas-antigas`), `painel/src/layout/MenuLateral.jsx` (item abaixo de Importar) e `painel/src/estilo.css` (só o que faltar; reaproveitar as classes de tabela e de cartão que já existem)

**Interfaces:** consome as rotas da Tarefa 4.

- [ ] **Passo 1: implementar a tela.**
  - **Formulário:** seletor de clientes, de `GET /api/clientes`, filtrado pelos que têm certificado e pela carteira (`papel === 'cliente' || tambem_cliente`). Depois a caixa de texto e o botão Buscar. O resultado aparece como "N chaves na fila (M repetidas ignoradas, K não são NF-e)", mostrando só as partes maiores que zero.
  - **Andamento:**
    - pausado: "Pausado";
    - com `voltaAs`: "SVRS pediu pausa: volta às HH:MM";
    - com `motivo`: o motivo;
    - com fila andando: "X de Y · próxima em N s".
  - **Lista:** tabela com Cliente, Chave (em blocos de 4), Situação e Mensagem, e um filtro por situação.
  - **Atualização:** busca de novo a cada 5 s enquanto `pendentes > 0`, sem mexer na rolagem.
- [ ] **Passo 2: build.** `npx vite build painel` sem erros.
- [ ] **Passo 3: conferir no navegador** com dados fictícios (porta 3032, `SEFAZ_MOCK=1`, `cliente:demo`):
  - colar 2 chaves do cliente demo e 1 de outro emitente;
  - a fila mostra "Na fila";
  - chamar `POST /api/busca-antiga/continuar` e, para não esperar 60 s, deixar a demo com um intervalo menor: `config.buscaAntigaIntervaloMs`, opcional, só para teste e demo, com padrão de 60000. Ele vem da variável de ambiente `BUSCA_ANTIGA_INTERVALO_MS` em `config.js`;
  - print da tela com "Baixada" e "Certificado não é de envolvido".
- [ ] **Passo 4: suíte inteira.** `node --test --test-timeout=60000`, com a saída para um arquivo e 0 falhas.
- [ ] **Passo 5: commit.** `git commit -m "Tela Notas antigas"`
