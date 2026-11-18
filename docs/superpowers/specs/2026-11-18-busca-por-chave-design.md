# Busca por chave: tela nova, SPED e saídas pelo certificado

Data: 18/11/2026. Parte da aba "Notas antigas" (1.14.0 a 1.14.3).

## Objetivo

A aba vira **"Busca por chave"**: o lugar onde o app baixa NF-e pela chave na SVRS, uma por minuto. Esta versão traz três mudanças:

1. **Tela mais clara.** O usuário vê o andamento, o que já veio e o que deu problema, e reconhece cada nota sem ler os 44 dígitos.
2. **Chaves a partir do SPED.** O usuário solta o arquivo SPED Fiscal do cliente. O app lê a chave de cada NF-e no C100, reconhece o cliente pelo 0000 e põe tudo na fila. Assim dá para buscar notas de anos atrás.
3. **Saídas pelo certificado.** Para clientes com A1, o app descobre as chaves das NF-e de saída pelo número, na consulta de protocolo da SEFAZ (cStat 613 devolve a chave verdadeira), e põe na fila. Alcança os últimos 6 meses.

## O que já foi medido (17–18/11)

- **Consulta de protocolo** (`POST https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx`, `consSitNFe 4.00`), com o certificado do emitente e a chave montada com um código numérico inventado:
  - **613** quando o número existe. O xMotivo termina com a chave verdadeira entre colchetes.
  - **217** quando o número não existe.
  - **526** quando a nota tem mais de 6 meses.
- O mês da chave montada não importa: o 613 devolve a chave com o mês certo.
- Há furos reais na numeração: o 217 aparece no meio da sequência (63170, 63172) e a numeração continua depois.
- Ritmo: cerca de 33 consultas com 2 a 15 s entre elas não deram 656.
- O download da SVRS entrega a nota ao **emitente**. Já baixou saídas da Leitura de 2022 com o certificado dela.
- No SPED, o C100 traz `IND_OPER` (campo 02: 0 entrada, 1 saída), `IND_EMIT` (03: 0 própria, 1 terceiros), `COD_MOD` (05) e `CHV_NFE` (09). O 0000 traz o `CNPJ` (campo 07).

## Fora de escopo

- CT-e (D100) e NFC-e (modelo 65).
- UFs com SEFAZ própria. Elas continuam como "Outro estado".
- Saídas com mais de 6 meses pela descoberta. Essas vêm pelo SPED.

## Tela

```
Busca por chave                                         ● Baixando · próxima em 42 s   [Pausar]
NF-e pela SVRS, uma por minuto

┌ Adicionar ─────────────────────────────────────────────────────────────────────────────┐
│ [Colar chaves] [Arquivo SPED] [Saídas pelo certificado]                                │
│                                                                                         │
│  Colar chaves:  Cliente [ LIVRARIA LEITURA ▾ ]                                          │
│                 ┌───────────────────────────────────────────────┐                       │
│                 │ cole as chaves aqui                            │          [Buscar]     │
│                 └───────────────────────────────────────────────┘                       │
│  Arquivo SPED:  ┌ solte aqui o SPED Fiscal do cliente (.txt) ─┐  → "LIVRARIA LEITURA ·   │
│                 └─────────────────────────────────────────────┘     03/2025 · 412 chaves │
│                                                                      (120 saídas, 292    │
│                                                                      entradas)"          │
│  Saídas pelo certificado: lista de clientes com A1 de UF da SVRS, cada um com            │
│    [ chave liga/desliga ]  Série 1: último nº 63180 · 26 chaves achadas hoje            │
└─────────────────────────────────────────────────────────────────────────────────────────┘

 ███████████████████░░░░░░░░░░  40 de 86 · faltam ~46 min (termina por volta de 15:20)

 [Todas 86] [Na fila 46] [Baixadas 37] [Problemas 3] [Outro estado 0]      [Limpar concluídas]

┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ LIVRARIA LEITURA                                                         86 chaves  ▾     │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ☐  Saída  nº 56363 · 10/10/2025 · R$ 1.234,56 · para SUPPLOG ARMAZENS       Baixada  ⋯   │
│           2325 1020 6915 5200 0109 5500 1000 0563 6310 0067 1393                          │
│ ☐  Entrada  2325 1010 4427 7200 0137 5500 1000 0045 2017 9523 1322         Na fila       │
│ ☐  Entrada  3525 ... (SP)                     Outro estado: peça o XML ao fornecedor      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Topo.**
- O andamento aparece numa linha à direita do título, junto com o botão Pausar ou Continuar.
- O ponto colorido indica o estado: verde quando está baixando, cinza quando está pausado, âmbar quando está esperando a captura ou a SVRS.
- O texto mostra o motivo ou a contagem regressiva.

**Adicionar.** Três abas (`Segmentado`), na ordem Colar chaves · Arquivo SPED · Saídas pelo certificado.
- **Colar chaves:** funciona como hoje.
- **Arquivo SPED:** uma área para soltar o arquivo ou clicar e escolher.
  - O app lê o 0000. Se o CNPJ é de um cliente com certificado, o cliente fica escolhido sozinho e a área mostra "CLIENTE · mês/ano · N chaves (X saídas, Y entradas)" com o botão "Colocar na fila".
  - Se o CNPJ não é de cliente, aparece "O SPED é do CNPJ … , que não está nos clientes com certificado".
  - Vários SPED soltos juntos (vários meses) somam.
- **Saídas pelo certificado:** uma lista dos clientes da carteira com A1 no prazo e UF da SVRS.
  - Cada cliente tem uma chave liga/desliga, que começa desligada.
  - Ao lado vai o resumo por série: "Série 1: último nº 63180 · 26 chaves achadas" ou "Sem saída no app: cole uma chave de saída para começar", com um campo para colar.
  - A descoberta roda sozinha.

**Barra de progresso.**
- A barra mostra "baixadas + já existiam + ... / total", sem animação.
- O tempo que falta é calculado como pendentes × intervalo atual.

**Filtros (dentro da pasta da empresa e direção).** Botões com contagem no lugar do select: Todas, Na fila, Baixadas, Problemas (erro + não envolvido) e Outro estado.

**Fila em pastas** (pedido de 18/11, igual à navegação da tela Notas: a seta de voltar sobe uma pasta):

```
 Fila de downloads
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ 📁 LIVRARIA LEITURA     ████████░░  40 de 86 · 3 problemas        Baixando  [Pausar] │
 │ 📁 LEITURA FORTALEZA    ██░░░░░░░░   2 de 20                      Pausado [Continuar]│
 │ 📁 INOX                 ██████████  12 de 12                      Concluído          │
 └────────────────────────────────────────────────────────────────────────────────────┘
 ← LIVRARIA LEITURA                                                            [Pausar]
   📁 NF-e · Entradas   292 (250 baixadas · 2 problemas)
   📁 NF-e · Saídas     120 (90 baixadas · 1 problema)
 ← LIVRARIA LEITURA / NF-e · Saídas
   (a lista de notas abaixo, com filtros por situação)
