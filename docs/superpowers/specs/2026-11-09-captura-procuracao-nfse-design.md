# Captura de NFS-e por procuração — design

Data: 2026-11-09
Projeto: Smart Fiscal
Escopo: **NFS-e somente**. NF-e e CT-e não têm esse mecanismo.

## Objetivo

Capturar a NFS-e de clientes **sem certificado próprio** usando um único
**certificado procurador** (o e-CPF do dono do escritório), em que a Receita
reconhece procuração eletrônica para esses CNPJs no portal nacional.

Comprovado em 09/11 contra o ADN de produção (consultas só de leitura, NSU 0):
o e-CPF do procurador trouxe as NFS-e de três filiais sem certificado (10, 50 e
11 documentos) e o ADN recusou um CNPJ sem procuração com `HTTP 400 E2245 Não
há procuração da inscrição <CPF> para a inscrição <CNPJ>`. Ou seja, o ADN já
entrega por procuração quando se manda `cnpjConsulta` = CNPJ do cliente
assinando com o certificado do procurador.

Resolve o caso dos clientes sem A1 para NFS-e sem download manual no gov.br
(que tem hCaptcha por nota). As saídas de NF-e desses clientes seguem pelo
autXML do escritório; NF-e/CT-e de entrada continuam exigindo o A1 do cliente.

## Como funciona hoje (base)

- `fabricaAdn(cliente)` (`src/sefaz/adn.js`) abre `cliente.cert_arquivo` +
  `cliente.cert_senha_enc` e monta o cliente do ADN; a consulta já manda
  `cnpjConsulta = cliente.cnpj`.
- O ciclo (`src/services/ciclo.js`) só lista clientes com `cert_arquivo <> ''`;
  quem está sem certificado fica fora de toda captura.
- A única troca necessária é **qual certificado assina** a consulta de NFS-e de
  quem não tem o próprio, e **deixar esses clientes entrarem** só na NFS-e.

## Decisões

- **Um único procurador.** Quem não tiver procuração nele é pulado com aviso.
- **Só para quem não tem certificado próprio.** Cliente com A1 continua sendo
  consultado com o dele, sem mudança.
- **Entram na busca automática de NFS-e** nos mesmos horários, respeitando o
  `auto_nfse` de cada cliente. NF-e e CT-e nunca rodam para quem não tem A1.
- **Cadastro na tela Escritório**, num cartão "Certificado procurador".

## Guardar o procurador

Um certificado só, à parte do escritório (a procuração é do CPF do dono, não do
CNPJ do escritório). Sem mudança de esquema: arquivo em disco + linhas em
`sistema` (a tabela chave/valor já usada por backup, automação e pastas).

- Arquivo: `pastaCerts/procurador.pfx` (mesmo padrão de `gravarPfx`: tmp +
  rename, modo 0600).
- `sistema`: `procurador_senha_enc` (senha criptografada com a master key),
  `procurador_titular` (CN do certificado), `procurador_validade` (ISO).
- Aceita **e-CPF**: `lerCertificado` já devolve `titular` e `validade` mesmo
  quando `cnpj` é nulo. A validação do procurador recusa só o certificado
  **vencido**; não exige casar com nenhum CNPJ (ao contrário de
  `validarCertificado`, que é para o A1 de uma empresa).

## Serviço (`src/services/clientes.js`)

- `salvarProcurador({ pfx, senha })` → lê o certificado (senha errada / arquivo
  inválido lançam as mensagens de hoje), recusa se vencido, grava o `.pfx` e as
  três linhas em `sistema`. Devolve `{ titular, validade }` (sem segredo).
- `removerProcurador()` → apaga o arquivo e as linhas.
- `obterProcurador()` → `{ titular, validade, diasParaVencer } | null` (público).
- `lerProcuradorCert()` (interno) → `{ pfx: Buffer, passphrase: string } | null`
  lendo o arquivo e descriptografando a senha; é o que a captura usa.

## Escolha do certificado (`src/sefaz/adn.js`, `src/contexto.js`)

`criarFabricaAdn(config, obterProcurador)` ganha um segundo argumento: uma
função que devolve `{ pfx, passphrase } | null` (ligada a `lerProcuradorCert`
em `contexto.js`, avaliada a cada chamada para refletir troca/remoção).

`fabricaAdn(cliente)`:
1. `cliente.cert_arquivo` existe → usa o A1 do cliente (como hoje).
2. Senão, `obterProcurador()` devolve um certificado → monta o cliente do ADN
   com o **certificado procurador** e `cnpjConsulta = cliente.cnpj`.
3. Senão → o "Certificado indisponível" de hoje.

