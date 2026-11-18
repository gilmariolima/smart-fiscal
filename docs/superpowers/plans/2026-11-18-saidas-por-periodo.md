# Saídas por período — plano de implementação

> **Para quem for executar:** executing-plans (em linha, com TDD) ou subagent-driven-development, e um revisor novo no fim. Os passos usam caixas (`- [ ]`).

**Objetivo:** na aba "Saídas pelo certificado", a pessoa escolhe a empresa, os meses (De e Até) e a série. O app acha sozinho as NF-e de saída desses meses e põe as chaves na fila da Busca por chave. O interruptor automático deixa de precisar de uma nota de partida.

**Arquitetura:**
- Um módulo novo e puro, `src/services/numeracaoSaidas.js`, faz as buscas na numeração (o último número, o primeiro e o último do período) sobre uma função `consultar(n)` injetada.
- `src/services/saidasPeloCertificado.js` guarda os pedidos em `saidas_periodos` e os roda dentro da mesma procura única (`emCurso`), com o mesmo `esperarVez` e o mesmo `interromper`.
- Rotas novas em `src/web/server.js` e dois componentes na tela `BuscaPorChave.jsx`.

**Stack:** Node (CommonJS), better-sqlite3, Express 5, React 19 e node:test.

**Spec:** `docs/superpowers/specs/2026-11-18-saidas-por-periodo-design.md`

## Restrições gerais

- **Meses:** dentro do serviço o mês é `AAMM`, o mesmo formato das posições 3 a 6 da chave (ex.: `'2606'` = 06/2026). Na API e na tela o mês é `'AAAA-MM'`. A conversão fica só nas rotas.
- **Janela:** do mês atual menos 5 até o mês atual (6 meses), contada por `agora()`.
- **Resultados da consulta:**
  - 613 com chave: o número existe, e o mês vem de `chave.slice(2, 6)`;
  - 526: o número existe, mas é antigo;
  - 217: o número não existe;
  - 656: para tudo;
  - qualquer outro resultado: erro.
- **Folga de furo:** 5 números (`FOLGA_FURO = 5`).
- **Ritmo:** 2 s entre quaisquer duas consultas da procura, com o `esperarVez()` existente.
- **Uma procura por vez** no app: o `emCurso` existente.
- **Origem na fila:** `'periodo'`. Direção: `'saida'`.
- **Série:** de 0 a 999. Na tabela e nas comparações, guardar como `String(Number(serie))`.
- **Situações do pedido:** `na-espera`, `procurando`, `concluido` e `erro`.
- **Textos da tela:**
  - bloco "Buscar por período", com os rótulos "Empresa", "De", "Até" e "Série";
  - botões "Buscar", "Cancelar" e "Colocar na fila";
  - linha do resultado: "Série 1: nº 1.040 a 1.351 · ~312 notas · download ~5 h 10 min";
  - enquanto busca: "Procurando o período… (1–2 min)";
  - lista "Pedidos", com o botão "Excluir pedido";
  - aviso de janela: "parte de MM/AAAA ficou fora (mais de 6 meses)";
  - nenhuma nota: "nenhuma nota no período" e "nenhuma nota nesta série".
- **Pares de botões:** a ação que liga fica à direita. Sem animação.
- **CRLF:** `src/web/server.js` e `src/servidor.js` têm CRLF no disco. Edite com a ferramenta de edição ou normalize o fim de linha no script. Não rodar `npx prettier`. Os testes não usam rede.

## Foco da revisão

1. **Furo exatamente na ponta testada pela busca binária:** o resultado não pode pular nem repetir notas do período.
2. **Pedido feito durante a procura automática:** fica `na-espera` e roda no mesmo `emCurso`, sem consultas em paralelo.
3. **Período que começa no mês mais antigo da janela:** os números de antes dão 526. O primeiro número é o primeiro 613, com o aviso de janela.
4. **App fechado ou 656 no meio do pedido:** continua do `proximo` gravado, sem refazer nem pular.
5. **Mês escolhido sem nenhuma nota** (entre duas notas de outros meses): "nenhuma nota no período", sem pedido.

---

### Tarefa 1: buscas na numeração (`numeracaoSaidas.js`)

**Arquivos:**
- Criar: `src/services/numeracaoSaidas.js`
- Teste: `test/numeracao-saidas.test.js`

