# Buscar notas antigas (NF-e pela SVRS)

Data: 12/11/2026. Depende do Importar com NF-e e CT-e (versão 1.13.0).

## Objetivo

Trazer NF-e que já passaram da janela de cerca de 90 dias da distribuição da SEFAZ (cStat 632). O usuário escolhe um cliente com certificado e cola as chaves. O app baixa cada nota pelo portal DF-e da SVRS com o certificado desse cliente, uma por minuto, em segundo plano, e passa cada XML pelo Importar, que o organiza como uma nota capturada.

## O que já foi medido (12/11)

- `POST https://dfe-portal.svrs.rs.gov.br/NfeSSL/DownloadXmlDfe` funciona com TLS de cliente (certificado A1). O corpo vai como `application/x-www-form-urlencoded` com estes campos: `sistema=Nfe`, `OrigemSite=0`, `Ambiente=1`, `ChaveAcessoDfe=<44 dígitos>`. Não há token nem cookie, e não há captcha.
- Quando a nota é encontrada, a resposta (HTML, status 200) traz `var stringJson = { "xml": "<nfeProc ...>" };`. O `xml` é o `nfeProc` completo com `protNFe`. Já baixou NF-e de 10 e 12/2022.
- Quando não é, não vem `stringJson`. O motivo aparece no texto da página logo depois de "Consulta realizada em : <data>". Respostas vistas:
  - "CNPJ base do certificado digital (CNPJ8) informado difere do CNPJ base dos envolvidos (CNPJ8)." O certificado não é de quem participou da nota.
  - "IP não autorizado devido múltiplas consultas". Limite de frequência: 17 s e 30 s entre consultas já bloqueiam, 60 s não bloqueou em 5 consultas seguidas, e o bloqueio passa em menos de uns 5 minutos.
- Há manutenção programada aos domingos, das 7h às 9h.
- Ainda não se sabe se a SVRS entrega nota autorizada por outra UF. Se ela recusar, a chave fica como erro, com o texto da SVRS.

## Fora de escopo

- CT-e, que na SVRS usa outro sistema. NFC-e e qualquer modelo diferente de 55.
- Ler as chaves de um arquivo SPED. Só chaves coladas.
- Cliente sem certificado próprio. O procurador não serve aqui.
- Usar o certificado de outro cliente quando o escolhido não é envolvido na nota.

## Tela

Uma aba nova, **"Notas antigas"**, logo abaixo de "Importar XMLs" no menu lateral. Rota `#/notas-antigas`, ícone `fa-clock-rotate-left`. Título "Notas antigas", subtítulo "NF-e com mais de 90 dias, pela SVRS".

- **Adicionar:**
  - Um seletor de cliente, que lista só a carteira com certificado (`cert_arquivo <> ''`), por nome. Abaixo dele, uma caixa de texto: "Cole as chaves de acesso (uma por linha ou como vierem)".
  - O botão **Buscar** coloca as chaves na fila. O app pega toda sequência de exatamente 44 dígitos no texto, tirando antes os espaços dentro dela (chave formatada em blocos de 4 também vale), e ignora repetidas.
  - A resposta aparece embaixo, por exemplo: "30 chaves na fila (2 repetidas ignoradas)".
- **Andamento:** uma linha no topo da lista.
  - Mostra o que está acontecendo: "12 de 200 · próxima em 45 s", ou "Pausado", ou "Esperando a captura terminar", ou "SVRS pediu pausa: volta às 14:30".
  - Tem um par de botões, com a ação afirmativa à direita: **Limpar concluídas · Pausar** (ou **Continuar** quando está pausado).
- **Lista:**
  - Uma linha por chave: cliente, a chave formatada em blocos de 4, situação e mensagem.
  - As mais recentes ficam primeiro, até 500 linhas, com um filtro por situação ("Todas" e cada situação).
  - Sem animação. A tela se atualiza a cada 5 s enquanto houver fila.

