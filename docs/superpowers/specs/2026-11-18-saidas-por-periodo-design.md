# Saídas por período: CNPJ e meses, sem colar chave

Data: 18/11/2026. Continua a "Busca por chave" (`2820307`..`327ee7d`, ainda sem push).

## Objetivo

Na aba **Saídas pelo certificado**, o usuário escolhe a empresa e um intervalo de meses. O app acha sozinho as NF-e de saída emitidas nesses meses e põe as chaves na fila da Busca por chave, em **Empresa → NF-e · Saídas**. Nenhuma chave é colada.

As notas baixadas seguem o caminho de sempre (importação): banco, pasta `Empresa\Ano\MM-Mês\NF-e\Saidas\`, PDF, relatório e Excel do mês.

O interruptor automático, que segue as saídas novas depois de cada captura, também deixa de exigir uma nota de saída para começar.

## Limites (de fora do app)

- Só **NF-e (modelo 55) de saída**.
- Só **clientes com certificado A1 no prazo** e de **estado atendido pela SVRS**: a mesma regra de `saidas.listar()`. Sem o certificado do emitente, a SVRS não entrega o XML.
- Só os **últimos 6 meses**. A consulta de protocolo dá 526 para nota mais antiga. Antes disso, só pelo SPED.
- O download segue **1 nota por minuto**. Achar as chaves leva cerca de 2 s por número. A tela mostra a estimativa do download antes de confirmar.

## O que a consulta diz (medido em 17–18/11)

Para a chave montada com o número `n` e um código numérico inventado:

- **613**: o número existe. A chave verdadeira volta no xMotivo e traz o AAMM da emissão (posições 3 a 6).
- **526**: o número existe, mas a nota tem mais de 6 meses.
- **217**: o número não existe. Pode ser o fim da numeração ou um furo (número inutilizado).
- **656**: consumo indevido. Para tudo até o próximo ciclo.
- Qualquer outro cStat ou erro de rede: para o pedido e grava o erro.

A numeração sobe com o tempo dentro de uma série. Por isso "mês da nota" é crescente em `n`, e as buscas abaixo são binárias.

## Como acha o trecho do período

Para uma série `s` e os meses `de` e `ate` (AAMM):

1. **Último número emitido (`U`).**
   - O ponto de partida é o maior número conhecido (maior número da série em `notas` com o cliente emitente, ou `saidas_series.ultimo_numero`). Sem nenhum, começa do 1.
   - O app sobe dobrando a distância (`p`, `p+1`, `p+2`, `p+4`, `p+8`…) até dar 217. Depois faz a busca binária entre o último que existe e o primeiro 217.
   - Ao achar o candidato, testa os 5 números seguintes. Se algum existir, era um furo, e a busca continua dali.
   - Se o 1 der 217 e os 5 seguintes também, a série não tem notas: o resultado é "nenhuma nota nesta série".
2. **Primeiro número do período (`P`)**: o menor `n` em `[1, U]` com mês ≥ `de`. O 526 conta como "antes".
3. **Último número do período (`F`)**: o maior `n` em `[P, U]` com mês ≤ `ate`.
4. **Furo no meio da busca binária:** quando o ponto testado dá 217, o app usa o primeiro número que existe entre os 5 seguintes. Se nenhum existir, usa o primeiro que existe entre os 5 anteriores. Se também não houver, o pedido para com "numeração com furo grande perto do nº X".
5. Se `P` não existir (todas as notas são de antes de `de`, ou a série acabou antes), o resultado é "nenhuma nota no período".

Cada passo faz cerca de 20 a 30 consultas, a 2 s cada: de 1 a 2 minutos ao todo.

**Aviso de janela:** se `de` é o mês mais antigo da janela e o número logo antes de `P` deu 526, a tela avisa "parte de MM/AAAA ficou fora (mais de 6 meses)".

## Depois de confirmar

- Cada pedido vira uma linha em **`saidas_periodos`**:
  - `id`, `cliente_id`, `serie`, `de_aamm`, `ate_aamm`;
  - `primeiro` (`P`), `ultimo` (`F`), `proximo` (o próximo número a consultar);
  - `achadas`, `situacao` (`na-espera` | `procurando` | `concluido` | `erro`), `erro`, `criado_em` e `atualizado_em`.
- O trabalho em segundo plano consulta de `proximo` até `F`, a cada 2 s:
  - **613** com mês dentro do período: a chave entra na fila com direção `saida` e origem `periodo`. A que já está no app ou na fila é pulada (`adicionarChaves` já ignora repetidas).
  - **217**: furo, segue em frente.
  - **656**: grava, para tudo e retoma no próximo ciclo a partir de `proximo`.
  - Outro erro: o pedido fica em `erro`, com a mensagem.
  - `proximo` é gravado a cada consulta. Se o app fechar, continua de onde parou.
- **Uma procura por vez para o app inteiro**, entre pedidos de período e saídas automáticas (o mesmo `emCurso` de `saidasPeloCertificado`).
  - O pedido novo entra como `na-espera` e roda quando a vez chegar.
  - A procura roda depois de cada ciclo de captura e logo depois de "Buscar" ou "Colocar na fila".
- **Pausar** a empresa ou a fila inteira, e **fechar o app**, param o trabalho entre uma consulta e outra (o mesmo `interromper`).
- Ao fim do período (`proximo > F`), o pedido fica `concluido`.

## Interruptor automático sem nota de partida

A empresa ligada que não tem nenhuma série conhecida faz o passo 1 para a série 1. Ela grava `U` em `saidas_series` e segue dali para a frente, como hoje. O passado não é preenchido; para isso existe o pedido por período. O campo "cole a chave de uma saída recente" continua para outras séries.

## Tela (aba Saídas pelo certificado)

```
Buscar por período
  Empresa [ LIVRARIA LEITURA ▾ ]   De [ 06/2026 ▾ ]   Até [ 08/2026 ▾ ]   Série [ 1 ]   [Buscar]

  Série 1: nº 1.040 a 1.351 · ~312 notas · download ~5 h 10 min        [Cancelar] [Colocar na fila]