**Interfaces:**
- Produz:
  - `classificar(r) → { tipo: 'existe'|'antiga'|'nao-existe'|'parar'|'erro', aamm?: string, chave?: string, mensagem?: string }`. Recebe o retorno de `consulta.consultar(chave)` (`{ cStat, xMotivo, chaveVerdadeira, erro }`).
  - `acharUltimo(consultar, { partida = 0 } = {}) → Promise<number>`. `consultar(n) → Promise<classificado>`. Devolve 0 quando a série está vazia. `antiga` conta como "existe".
  - `acharPeriodo(consultar, { de, ate, ultimo }) → Promise<{ primeiro, ultimo, foraDaJanela: boolean } | null>`. Recebe `de` e `ate` em AAMM. Devolve `null` quando não há nota no período. `antiga` conta como "antes de `de`".
  - `class ErroDeConsulta extends Error { parar: boolean }`, lançado em `parar` (com `parar: true`) e em `erro`. Também é lançado com a mensagem "numeração com furo grande perto do nº X" quando um ponto da busca binária e os 5 vizinhos de cada lado não existem.
  - `FOLGA_FURO = 5`.

- [ ] **Passo 1: testes que falham.** O apoio do teste é uma SEFAZ falsa `numeros = Map<n, aamm|'antiga'>`, em que `consultar(n)` devolve `{ tipo: 'existe', aamm }`, `{ tipo: 'antiga' }` ou `{ tipo: 'nao-existe' }` e conta as chamadas. Os testes:
  - `acharUltimo sem partida acha o fim`: números 1 a 1351 existem → `1351`.
  - `acharUltimo atravessa furo perto do fim`: 1 a 1351 sem o 1349 e o 1350 → `1351`. Com partida 1000, também `1351`.
  - `acharUltimo de série vazia`: nenhum número → `0`, com no máximo 6 consultas (o 1 e os 5 seguintes).
  - `acharUltimo com notas antigas`: 1 a 500 `antiga` e 501 a 600 existindo → `600`.
  - `acharPeriodo de 1 e de 3 meses`: 1 a 100 = `'2605'`, 101 a 220 = `'2606'`, 221 a 300 = `'2607'`, 301 a 350 = `'2608'`. Com `ultimo` = 350:
    - `{de:'2606', ate:'2606'}` → `{primeiro:101, ultimo:220, foraDaJanela:false}`;
    - `{de:'2606', ate:'2608'}` → `{101, 350}`.
  - `acharPeriodo com furo na ponta`: o mesmo cenário sem o 101 e o 220 → `{primeiro:102, ultimo:219}`.
  - `acharPeriodo na borda do 526`: 1 a 80 `antiga` e 81 a 200 = `'2606'`, com `{de:'2606', ate:'2606'}` → `{primeiro:81, ultimo:200, foraDaJanela:true}`.
  - `acharPeriodo sem nota no mês`: 1 a 100 = `'2605'` e 101 a 200 = `'2607'`, com `{de:'2606', ate:'2606'}` → `null`.
  - `classificar`:
    - 613 com a chave → `existe`, com o aamm da chave;
    - 526 → `antiga`; 217 → `nao-existe`; 656 → `parar`;
    - `{ erro: 'ECONNRESET' }` → `erro`, com a mensagem.
  - `furo grande`: o ponto do meio da busca binária e os 5 números de cada lado não existem → rejeita com `/furo grande perto do nº/`.

- [ ] **Passo 2:** `node --test test/numeracao-saidas.test.js` → FALHA ("Cannot find module").

- [ ] **Passo 3: implementar.** Cada `consultar` que der `parar` ou `erro` vira `ErroDeConsulta`. A ideia de cada busca:
  - `acharUltimo`:
    - comece em `p = max(partida, 1)`;
    - se `p` não existir, olhe os 5 seguintes (`existeAoRedor`). Sem nenhum, devolva `partida` (ou 0 quando `partida` = 0);
    - suba dobrando o passo (1, 2, 4…) até um número que não existe, e faça a busca binária entre o último que existe e esse;
    - no candidato `c`, teste `c+1` a `c+5`. Se algum existir, recomece a subida dali.
  - Ponto da busca binária que não existe: use o primeiro que existe em `m+1..m+5`, depois em `m-1..m-5`, sem sair do intervalo. Sem nenhum, lance o erro de furo grande.
  - `acharPeriodo`:
    - `primeiro`: menor `n` em `[1, ultimo]` com `aamm >= de`, em que `antiga` conta como menor que qualquer mês;
    - `ultimo`: maior `n` em `[primeiro, ultimo]` com `aamm <= ate`;
    - `null` se o primeiro não existir ou tiver `aamm > ate`;
    - `foraDaJanela` = `primeiro > 1` e o número existente logo antes de `primeiro` deu `antiga`.