## Situações

| situacao | Texto na tela | Quando |
|---|---|---|
| `fila` | Na fila | ainda não consultada |
| `baixada` | Baixada | XML veio e o Importar gravou (entrada ou saída) |
| `ja-existia` | Já estava no Smart Fiscal | o cliente já tinha a chave como `completa` com o arquivo no disco, verificado antes de consultar e de novo depois de baixar |
| `nao-envolvido` | Certificado não é de envolvido | resposta "difere do CNPJ base dos envolvidos" |
| `nao-nfe` | Não é NF-e | chave com modelo (posições 21–22) diferente de 55, marcada ao colar sem consultar |
| `erro` | Erro | qualquer outra resposta, ou erro do Importar; a mensagem traz o texto da SVRS ou o motivo do Importar |

- **Novas tentativas:** um `erro` de rede, um HTTP 5xx ou uma página sem `stringJson` e sem motivo reconhecido voltam para a fila, até 3 tentativas no total. Depois disso a chave fica em `erro`. O bloqueio por "múltiplas consultas" não conta como tentativa.
- **Erro do Importar:** se o XML veio mas o Importar o recusou (por exemplo `sem-protocolo` ou `homologacao`), a chave vai direto para `erro` com o motivo traduzido, sem nova tentativa.

## Fila (banco)

Tabela nova `busca_antiga`:

```sql
CREATE TABLE IF NOT EXISTS busca_antiga (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  chave TEXT NOT NULL,
  situacao TEXT NOT NULL DEFAULT 'fila',
  mensagem TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT,
  UNIQUE(cliente_id, chave)
);
```

- **Chave repetida:** colar de novo uma chave que já está na tabela para o mesmo cliente não cria linha nova. Se ela estava em `erro` ou `nao-envolvido`, volta para `fila` com `tentativas = 0`. Nos outros casos fica como está e conta como repetida.
- **Estado do serviço:** o estado "pausado pelo usuário" fica na tabela `sistema` (`busca_antiga_pausada = '1'`) e sobrevive a fechar o app. O intervalo atual e o "volta às" ficam só em memória.
- **Limpar concluídas:** apaga as linhas `baixada`, `ja-existia` e `nao-nfe`. As de `erro` e `nao-envolvido` ficam para o usuário ver.

## Ritmo

- **Ordem:** uma consulta por vez, a mais antiga da fila primeiro (`ORDER BY id`).
- **Intervalo:** 60 s entre o fim de uma consulta e o início da próxima, cronometrado por `setTimeout`. Chave que já existia antes da consulta não espera, porque não houve consulta.
- **"Múltiplas consultas":** a fila para 5 minutos e o intervalo sobe 30 s, até no máximo 180 s. Depois de 20 consultas seguidas sem bloqueio, o intervalo desce 15 s, até no mínimo 60 s.
- **Quando não roda:** com pausa do usuário, durante uma captura, durante a troca da pasta principal ou sem a pasta principal escolhida. Nesses casos a fila verifica de novo a cada 30 s. O motivo aparece no andamento.
- **Ao abrir o app:** a fila começa 60 s depois que o servidor sobe, se houver chaves em `fila` e não estiver pausada.
- **Fim da fila:** o timer para e volta quando chegam chaves novas.

## Fluxo de uma chave

1. Lê o cliente. Se o certificado não existe mais ou está vencido, a chave fica em `erro` ("Certificado do cliente indisponível" ou "Certificado vencido").
2. Se o cliente já tem a nota `completa` com o arquivo no disco, a chave vira `ja-existia`.
3. Chama `baixarNfe({ pfx, senha, chave })`, que devolve `{ xml } | { motivo: 'nao-envolvido' | 'bloqueado' | 'erro', mensagem }`.
4. Se veio o XML, chama `importacao.importar([{ nome: '<chave>-nfe.xml', bytes }], { soDaCarteira: true })`. Se houve nota importada, a chave vira `baixada`. Se houve "já existia", vira `ja-existia`. Se o Importar ignorou o arquivo, vira `erro` com o motivo dele.
5. Se o Importar gravou alguma nota, agenda o organizador (`conferirArquivos: true`) para gerar o PDF e os relatórios.