```

- **Primeiro nível, uma linha por empresa (pasta):**
  - nome da empresa;
  - barra com "baixadas de total" e a contagem de problemas;
  - estado: Baixando (a vez dela agora), Na fila, Pausado ou Concluído;
  - botão **Pausar/Continuar só daquela empresa**.
- **Dentro da empresa:** uma pasta por tipo e direção, hoje **NF-e · Entradas** e **NF-e · Saídas**, com as contagens. Se um dia entrar outro tipo, ele vira mais uma pasta aqui.
- **Dentro da pasta:** a lista de notas, com os filtros de situação.
- **Pausa por empresa:** coluna nova `busca_pausada` em `clientes`, com padrão 0. A fila pula as linhas das empresas pausadas e segue com as outras. Pausar no meio de uma consulta deixa ela terminar.
- **Pausar tudo:** o botão do topo da tela continua pausando a fila inteira.
- **Rota:** `POST /api/busca-antiga/cliente-pausa { cnpj, pausada }`.
- **`estado`** traz o resumo por cliente: `clientes: [{ cnpj, nome, total, baixadas, problemas, pendentes, pausada, daVez }]` e, por cliente, a contagem por direção.

**Lista (dentro da pasta).**
- A lista vem do cliente e da direção escolhidos.
- Cada linha tem duas partes:
  - **Linha 1:** a direção e a situação. Para a nota baixada, também número, data, valor e "para"/"de" com o nome da outra parte.
  - **Linha 2:** a chave em blocos de 4, menor e apagada.
- A direção é calculada pela chave: CNPJ do emitente igual ao do cliente é Saída, senão Entrada.
- **Menu ⋯ por linha:**
  - "Abrir nota", quando a nota foi baixada: leva ao detalhe da nota;
  - "Tentar de novo", quando a linha está em erro ou não envolvido;
  - "Excluir".
- **Marcar e excluir marcadas:** continua com a fila pausada.
- **Problemas:** a mensagem fica em texto curto e claro, e o texto da SVRS completo fica no balão do mouse.
- O texto e a cor de cada situação continuam os de hoje.

## Fila e dados

- **Colunas novas em `busca_antiga`:**
  - `origem`: `colada`, `sped` ou `saidas`;
  - `direcao`: `entrada` ou `saida`, calculada pela chave na hora de adicionar.
- **`listar`:**
  - Junta os dados da nota pelo `cliente_id` e pela chave na tabela `notas`: número, data de emissão, valor total, CNPJ e nome da outra parte.
  - Ordem: pendentes primeiro, depois por id decrescente.
  - Mais de 500 linhas: a página carrega por blocos com "Mostrar mais".
- **`estado`** passa a trazer a contagem por situação (`contagens: { fila, baixada, 'ja-existia', 'nao-envolvido', 'nao-nfe', 'outro-estado', erro }`) e `estimativaS`.
- **`tentarDeNovo(ids)`** devolve para a fila as linhas em `erro` ou `nao-envolvido`.

## SPED

- **`src/services/chavesDoSped.js`:** `lerChavesDoSped(texto) → { cnpj, periodo: 'AAAA-MM', chaves: [{ chave, direcao }] }`.
  - Lê linhas `|0000|` e `|C100|`, com o separador `|` e o texto em Latin-1.
  - Só entra C100 com `COD_MOD` 55 e chave de 44 dígitos.
  - A direção vem de `IND_OPER`: 0 é entrada, 1 é saída.
- **Rota `POST /api/busca-antiga/sped`:**
  - Recebe `{ arquivos: [{ nome, base64 }] }` e devolve o resumo por arquivo (cliente, período e contagens) sem colocar nada na fila.
  - Com `confirmar: true`, adiciona as chaves com `origem = 'sped'`.
  - Limite de 64 MB, só no PC local.
- O cliente é o da carteira com o CNPJ do 0000 e com certificado. Sem cliente, a rota avisa e não adiciona.

## Saídas pelo certificado

- **Coluna nova em `clientes`:** `saidas_auto` (INTEGER, padrão 0).
- **Tabela nova `saidas_series`:**

  ```sql
  saidas_series (cliente_id, serie, ultimo_numero, achadas, ultima_consulta, ultimo_erro, PRIMARY KEY (cliente_id, serie))
  ```

  - **De onde vem a série:** das notas do cliente como emitente (`modelo = 'nfe'`, `emitente_cnpj = cnpj`, série e número máximos) ou de uma chave colada.
- **`src/sefaz/consultaProtocolo.js`:** `consultarChave({ pfx, passphrase, chave }) → { cStat, xMotivo, chaveVerdadeira? }`.
  - Envia para a SVRS. A chave verdadeira é tirada de `[(\d{44})]` no xMotivo do 613.
  - Usa o agente de `certificado.js` com a cadeia ICP-Brasil.
- **Serviço `src/services/saidasPeloCertificado.js`:**
  - **Quando roda:** num ciclo próprio, depois da captura automática nos horários, e pelo botão "Procurar agora" da aba.
  - **Para cada cliente ligado e cada série:**
    - Monta a chave do número `ultimo_numero + 1`, com o mês atual e `cNF = 12345678`, e consulta.
    - **613:** guarda a chave verdadeira, avança `ultimo_numero` e zera a contagem de 217 seguidos.
    - **217:** soma um aos 217 seguidos e avança o número que está sendo testado, sem mudar `ultimo_numero` enquanto não achar outra nota.
    - **Parada:** com 20 resultados 217 seguidos, para essa série até o próximo ciclo.
    - **656:** para tudo e grava o erro. O próximo ciclo tenta de novo.
    - **526:** marca a série como "fora dos 6 meses".
  - **Intervalo:** 2 s entre as consultas. Fica em `config.saidasIntervaloMs`, que vale abaixo de 2 s só na simulação.
  - **Destino das chaves achadas:** vão para a fila com `origem = 'saidas'` e `direcao = 'saida'`. Quem já está na fila conta como repetida, e quem já está no app vira "já existia" quando chegar a vez.
- Não roda enquanto houver captura nem durante a troca de pasta. São os mesmos `podeRodar` da fila.

## Nome

- **Menu:** "Busca por chave", ícone `fa-magnifying-glass`. A rota `#/notas-antigas` continua respondendo.
- **Título:** "Busca por chave". **Subtítulo:** "NF-e pela SVRS, uma por minuto".