- [ ] **Passo 4:** `node --test test/numeracao-saidas.test.js` → todos passam.

- [ ] **Passo 5: commit** com "Saídas por período: buscas na numeração (último número e trecho do mês)".

### Tarefa 2: pedidos por período e o interruptor sem nota de partida

**Arquivos:**
- Modificar: `src/db/migrations.sql` (tabela nova) e `src/services/saidasPeloCertificado.js`.
- Teste: `test/saidas.test.js`. O `montar()` ganha a opção `meses: Map<n, aamm>`: na SEFAZ falsa, o 613 devolve a chave com aquele AAMM, e números marcados `'antiga'` dão 526.

**Interfaces:**
- Consome: `classificar`, `acharUltimo`, `acharPeriodo`, `ErroDeConsulta` (Tarefa 1).
- Produz, em `criarSaidas(...)`:
  - `janela() → { de: 'AAMM', ate: 'AAMM' }`;
  - `pedirPeriodo({ clienteId, de, ate, serie }) → Promise<{ serie, primeiro, ultimo, estimadas, foraDaJanela } | { nenhuma: true, motivo } | { naEspera: true, id }>`. Lança `Error` com a mensagem para a tela quando o mês está fora da janela, quando `ate < de`, quando a série é inválida ou quando o cliente não pode usar;
  - `confirmarPeriodo({ clienteId, de, ate, serie, primeiro, ultimo }) → id`. Grava `situacao 'procurando'`, `proximo = primeiro` e dispara `procurar()` sem esperar;
  - `excluirPeriodo(id) → boolean`;
  - `listarPeriodos() → [{ id, cnpj, nome, serie, de_aamm, ate_aamm, primeiro, ultimo, proximo, achadas, situacao, erro, atualizado_em }]`. Traz os não concluídos e os concluídos dos últimos 7 dias, do mais novo para o mais velho.

- [ ] **Passo 1: tabela.** Em `migrations.sql`:

```sql
CREATE TABLE IF NOT EXISTS saidas_periodos (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  serie TEXT NOT NULL, de_aamm TEXT NOT NULL, ate_aamm TEXT NOT NULL,
  primeiro INTEGER, ultimo INTEGER, proximo INTEGER,
  achadas INTEGER NOT NULL DEFAULT 0,
  situacao TEXT NOT NULL DEFAULT 'na-espera',
  erro TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
);
```

Em `test/db.test.js`, a lista de tabelas de "migrations criam as tabelas" ganha `saidas_periodos`.