## Código

- `src/sefaz/svrs.js` (novo)
  - `criarClienteSvrs({ pfx, passphrase, fetch? })` → `{ baixarNfe(chave) }`.
  - O agente HTTPS é montado com o node-forge, o mesmo de `adn.js` (`agenteDoCertificado`). A função passa para um módulo comum, `src/sefaz/certificado.js`, e é reaproveitada.
  - Timeout de 60 s.
  - O parser da página é uma função pura exportada, `lerRespostaSvrs(html)`, para os testes.
  - `criarFabricaSvrs(config)` devolve uma SVRS falsa quando `config.sefazMock`: ela entrega um `nfeProc` gerado para as chaves cujo emitente é cliente de demonstração e responde "difere do CNPJ base" para as outras.
- `src/services/buscaAntiga.js` (novo)
  - `criarBuscaAntiga({ db, config, logger, importacao, fabricaSvrs, podeRodar, aoImportar, agora, temporizador })` → `{ adicionar(clienteId, texto), estado(), listar({ situacao }), pausar(), continuar(), limparConcluidas(), iniciar(), parar() }`.
  - `podeRodar()` devolve `null` ou o motivo de não rodar. `temporizador` vem injetado (`setTimeout`/`clearTimeout`) para os testes rodarem sem esperar.
- `src/db/migrations.sql`: a tabela `busca_antiga`.
- `src/contexto.js`: expõe `ctx.buscaAntiga`.
- `src/servidor.js`: liga `podeRodar` (pasta escolhida, sem troca de pasta, sem captura) e `aoImportar` (agenda o organizador) e chama `iniciar()`.
- `src/web/server.js`, rotas só no PC local:
  - `GET /api/busca-antiga?situacao=` devolve `{ estado, linhas }`.
  - `POST /api/busca-antiga` com `{ cnpj, texto }` devolve `{ adicionadas, repetidas, naoNfe }`. Dá 400 sem chave válida e 404 para cliente desconhecido ou sem certificado.
  - `POST /api/busca-antiga/pausar`, `/continuar` e `/limpar`.
- `painel/src/telas/NotasAntigas.jsx`, a rota em `App.jsx` e o item em `MenuLateral.jsx`.

## Testes (node:test, sem rede)

- `lerRespostaSvrs` com estas respostas: página com `stringJson` (devolve o XML), "difere do CNPJ base" (`nao-envolvido`), "múltiplas consultas" (`bloqueado`), página sem nenhum dos dois (`erro` com o texto depois de "Consulta realizada em").
- `adicionar`:
  - pega chaves no meio de texto, com espaços e em blocos de 4;
  - ignora repetidas;
  - marca `nao-nfe` para modelo 65;
  - devolve para a fila a chave que estava em `erro`.
- Fluxo, com uma SVRS falsa e um temporizador falso:
  - a chave baixada é importada e vira `baixada`, e a nota fica no banco com `origem='importada'`;
  - a chave que o cliente já tem completa vira `ja-existia` sem chamar a SVRS;
  - "difere" leva a `nao-envolvido`;
  - "bloqueado" causa pausa de 5 min, intervalo de 90 s, e a chave continua na fila sem contar tentativa;
  - erro de rede faz 3 tentativas e depois `erro`;
  - a fila não roda quando `podeRodar` devolve um motivo, nem quando está pausada, e a pausa sobrevive a recriar o serviço;
  - intervalo de 60 s entre as consultas.
- Rotas: adicionar, listar, pausar e continuar, limpar, e o 404 de cliente sem certificado.
