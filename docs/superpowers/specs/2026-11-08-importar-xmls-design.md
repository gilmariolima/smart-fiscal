# Importar XMLs — design

Data: 2026-11-08
Projeto: Smart Fiscal
Escopo desta versão: **NFS-e somente**.

## Objetivo

Uma tela nova, **Importar XMLs**, onde o usuário arrasta XMLs de NFS-e que
conseguiu fora do app (baixados à mão do Emissor Nacional, mandados pelo
cliente ou por outro sistema) e o app os organiza exatamente como uma nota
capturada: grava no banco, guarda o XML na pasta do cliente, gera o DANFSe
(PDF), e refaz Excel, relatórios e ZIP do grupo.

Resolve o caso dos **clientes sem certificado A1**: o app não consegue
capturar a NFS-e deles pelo ADN (precisa do certificado), mas pode organizar
o XML que chega de fora. Não automatiza download (o Emissor Nacional pede
hCaptcha a cada nota; fora de escopo e fora do que é aceitável).

## O que entra

- `.xml` de NFS-e — um ou vários de uma vez.
- `.zip` contendo `.xml` de NFS-e (lê todos, inclusive em subpastas do ZIP).
- Qualquer outro arquivo (PDF, imagem, XML de NF-e/CT-e) é **recusado** com
  aviso "só XML de NFS-e". Não guarda PDF: o app gera o DANFSe do próprio XML.

## Fluxo (uma nota)

1. Lê o XML com `dadosNfse(xml)` (`src/services/extracaoNfse.js`).
2. Sem `chave` → arquivo inválido, entra no relatório como ignorado.
3. Acha o cliente **cadastrado** pelo CNPJ:
   - `prestadorCnpj === cliente.cnpj` → **saída**.
   - `tomadorCnpj === cliente.cnpj` → **entrada**.
   - Se o cliente é só intermediário, grava como entrada e loga (igual à
     captura).
   - Nenhum CNPJ do XML bate com cliente cadastrado → **CNPJ não cadastrado**,
     ignorado e listado (não cria cliente: o cadastro precisa de mais dados).
4. Duplicata: se já existe nota com essa `(cliente_id, chave)` no banco
   (capturada ou importada antes) → **já existia**, não grava de novo.
5. Grava o XML: `armazenamento.salvar({ cliente, modelo: 'nfse',
   direcao: tipo, competencia: d.competencia, nomeArquivo: nomes.nfse(d.chave),
   xml })`.
6. Insere em `notas` com os mesmos campos da captura de NFS-e, `nsu = NULL`,
   `status = 'completa'`, `cancelada` conforme evento já existente, e a marca
   nova `origem = 'importada'`.
7. Depois do lote, uma vez: `ctx.organizador.agendar({ conferirArquivos: true })`.
   O organizador (já existente) refaz DANFSe, Excel, relatório e ZIP só dos
   grupos que mudaram.

Tudo numa transação por lote (`db.transaction`), como `gravarLote` da captura:
ou grava o lote todo, ou nada. O XML já salvo no disco que não virar nota não
atrapalha (o organizador reconcilia).

## Identidade e direção

Reaproveita a regra da captura de NFS-e (`gravarNota` em
`src/services/capturaNfse.js`). A diferença: na captura o cliente já é
conhecido (a consulta é por certificado dele); na importação o cliente é
**descoberto pelo CNPJ do XML**, comparando com todos os clientes cadastrados.

Busca do cliente: um índice em memória `cnpj → cliente` montado no início da
importação a partir de `clientes.all()`. Tanto `prestadorCnpj` quanto
`tomadorCnpj` são testados; o primeiro que for cliente cadastrado define o dono
e a direção. Se os dois forem clientes (uma empresa presta para outra, ambas na
carteira), grava nos dois — uma nota de saída para o prestador e uma de entrada
para o tomador — como a captura de NF-e já faz para nota entre dois clientes.

## Backend

### Serviço novo: `src/services/importacao.js`

`criarServicoImportacao({ db, config, logger, armazenamento, clientes })` com:

- `importar(arquivos)` — `arquivos` é uma lista de `{ nome, bytes }` (Buffer).
  Expande os `.zip`, filtra `.xml`, processa cada um, devolve o resumo.
- Resultado:
  ```
  {
    importadas: { entrada, saida },     // contagens
    jaExistiam: n,
    ignoradas: [ { nome, motivo } ],    // 'cnpj-nao-cadastrado' | 'invalido' | 'nao-xml' | 'nao-nfse'
    clientesAfetados: [ id, ... ]
  }
  ```