`cnpjConsulta` continua sendo o CNPJ do cliente (14 dígitos da filial inclusive;
foi assim no teste). O mock (`config.sefazMock`) não muda.

## Entrar na captura (`src/services/ciclo.js`)

- Com procurador cadastrado, a lista de clientes do ciclo passa a incluir os
  **ativos, papel `cliente`, sem `cert_arquivo`** (hoje excluídos). Sem
  procurador, nada muda.
- Guarda por cliente em `executarCiclo`: um cliente sem `cert_arquivo` roda
  **só NFS-e** (`comNfe` e `comCte` ficam falsos para ele); `comNfse` vale se
  `auto_nfse` permite e há procurador. Quem tem A1 segue igual.
- Captura manual de um CNPJ sem A1 (`escolher`/`/api/captura`): deixa de dar o
  erro "sem certificado" quando há procurador, e roda só NFS-e.

## Erro claro (E2245)

`adn.js` já devolve `HTTP 400: E2245 Não há procuração...`. A captura de NFS-e
detecta o código `E2245` no erro e grava em `nfse_ultimo_erro` a frase **"Sem
procuração para este cliente no certificado procurador."**. O cliente aparece
com esse aviso (como qualquer erro de NFS-e) e o ciclo segue nos demais.

## Rotas (`src/web/server.js`)

Espelham as do escritório, **só no PC local** (acrescentar `procurador` ao
`ROTA_CERTIFICADO`, que já exige PC local e abre o corpo maior do `.pfx`):

- `GET /api/procurador` → `obterProcurador()` ou `{ procurador: null }`.
- `POST /api/procurador/certificado` → `salvarProcurador`; 400 nas mensagens de
  certificado; 200 com `{ titular, validade }`.
- `POST /api/procurador/remover` → `removerProcurador`.

## Tela (`painel/src/telas/Escritorio.jsx`)

Cartão **"Certificado procurador"** abaixo do escritório:
- Sem procurador: texto curto ("Para puxar a NFS-e de clientes sem certificado,
  cadastre aqui o certificado com procuração no portal nacional.") + enviar
  `.pfx`/`.p12` e senha.
- Com procurador: titular, validade (e aviso se vence em < 30 dias), botões
  Trocar e Remover.
- Visual enxuto, sem animação; reaproveita o componente de upload de
  certificado já usado no escritório.

Em Clientes, a coluna Certificado de um cliente sem A1 mostra **"pelo
procurador"** quando há procurador (em vez de só "Sem certificado"); sem
procurador, segue "Sem certificado". (Ajuste pequeno, sem tela nova.)

## Erros e casos de borda

- Procurador vencido no cadastro → recusado com a data.
- Procurador vence durante o uso → o ADN recusa; a captura mostra o erro do ADN.
  (Não entra no quadro de certificados do Início, que é dos clientes.)
- Cliente sem A1 e sem procurador → fora da captura, como hoje.
- Cliente com A1 → nunca usa o procurador.
- Remover o procurador → os clientes sem A1 voltam a ficar fora da captura.
- O procurador não vira "cliente" nem aparece em Notas; é só um certificado.
- Não captura NF-e/CT-e por procuração em nenhum caso.

## Testes (TDD)

- `test/adn.test.js` (ou novo `test/procurador.test.js`): `fabricaAdn` usa o A1
  do cliente quando existe; usa o procurador quando o cliente não tem A1 e há
  procurador, com `cnpjConsulta` do cliente; cai no "indisponível" sem nenhum.
- `clientes`: `salvarProcurador` grava arquivo + linhas em `sistema` e recusa
  certificado vencido; aceita e-CPF (sem CNPJ); `removerProcurador` limpa;
  `obterProcurador` sem segredo.
- `ciclo`: cliente sem A1 com procurador roda **só NFS-e** no ciclo automático
  (respeita `auto_nfse`), não roda NF-e nem CT-e; sem procurador, continua fora;
  captura manual de um CNPJ sem A1 roda NFS-e com procurador e erra sem ele.
- `capturaNfse`: erro `E2245` do ADN vira a frase clara e o ciclo segue.
- `web`: as três rotas de procurador só no PC local; `GET` devolve a info.
- Mock do ADN: um CNPJ configurado "sem procuração" devolve o 400 E2245.

## Fora de escopo

- Vários procuradores; achar automaticamente qual procurador tem cada cliente.
- NF-e e CT-e por procuração.
- Procuração para o próprio escritório (e-CNPJ) — cabe no mesmo cadastro se o
  dono preferir o e-CNPJ, mas não é um fluxo à parte.
- Mostrar a validade do procurador no quadro Certificados A1 do Início.

## Sem dependência nova.
