# Busca por chave — plano de implementação

> **Para quem for executar:** executing-plans (em linha, com TDD) e um revisor novo no fim. Os passos usam caixas (`- [ ]`).

**Objetivo:** a aba "Notas antigas" vira "Busca por chave", com:
- a fila em pastas (empresa e depois NF-e · Entradas e Saídas) e a pausa por empresa;
- as chaves lidas do SPED (C100);
- as saídas descobertas pelo número (cStat 613).

**Spec:** `docs/superpowers/specs/2026-11-18-busca-por-chave-design.md`

## Restrições gerais

- **Consulta de protocolo:**
  - `POST https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx`, SOAP 1.2, ns `http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4`, com `consSitNFe versao="4.00"`, `tpAmb=1` e `xServ=CONSULTAR`;
  - a cadeia ICP-Brasil (`node-mde/lib/env`) vai no `ca`.
- **Chave montada:** cUF + AAMM atual + CNPJ + `55` + série (3 dígitos) + número (9) + `1` + `12345678` + DV (módulo 11, pesos 2 a 9).
- **Descoberta:**
  - 2 s entre as consultas (`config.saidasIntervaloMs`, que só vale abaixo de 2 s com `sefazMock`);
  - para depois de 20 resultados 217 seguidos;
  - para tudo no 656;
  - 526 marca a série como "fora dos 6 meses".
- **SPED:** linhas `|0000|` (CNPJ no campo 07) e `|C100|` (IND_OPER no 02, COD_MOD no 05, CHV_NFE no 09). Texto em Latin-1. Só entra `COD_MOD` 55 com chave de 44 dígitos.
- **Textos da tela:**
  - título "Busca por chave" e subtítulo "NF-e pela SVRS, uma por minuto";
  - abas "Colar chaves", "Arquivo SPED" e "Saídas pelo certificado";
  - pastas "NF-e · Entradas" e "NF-e · Saídas";
  - estados da empresa "Baixando", "Na fila", "Pausado" e "Concluído";
  - menu com ícone `fa-magnifying-glass`.
- **Pares de botões:** a ação que liga fica à direita. Sem animação, letra mínima de 15 px e detalhe secundário de 12 px.
- **CRLF:** `src/web/server.js` e `src/servidor.js` têm CRLF no disco, então devem ser editados com a ferramenta de edição. Não rodar `npx prettier`. Os testes não usam rede.

## Foco da revisão

1. **Duas descobertas ao mesmo tempo** (o horário e o botão "Procurar agora"): não podem consultar o mesmo CNPJ em paralelo.
2. **Pausa por empresa no meio da consulta daquela empresa:** a consulta termina e a próxima é de outra empresa.
3. **SPED de outro CNPJ ou com vários estabelecimentos:** usa o 0000 e recusa se não for cliente.
4. **Série que nunca teve nota no app:** fica esperando a chave colada, sem consultar do número 1.
5. **Furo grande** (20 resultados 217 seguidos e nota depois): para nesse ciclo e continua do mesmo número no próximo. Isso é aceito.

---

### Tarefa 1: banco e fila (pastas e pausa por empresa)

**Arquivos:**
- `src/db/migrations.sql`: tabela `saidas_series`.
- `src/db/index.js` (COLUNAS_NOVAS):
  - `busca_antiga.origem TEXT NOT NULL DEFAULT 'colada'`;
  - `busca_antiga.direcao TEXT`;
  - `clientes.busca_pausada INTEGER NOT NULL DEFAULT 0`;
  - `clientes.saidas_auto INTEGER NOT NULL DEFAULT 0`.
- `src/services/buscaAntiga.js`, `src/web/server.js` (rotas) e os testes `test/busca-antiga.test.js`, `test/web.test.js` e `test/db.test.js`.