- [ ] **Passo 2: testes que falham** em `test/saidas.test.js`. O "agora" do apoio é 18/11/2026, então a janela vai de `'2606'` a `'2611'`.
  - `pedido por período acha o trecho e, confirmado, põe só as chaves do período na fila`:
    - meses 1 a 100 = `'2607'`, 101 a 160 = `'2608'` e 161 a 200 = `'2609'`;
    - `pedirPeriodo({de:'2608', ate:'2608', serie:'1'})` → `{primeiro:101, ultimo:160, estimadas:60}`;
    - depois de `confirmarPeriodo` e `procurar()`, a fila tem 60 linhas com `origem 'periodo'` e `direcao 'saida'`, e o pedido fica `concluido` com `achadas` 60.
  - `pedido pula chave que já está no app ou na fila`: uma das 60 já está em `notas` → a fila ganha 59 linhas.
  - `pedido continua do próximo depois de 656`:
    - a SEFAZ dá 656 no número 130 → o pedido fica `procurando`, com `proximo` 130 e `erro` contendo /656/;
    - na próxima `procurar()`, a primeira consulta é o 130, e o pedido termina com as 60 chaves.
  - `fechar o app no meio do pedido`: com `parar()` na 10ª consulta, `proximo` fica gravado. Um `criarSaidas` novo sobre o mesmo banco continua dali.
  - `pausar a empresa no meio do pedido para`: o mesmo cenário do `aoDormir` dos testes de saídas atuais.
  - `pedido durante outra procura fica na espera e roda depois`:
    - com `procurar()` em curso (cliente ligado), `pedirPeriodo` devolve `{ naEspera: true, id }`;
    - quando a procura atual termina, a seguinte calcula `primeiro`/`ultimo`, grava no pedido e põe as chaves.
  - `pedido valida`:
    - `de '2605'` (fora da janela) rejeita com /6 meses/;
    - `ate < de` rejeita com /Até/;
    - série `'1000'` ou `'x'` rejeita com /Série/;
    - cliente de SP ou com A1 vencido rejeita com /não pode/.
  - `mês sem nota` → `{ nenhuma: true, motivo: 'nenhuma nota no período' }`, e nada é gravado em `saidas_periodos`.
  - `interruptor ligado sem nota de partida começa do último número`:
    - `ultimoNoApp: 0` e números 1 a 300 existindo;
    - na primeira `procurar()`, `saidas_series` ganha a série `'1'` com `ultimo_numero` 300, e nenhuma chave entra na fila;
    - com 301 e 302 passando a existir, a próxima `procurar()` põe 2 chaves.
  - O teste atual "cliente desligado, pausado ou sem início não consulta" perde o caso `semInicio`, que passa a ser coberto pelo teste acima.

- [ ] **Passo 3:** `node --test test/saidas.test.js` → os testes novos FALHAM.

- [ ] **Passo 4: implementar.**
  - Em `procurar()`, depois do laço das séries automáticas, rode os pedidos `na-espera` e `procurando`, por `id`:
    - pedido sem `primeiro`: `acharUltimo` e depois `acharPeriodo` (sem nota → `concluido` com `erro` "nenhuma nota no período");
    - em seguida, consulte de `proximo` até `ultimo`, gravando `proximo` e `achadas` a cada consulta;
    - um `ErroDeConsulta` com `parar` grava o erro, mantém `procurando` e encerra a procura;
    - outro erro põe o pedido em `erro`.
  - `pedirPeriodo` com `emCurso` ativo grava `na-espera` e devolve `{naEspera, id}`. Sem procura ativa, roda as duas buscas dentro de um `emCurso` próprio, para que o horário não consulte em paralelo.
  - Cliente ligado sem série conhecida: `acharUltimo(…, { partida: 0 })` na série `'1'`. Com resultado > 0, grave-o com `sql.inicio`; com 0, grave `ultimo_erro` "nenhuma nota nesta série".
  - O `cliente` vem de `sql.cliente.get` e passa pelas mesmas checagens `noPrazo` e `atendido`, com a mensagem "Esta empresa não pode usar: precisa de A1 no prazo e de estado atendido pela SVRS".

- [ ] **Passo 5:** `node --test test/saidas.test.js test/db.test.js` → todos passam.

- [ ] **Passo 6: commit** com "Saídas por período: pedidos em saidas_periodos e interruptor sem nota de partida".

### Tarefa 3: rotas

**Arquivos:**
- Modificar: `src/web/server.js` (perto de `app.get('/api/saidas'`, linha 714).
- Teste: `test/web.test.js`.

**Interfaces:**
- Consome os métodos da Tarefa 2.
- Produz:
  - `POST /api/saidas/periodo { cnpj, de: 'AAAA-MM', ate: 'AAAA-MM', serie }`:
    - 200 com o resultado, em que `de` e `ate` voltam como `'AAAA-MM'`;
    - 202 `{ naEspera: true, id }`;
    - 400 `{ erro }`;
    - 404 para CNPJ que não é cliente.
  - `POST /api/saidas/periodo/confirmar { cnpj, de, ate, serie, primeiro, ultimo }` → 201 `{ id }`. Com `primeiro` ou `ultimo` sem inteiro positivo, ou `primeiro > ultimo`, responde 400.
  - `DELETE /api/saidas/periodo/:id` → 204, ou 404.
  - `GET /api/saidas` → `{ clientes, rodando, periodos: listarPeriodos(), janela: { de: 'AAAA-MM', ate: 'AAAA-MM' } }`.
  - Todas começam com `exigirLocalBusca(req)`.