Unzip com **fflate** (`unzipSync`), puro JS, sem build nativo. Única dependência
nova. Um ZIP inválido ou corrompido vira um item ignorado, não derruba o lote.

Detecção de NFS-e: o XML precisa casar com o formato que `dadosNfse` entende
(raiz `NFSe`); XML de NF-e/CT-e cai como `nao-nfse`.

### Rota: `POST /api/importar`

- **Só no próprio PC** (`exigirLocal(req)`), como o cadastro de certificado:
  importar grava arquivos e mexe na pasta, não é para rede.
- Corpo: JSON com os arquivos em base64, no mesmo molde do upload de
  certificado. Limite próprio da rota (ex.: 64 MB) para caber um ZIP de um ano
  de notas; registrado como os outros limites em `src/web/server.js`.
- Responde o resumo do serviço. Erros de arquivo não são 500: entram em
  `ignoradas`.
- Enquanto a captura ou a troca de pasta estiver rodando, recusa com 409
  (reusa `capturaOcupada` / `recusarDurante`), para não gravar durante a
  geração.

## Banco

Migração em `src/db/index.js`: `ALTER TABLE notas ADD COLUMN origem TEXT
DEFAULT 'captura'`. Notas já existentes e capturas futuras ficam `'captura'`;
importadas gravam `'importada'`. Idempotente (só adiciona se a coluna não
existe, como as outras migrações do arquivo).

Serve para distinguir na conferência o que entrou por fora e, no futuro, para
um filtro na tela de Notas (fora desta versão).

## Frontend

### Tela: `painel/src/telas/Importar.jsx`, rota `/importar`

- Item **Importar XMLs** no `MenuLateral.jsx`, **logo acima de Exportar**.
- Área grande de arrastar e soltar: "Arraste XMLs ou um ZIP aqui, ou clique
  para escolher". Também um `<input type="file" multiple accept=".xml,.zip">`.
- Ao soltar: lê os arquivos no navegador (`FileReader`/`arrayBuffer`), manda
  em base64 para `/api/importar`, mostra "Importando…" sem animação (padrão do
  app), e depois o resultado.
- Resultado: um resumo em texto simples (sem card colorido), no estilo enxuto:
  - "N notas importadas (X entradas, Y saídas)."
  - "M já estavam no sistema."
  - "K ignoradas" com a lista (nome do arquivo + motivo em português).
- Sem drag-drop sofisticado nem barra animada; segue o visual das outras telas
  (tela que não se mexe).

O estado da pasta/organização já aparece no resumo global do app; a tela não
precisa esperar o DANFSe/Excel ficarem prontos — isso roda no organizador em
segundo plano, como depois de uma captura.

## Erros e casos de borda

- XML sem `chave` ou que não é NFS-e → ignorado, motivo claro.
- CNPJ não cadastrado → ignorado, motivo claro (o usuário cadastra o cliente e
  importa de novo).
- Nota já existente → conta como "já existia", não duplica nem apaga.
- ZIP corrompido / arquivo ilegível → ignorado, não derruba o resto.
- Nota cancelada: se já houver evento de cancelamento dessa chave no banco,
  entra com `cancelada = 1`; senão `0`. Eventos não são importados nesta versão
  (só o XML da nota).
- `competencia` nula no XML: mesmo comportamento da captura (segue o que
  `dadosNfse` devolve).
- Importar não toca em NSU, não consulta SEFAZ, não liga/desliga automática.

## Testes (TDD)

- `test/importacao.test.js` (serviço):
  - XML de NFS-e de entrada e de saída → grava com a direção certa e
    `origem = 'importada'`.
  - CNPJ não cadastrado → ignorado com motivo.
  - Chave já no banco → "já existia", sem duplicar.
  - Nota entre dois clientes cadastrados → grava nos dois.
  - ZIP com vários XMLs → expande e grava todos.
  - Arquivo não-XML e XML não-NFS-e → ignorados com motivo.
  - ZIP corrompido → ignorado, lote segue.
- `test/web.test.js` (rota): `/api/importar` recusa fora do PC local (403);
  recusa durante captura/troca de pasta (409); devolve o resumo; respeita o
  limite de tamanho.
- Reusa os XMLs de exemplo dos testes de NFS-e já existentes.

## Fora de escopo (desta versão)

- NF-e e CT-e por importação (só NFS-e agora).
- Importar PDF/DANFSe (o app gera do XML).
- Importar eventos (cancelamento/substituição) soltos.
- Automatizar o download no Emissor Nacional.
- Coluna "origem" visível na tela de Notas (a marca fica no banco para uso
  futuro).

## Dependência nova

- `fflate` (unzip puro JS, sem build nativo). Instalado com
  `npm install fflate` e empacotado normalmente.