**Interfaces:**
- `adicionar(clienteId, texto, { origem = 'colada', direcoes = null } = {})`. `direcoes` é um Map de chave → direção, vindo do SPED. Sem ele, a direção sai da chave (CNPJ nas posições 7 a 20 igual ao do cliente dá `saida`).
- `adicionarChaves(clienteId, [{ chave, direcao }], { origem })`, usado pelo SPED e pelas saídas, com o mesmo retorno do `adicionar`.
- `processarProxima`: pega a primeira linha `fila` de um cliente com `busca_pausada = 0`.
- `pausarCliente(clienteId, pausada)`.
- `tentarDeNovo(ids) → n`: devolve para a fila as linhas em `erro` ou `nao-envolvido`.
- `estado()` acrescenta:
  - `contagens` (por situação);
  - `estimativaS = pendentes não pausados × intervaloS`;
  - `clientes: [{ cnpj, nome, total, baixadas, problemas, pendentes, pausada, daVez, direcoes: { entrada: {total, baixadas, problemas}, saida: {...} } }]`, onde `baixadas` conta `baixada` mais `ja-existia` e `problemas` conta `erro` mais `nao-envolvido`;
  - `daVez`: o cliente da próxima linha que vai ser consultada.
- `listar({ cnpj, direcao, situacao, de = 0 })`: até 200 linhas, pendentes primeiro e depois por id decrescente. Cada linha traz `direcao` e, da tabela `notas` (cliente e chave), `numero`, `data_emissao`, `valor_total` e `outra` (o destinatário na saída, o emitente na entrada, em CNPJ e nome).
- **Rotas:**
  - `GET /api/busca-antiga?cnpj&direcao&situacao&de`;
  - `POST /api/busca-antiga/cliente-pausa {cnpj, pausada}`;
  - `POST /api/busca-antiga/tentar-de-novo {ids}`.

- [ ] Testes que falham:
  - direção pela chave;
  - pausa por empresa: a fila pula a empresa pausada, continuar volta a pegar, e pausar no meio da consulta deixa ela terminar;
  - `tentarDeNovo`;
  - `estado.clientes` e `estado.contagens` batem com as linhas;
  - `listar` com filtros, os dados da nota baixada e "Mostrar mais" (`de`);
  - as rotas.
- [ ] Implementar e passar. Rodar a suíte inteira e fazer o commit.

### Tarefa 2: SPED

**Arquivos:** `src/services/chavesDoSped.js` (novo), a rota em `src/web/server.js`, `test/chaves-do-sped.test.js` e `test/web.test.js`.

**Interfaces:**
- `lerChavesDoSped(buffer) → { cnpj, periodo, chaves: [{ chave, direcao }] }`, onde `periodo` é `AAAA-MM` do DT_INI.
- `POST /api/busca-antiga/sped {arquivos:[{nome, base64}], confirmar?}` devolve `{ arquivos: [{ nome, cnpj, cliente, periodo, saidas, entradas, erro? }], adicionadas?, repetidas?, outroEstado? }`.
  - O cliente vem do CNPJ do 0000, entre os clientes da carteira com certificado.
  - Usa o limite de 64 MB de `/api/importar`.
  - Só no PC local.

- [ ] Testes que falham:
  - entradas e saídas;
  - modelo 65 e chave vazia ignorados;
  - Latin-1;
  - arquivo sem 0000 dá erro;
  - a rota: resumo sem adicionar, `confirmar` adiciona com `origem 'sped'`, CNPJ que não é cliente vira `erro` no arquivo.
- [ ] Implementar e passar. Fazer o commit.

### Tarefa 3: consulta de protocolo e saídas pelo certificado

**Arquivos:**
- `src/sefaz/consultaProtocolo.js` (novo): `montarChave({ uf, aamm, cnpj, serie, numero })`, `lerRetornoConsulta(xml)` → `{ cStat, xMotivo, chaveVerdadeira }` e `criarFabricaConsulta(config)` (com `sefazMock`: 613 até o número `LIMITE_MOCK = 5` acima do último e 217 depois).
- `src/services/saidasPeloCertificado.js` (novo), `src/contexto.js`, `src/servidor.js` (chamar depois do ciclo automático e expor), as rotas e os testes `test/consulta-protocolo.test.js`, `test/saidas.test.js` e `test/web.test.js`.