Pedidos
  LIVRARIA LEITURA · 06 a 08/2026 · série 1     achando chaves · 120 de 312     
  PAPELARIA X      · 09/2026 · série 1          na espera

Seguir as saídas novas depois de cada captura
  (interruptores por empresa, como hoje)
```

- **Empresa:** um select com busca. Mostra só as empresas que `saidas.listar()` devolve.
- **De e Até:** só os meses da janela, do mês atual menos 5 até o mês atual. Até ≥ De.
- **Série:** 1 por padrão. Só dígitos, de 0 a 999.
- **Buscar** faz os passos 1 a 3 e mostra o resultado. Enquanto busca, mostra "Procurando o período… (1–2 min)", e o botão fica desabilitado.
  - Se outra procura estiver rodando, o pedido entra direto na lista com "na espera", sem o passo de confirmar. Quando a vez chegar, o app acha `P` e `F`, grava os dois no pedido e já começa a pôr as chaves na fila. A linha do pedido passa a mostrar o trecho e a estimativa.
- **Colocar na fila** grava o pedido e começa o trabalho. **Cancelar** descarta o resultado.
- **Pedidos:** a lista de `saidas_periodos` que não estão concluídos, mais os concluídos dos últimos 7 dias. Cada linha tem o botão "Excluir pedido", que não mexe nas chaves que já entraram na fila. Atualiza a cada 3 s enquanto algum estiver procurando.
- **Estimativa do download:** (`F − P + 1` mais as chaves que já estão na fila de downloads) × 1 min, no formato "~5 h 10 min".

## API

- `POST /api/saidas/periodo { cnpj, de, ate, serie }`:
  - devolve `{ serie, primeiro, ultimo, estimadas, foraDaJanela }` ou `{ nenhuma: true, motivo }`;
  - responde **202** `{ naEspera: true, id }` quando outra procura está rodando;
  - responde **400** para mês fora da janela, Até < De, série inválida ou empresa que não pode usar.
- `POST /api/saidas/periodo/confirmar { cnpj, de, ate, serie, primeiro, ultimo }` → 201 `{ id }`.
- `GET /api/saidas` passa a trazer também `periodos: [...]`.
- `DELETE /api/saidas/periodo/:id` → 204.

Todas usam a mesma checagem de pedido local (`exigirLocalBusca`) das rotas da Busca por chave.

## Código

- `src/services/saidasPeloCertificado.js`: `acharUltimo`, `acharPeriodo` e `procurarPeriodos`, além de `procurar()` rodando os pedidos depois das séries automáticas. Usa os mesmos `esperarVez`, `interromper` e `emCurso`.
- `src/db/migrations.sql`: tabela `saidas_periodos`.
- `src/web/server.js`: rotas acima.
- `painel/src/telas/BuscaPorChave.jsx`: `BuscarPorPeriodo` e `Pedidos` dentro de `SaidasPeloCertificado`.

## Testes

Uma SEFAZ falsa com números mapeados para AAMM, furos e o limite do 526.

- O último número sai certo sem nota de partida, com partida e com furos de até 5 números perto do fim.
- Primeiro e último número de períodos de 1 e de 3 meses, incluindo o mês na borda do 526, com o aviso de janela.
- Nenhuma nota no período e série vazia.
- O trabalho põe só as chaves do período na fila, com direção `saida` e origem `periodo`, e pula as repetidas.
- O 656 no meio: o próximo ciclo continua do `proximo` gravado. Fechar o app no meio: o mesmo.
- Pausar a empresa ou a fila no meio para o trabalho.
- Uma procura por vez: o pedido feito durante a procura automática fica `na-espera` e roda depois.
- Rotas: validação (mês fora da janela, Até < De, série, empresa sem A1 ou de outro estado), 202 na espera e exclusão.
- O interruptor ligado sem nota de partida começa do último número achado.

## Fora de escopo

- Entradas por período: a SEFAZ não oferece, e a captura já cobre os últimos 90 dias.
- Datas exatas dentro do mês.
- Descobrir séries sozinho, além da 1 e das que já aparecem nas notas. A pessoa digita a série.
- UFs com SEFAZ própria.