- [ ] **Passo 1: testes que falham** em `test/web.test.js`, com `SEFAZ_MOCK`:
  - o caminho feliz pede e confirma (201) e mostra o pedido em `GET /api/saidas` (`periodos.length === 1`);
  - `de: '2020-01'` → 400; `serie: 'abc'` → 400; CNPJ desconhecido → 404;
  - `DELETE` de um id que não existe → 404.
- [ ] **Passo 2:** `node --test test/web.test.js` → FALHA.
- [ ] **Passo 3: implementar** as rotas. A conversão é `'AAAA-MM'` → `AAMM` = `ano.slice(2) + mes`, e o contrário para a resposta. A data malformada responde 400 com "Escolha o mês no formato AAAA-MM".
- [ ] **Passo 4:** `node --test test/web.test.js` → passa.
- [ ] **Passo 5: commit** com "Saídas por período: rotas".

### Tarefa 4: tela

**Arquivos:**
- Modificar: `painel/src/telas/BuscaPorChave.jsx` (dentro de `SaidasPeloCertificado`) e `painel/src/estilo.css` (bloco "Busca por chave", com classes `.busca-periodo*`. Antes de criar uma classe, confira com grep que ela não existe).

**Interfaces:**
- Consome as rotas da Tarefa 3 e `formato.js` (`plural`, `inteiro`).
- Produz:
  - `BuscarPorPeriodo({ clientes, janela, aoMudar, aoErro })`: um formulário com Empresa (select com os `clientes` de `/api/saidas`), De e Até (selects com os 6 meses da janela, rotulados `MM/AAAA`, e Até igual ao mês atual por padrão) e Série (1 por padrão);
  - `Pedidos({ periodos, aoMudar, aoErro })`.

- [ ] **Passo 1: implementar.**
  - Ordem dentro da aba: `BuscarPorPeriodo`, `Pedidos` (só quando houver), o subtítulo "Seguir as saídas novas depois de cada captura" e os interruptores de hoje.
  - "Buscar" → `POST /api/saidas/periodo`:
    - 200 mostra a linha do resultado com "Cancelar" e "Colocar na fila", e com `foraDaJanela` o aviso "parte de MM/AAAA ficou fora (mais de 6 meses)";
    - 202 limpa o formulário e recarrega a lista;
    - `nenhuma` mostra o motivo.
  - Estimativa do download: `estimadas + estado.pendentes`, em minutos, formatada "~X h Y min" (ou "~Y min" abaixo de 60).
  - Linha do pedido:
    - `nome · MM a MM/AAAA · série S`;
    - a situação: "na espera", "achando chaves · N de M" (`N = proximo - primeiro`, `M = ultimo - primeiro + 1`), "concluído · N chaves" ou o erro;
    - o `BotaoIcone` "Excluir pedido".
  - Atualiza a cada 3 s enquanto algum pedido estiver `procurando` ou `na-espera`. Quando o último sair desse estado, chama o `aoTerminar` (que já recarrega a fila).
- [ ] **Passo 2:** `npx vite build painel` → "built".
- [ ] **Passo 3: conferir na demonstração.**
  - Configuração: `SEFAZ_MOCK`, porta 3032, `SAIDAS_INTERVALO_MS=200` e `BUSCA_ANTIGA_INTERVALO_MS=3000`.
  - O mock de `criarFabricaConsulta` precisa devolver meses diferentes por faixa de número. Se ele não fizer isso, ajuste o mock (só em `sefazMock`) para que o número `n` caia no mês `atual - floor((N - n) / 20)`, a partir de um fim fixo `N = 120`.
  - Prints: o formulário, o resultado com a estimativa, o pedido "achando chaves" e a pasta NF-e · Saídas recebendo as notas.
- [ ] **Passo 4:** rodar a suíte inteira com `npm test`. Todos passam; o C1 de `migracao-pastas`, que é de tempo, pode rodar sozinho se oscilar.
- [ ] **Passo 5: commit** com "Saídas por período: tela" e uma linha no ledger.

### Revisão final

- [ ] Revisão de todo o ramo pelo Fable (`git diff df6a1f4..HEAD`), com o Foco da revisão acima. Corrigir os críticos e importantes com teste. Registrar no cofre: `Decisoes/Smart Fiscal saidas por periodo` e `Projetos/Smart Fiscal`.