**Interfaces:**
- `criarSaidas({ db, config, logger, buscaAntiga, fabricaConsulta, dormir, agora })` → `{ listar(), ligar(clienteId, ligado), definirInicio(clienteId, chave), procurar({ clienteId? }) → Promise<resumo>, rodando() }`.
- `listar()` mostra os clientes da carteira com A1 no prazo e UF fora de `SEFAZ_PROPRIA`, com `saidas_auto` e as séries (`saidas_series` mais as séries achadas nas notas onde o cliente é emitente).
- `procurar()`:
  - uma por vez: uma segunda chamada devolve a promessa em curso;
  - por cliente ligado, sem `busca_pausada`, com o certificado lido como na SVRS;
  - por série, parte de `max(ultimo_numero da tabela, maior número nas notas)`;
  - sem número nenhum, a série fica "sem início" e não é consultada;
  - as chaves achadas vão para `buscaAntiga.adicionarChaves(..., { origem: 'saidas' })`, com direção `saida`;
  - grava `ultimo_numero`, `achadas`, `ultima_consulta` e `ultimo_erro` da série.
- **Rotas:**
  - `GET /api/saidas`;
  - `POST /api/saidas/ligar {cnpj, ligado}`;
  - `POST /api/saidas/inicio {cnpj, chave}`, com chave de saída do próprio CNPJ e modelo 55;
  - `POST /api/saidas/procurar` (202, roda em segundo plano).
- **`servidor.js`:** depois de cada ciclo da captura automática, chama `saidas.procurar()`, sem `await` e com `catch` no log.

- [ ] Testes que falham, com fábrica de consulta falsa e `dormir` falso:
  - `montarChave` com o DV certo;
  - `lerRetornoConsulta` lendo 613, 217 e 526 (com respostas gravadas do teste real);
  - acha as chaves seguidas;
  - atravessa um furo;
  - para depois de 20 resultados 217;
  - para no 656 e grava o erro;
  - o 526 marca a série;
  - parte do maior número que o app já tem;
  - não roda com o cliente desligado ou pausado;
  - `procurar` em dobro faz uma só;
  - as chaves vão para a fila com origem `saidas`;
  - as rotas.
- [ ] Implementar e passar. Rodar a suíte inteira e fazer o commit.

### Tarefa 4: tela

**Arquivos:** `painel/src/telas/NotasAntigas.jsx` (reescrita, com o arquivo renomeado para `BuscaPorChave.jsx` e a rota `notas-antigas` mantida), `painel/src/App.jsx`, `painel/src/layout/MenuLateral.jsx` e `painel/src/estilo.css`.

- [ ] Topo: título, linha de andamento com o ponto colorido e Pausar/Continuar tudo.
- [ ] Adicionar com `Segmentado`, em três abas:
  - **Colar:** como hoje;
  - **SPED:** área de soltar, resumo por arquivo e "Colocar na fila";
  - **Saídas:** a lista de clientes com a chave liga/desliga, as séries, o campo "colar uma chave de saída" quando falta início e o botão "Procurar agora".
- [ ] Barra de progresso geral e "faltam ~N min (termina por volta de HH:MM)".
- [ ] Pastas:
  - **empresas:** barra, problemas, estado e Pausar/Continuar da empresa;
  - **dentro da empresa:** NF-e · Entradas e NF-e · Saídas, com as contagens;
  - **dentro da pasta:** filtros com contagem, a lista de duas linhas, o menu ⋯ (Abrir nota, Tentar de novo, Excluir), "Mostrar mais" e marcar e excluir com a fila pausada;
  - a seta sobe uma pasta.
- [ ] Build, a suíte inteira e a conferência no navegador com a demonstração (`SEFAZ_MOCK`, `BUSCA_ANTIGA_INTERVALO_MS=3000`): colar chaves, soltar um SPED de teste, ligar as saídas de um cliente e pausar uma empresa, com prints. Fazer o commit.

### Final

- [ ] Revisão de todo o ramo pelo Fable, com o foco da revisão acima. Corrigir os críticos e importantes com teste. Registrar no cofre.