## Testes

- **`lerChavesDoSped`:**
  - entradas e saídas;
  - ignora modelo 65 e chave vazia;
  - acha o CNPJ do 0000;
  - lê arquivo em Latin-1.
- **Rota SPED:**
  - resumo sem adicionar;
  - com `confirmar`, adiciona;
  - CNPJ que não é cliente é recusado.
- **`consultarChave`:** lê o 613 com a chave entre colchetes, o 217 e o 526 a partir de respostas gravadas.
- **Descoberta de saídas, com SEFAZ falsa e temporizador falso:**
  - acha as chaves seguidas;
  - atravessa furos;
  - para depois de 20 resultados 217 seguidos;
  - para no 656;
  - parte do maior número que o app já tem;
  - não roda com o cliente desligado.
- **`listar`:**
  - traz os dados da nota baixada;
  - traz a direção;
  - as contagens por situação batem.
- **`tentarDeNovo`.**
- **Pausa por empresa:**
  - a fila pula a empresa pausada e baixa a próxima;
  - continuar volta a baixar;
  - o resumo por cliente traz `pausada` e `daVez`.
- **Tela:** conferida no navegador com a demonstração (`SEFAZ_MOCK`). A SVRS falsa também responde à consulta de protocolo: devolve 613 para os números até um limite e 217 depois dele.
