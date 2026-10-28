# Notas fiscais (SEFAZ)

> Parte do Smart Fiscal que veio do SmartDoc. Instalação, atualização e desenvolvimento estão no [README](../README.md). Os comandos abaixo (`npm run cli -- ...`) rodam da pasta do código; no app instalado, use `resources\smart-fiscal-cli.cmd <comando>` na pasta do programa. Onde está escrito SmartDoc, leia Smart Fiscal; a pasta de dados das notas é `%LOCALAPPDATA%\Smart Fiscal\dados\notas`.

Captura de NF-e destinadas aos clientes do escritório.

Sistema que roda no computador do escritório e, para cada cliente:

1. consulta na SEFAZ (web service **NFeDistribuicaoDFe**, Ambiente Nacional) as NF-e emitidas contra o CNPJ do cliente;
2. espera a **Ciência da Operação**, que o **dono da empresa** dá no sistema dele (o escritório não dá ciência); depois dela, a SEFAZ libera o XML completo;
3. baixa e guarda o XML completo (`nfeProc`) organizado por cliente e competência;
4. guarda os dados das notas num banco SQLite;
5. mostra tudo num **painel web local**;
6. gera um pacote **ZIP + CSV** por cliente e competência para importar no **Domínio** e no **Fortes**.

Funciona sozinho em segundo plano (agendado) e também por comandos manuais.

> Eventos conclusivos (confirmação, desconhecimento, operação não realizada) **nunca** são enviados automaticamente. Só pela linha de comando, com confirmação.

---

## Requisitos

- Windows 10 ou 11 (também roda em Linux para desenvolvimento).
- **Node.js 22 LTS ou mais novo.**
- Certificado digital **A1 (.pfx ou .p12)** de cada cliente, com a senha. É o e-CNPJ do próprio cliente; um certificado de matriz serve para as filiais (mesma raiz de 8 dígitos do CNPJ).
- Acesso à internet para os web services da SEFAZ.

## Configuração (.env)

| Variável | Padrão | Para que serve |
|---|---|---|
| `TP_AMB` | `2` | `2` = homologação (testes), `1` = produção. No app Smart Fiscal é sempre `1`: a instalação já cria o `.env` em produção e passa para `1` um `.env` que esteja em `2` (menos no modo demonstração, `SEFAZ_MOCK=1`). |
| `MASTER_KEY` | (vazia) | Obrigatória. 64 caracteres hexadecimais. Sem ela o sistema não inicia. |
| `CRON_CAPTURA` | `0 8,13 * * *` | Quando a busca automática roda (formato cron). Padrão: todo dia às 8h e às 13h. Não use menos de 1 hora entre buscas. |
| `INTERVALO_ENTRE_CHAMADAS_MS` | `2000` | Pausa entre chamadas à SEFAZ. |
| `MAX_CONSULTAS_CHAVE_POR_CICLO` | `20` | Quantas notas, no máximo, são baixadas por chave em cada ciclo, por cliente. |
| `MAX_TENTATIVAS_DOWNLOAD` | `5` | Depois de quantas tentativas uma nota para de ser consultada por chave. |
| `PAINEL_PORTA` | `3030` | Porta do painel. |
| `PAINEL_HOST` | `127.0.0.1` | `127.0.0.1` = só no próprio computador. Outro valor expõe o painel na rede. |
| `PAINEL_SENHA` | (vazia) | Obrigatória se `PAINEL_HOST` não for `127.0.0.1`. |
| `PASTA_XMLS` | `./xmls` | Onde ficam os XMLs. |
| `PASTA_EXPORTS` | `./exports` | Onde ficam os pacotes ZIP. |
| `PASTA_CERTS` | `./certs` | Onde ficam as cópias dos certificados. |
| `PASTA_DADOS` | `./data` | Onde fica o banco `nfe.db` (opcional). |
| `PASTA_LOGS` | `./logs` | Onde fica o `app.log` (opcional). |
| `PASTA_BACKUP` | (vazia) | Pasta do [backup automático](#backup-automático), de preferência em outro disco, na rede ou numa pasta sincronizada (OneDrive/Google Drive). A pasta escolhida na tela **Backup** vale mais que esta. |

Observações:
- O que vem depois de `#` numa linha é comentário. Se a senha do painel tiver `#`, coloque entre aspas: `PAINEL_SENHA="minha#senha"`.
- Mudou o `.env`? Reinicie o serviço (ou o comando `servidor`).

## Cadastrar clientes

Há dois jeitos, e os dois fazem as mesmas verificações.

**Pelo painel** (só no computador do sistema): menu **Clientes** → **Novo cliente**. Preencha CNPJ, razão social, UF e apelido, escolha o arquivo `.pfx`/`.p12` e digite a senha do certificado. A tela mostra o titular e a validade do certificado cadastrado.
O cadastro pelo painel só funciona com o painel aberto no próprio computador onde o sistema está instalado (`http://127.0.0.1:3030`). Acessado de outro computador da rede, o botão não aparece e o servidor recusa o pedido: o certificado e a senha nunca passam pela rede.

**Pela linha de comando:**

```powershell
npm run cli -- cliente:add --cnpj 11.222.333/0001-81 --razao "Comercial Exemplo Ltda" --uf CE --pfx "C:\Certificados\exemplo.pfx" --apelido Exemplo
```

- A senha do certificado é pedida em seguida e **não aparece na tela**.
- O sistema abre o certificado, confere a senha, a validade e se o CNPJ do certificado é da mesma empresa (raiz de 8 dígitos). Recusa certificado vencido ou de outra empresa e avisa quando faltam menos de 30 dias para vencer.
- O `.pfx` é copiado para `certs\<cnpj>.pfx`; a senha vai criptografada para o banco.
- `--apelido` é o nome curto usado na pasta dos XMLs e no painel (opcional).
- `--uf` é a UF do cliente (define o código do órgão e o fuso horário dos eventos).

**Renovação anual do certificado:** no painel, menu **Clientes** → link **Certificado** na linha do cliente → escolha o arquivo novo e digite a senha. Ou pela linha de comando:
```powershell
npm run cli -- cliente:cert --cnpj 11222333000181 --pfx "C:\Certificados\exemplo-2027.pfx"
```

**Listar, desativar e reativar** (no painel, pelo menu **Clientes**: link **Certificado** e botão **Desativar** / **Reativar** na linha do cliente):
```powershell
npm run cli -- cliente:list
npm run cli -- cliente:desativar --cnpj 11222333000181
npm run cli -- cliente:ativar --cnpj 11222333000181
```

## Notas de saída (autXML)

Além das notas **de entrada** (que a SEFAZ entrega contra o CNPJ do cliente), o sistema guarda as notas que o cliente **emitiu** (saídas). Ele usa a tag `autXML` da NF-e: quando o emissor inclui o CNPJ do escritório entre os "Autorizados a obter o XML", a SEFAZ entrega uma cópia de cada nota emitida na fila do escritório.

**1. Cadastre o escritório** com o certificado A1 do próprio escritório (a senha é pedida sem aparecer na tela):

```powershell
npm run cli -- escritorio:add --cnpj 11.222.333/0001-81 --razao "Escritorio Exemplo Ltda" --uf CE --pfx "C:\Certificados\escritorio.pfx"
npm run cli -- escritorio:cert --pfx "C:\Certificados\escritorio-2027.pfx"    # renovação
```

Também dá para cadastrar no painel: menu **Clientes**, linha **Escritório** logo abaixo do título (**Cadastrar escritório** ou **Trocar certificado**; só no próprio computador do sistema, como o cadastro de clientes). O `cliente:list` mostra a coluna **Papel** e o `status` mostra a linha do escritório.

**2. Peça a cada cliente** que configure o emissor de NF-e para incluir o **CNPJ do escritório** em "Autorizados a obter o XML" (`autXML`).

**Como funciona:**
- A captura do escritório roda **primeiro** em cada ciclo (8h, 13h e **Capturar agora**). É só captura: não envia ciência nem baixa por chave.
- Cada nota recebida vai para: o emitente é cliente → **saída** desse cliente; o destinatário é cliente → **entrada** dele (completa um resumo sem gastar ciência nem download); nenhum dos dois → o XML fica em `fora-da-carteira\<AAAA>\<MM>\` dentro da pasta do escritório (`xmls\<CNPJ>_escritorio\`), para não se perder.
- Uma nota de um cliente para outro cliente aparece como saída de um e entrada do outro.
- No painel, a tela do mês (**Notas** → cliente → ano → mês) tem o filtro **Todas / Entradas / Saídas** (com a contagem de cada uma, por exemplo "Entradas (12)") e as colunas **Tipo**, **CNPJ Emitente**, **Nome Emitente** e **CNPJ Destinatário**.

**Avisos:**
- Só chegam as notas emitidas **depois** de o cliente configurar o `autXML`. As anteriores não vêm.
- Notas de quem não é cliente não entram no painel nem na exportação; ficam só em `fora-da-carteira\`.
- Eventos conclusivos (`manifestar`) valem só para notas de **entrada**.
- **Backup automático:** na primeira abertura depois da atualização, o banco é migrado sozinho e, se já houver notas, antes é feita uma cópia `nfe.db.bak-AAAAMMDD-HHMMSS-mmm` na mesma pasta do `nfe.db`.
- `ambiente:producao` também zera a fila (NSU) do escritório.

## Primeiro teste: homologação

**No app Smart Fiscal isto não se aplica:** ele trabalha sempre em produção. Ao abrir, se encontrar o `.env` ou o banco em homologação (de uma instalação antiga), passa os dois para produção sozinho. Os clientes e os certificados continuam; as notas de teste e a posição na fila de homologação são descartadas. O que segue vale para quem roda o motor das notas pela linha de comando.

Antes de usar em produção, teste com o certificado de **um** cliente no ambiente de homologação da SEFAZ:

1. No `.env`, deixe `TP_AMB=2`.
2. Cadastre o cliente (`cliente:add`).
3. Rode `npm run cli -- capturar --cnpj <cnpj>` e veja o resultado.
4. Confira `npm run cli -- status`, o painel e o `logs\app.log`.

Em homologação normalmente não há notas reais; o objetivo é confirmar que o certificado abre, que a SEFAZ responde (cStat 137 "Nenhum documento localizado" já é um sucesso) e que nada dá erro.

Quando estiver tudo certo, passe para produção:

1. Pare o servidor (Ctrl+C ou `nssm stop SmartDoc`).
2. No `.env`, mude para `TP_AMB=1`.
3. Dê dois cliques em **`Passar para producao.cmd`** (ou rode `node src/cli.js ambiente:producao`).
   Ele mostra o que vai ser descartado e pede confirmação. Os clientes e os certificados continuam; a posição na fila da SEFAZ (NSU) de todos volta para o início, e as notas, os eventos e os XMLs de teste são apagados.
4. Suba o servidor de novo. A primeira captura traz as notas reais dos últimos ~3 meses de cada cliente.

O banco guarda em qual ambiente ele está (homologação, produção ou SEFAZ simulada). Se o `.env` estiver em outro ambiente, o sistema não roda e explica o que fazer, para que a fila e as notas de um ambiente nunca se misturem com as do outro. Um banco vazio (sem clientes nem notas) adota o ambiente do `.env` sem perguntar.

> Em produção, o NSU (posição na fila da SEFAZ) de cada cliente começa do zero no primeiro uso e é guardado depois de cada lote. Nunca apague o banco para "recomeçar": veja [Regras e limitações da SEFAZ](#regras-e-limitações-da-sefaz).

## Uso no dia a dia

O modo normal é deixar o **servidor** rodando (de preferência como serviço do Windows, abaixo):

```powershell
npm run cli -- servidor
```

Atalho: dê dois cliques em **`Iniciar sistema.cmd`**, na pasta do sistema. Ele liga o servidor e abre o painel no navegador. Para desligar, Ctrl+C na janela.

Ele faz duas coisas no mesmo processo:
- **agendador:** roda o ciclo completo no horário do `CRON_CAPTURA` e uma vez 15 segundos depois de iniciar (para não esperar o próximo horário quando o computador liga);
- **painel:** abre em `http://127.0.0.1:3030`.

Se o escritório estiver cadastrado, o ciclo começa pela captura do escritório (veja [Notas de saída](#notas-de-saída-autxml)). Depois, o **ciclo** faz, para cada cliente ativo, um de cada vez:
1. consulta os documentos novos na SEFAZ (por NSU). As notas que chegam só como resumo ficam **aguardando a ciência do cliente**: avise o dono da empresa. Depois que ele der ciência, o XML completo entra na fila e chega numa das capturas seguintes;
2. baixa por chave o XML das notas que já tinham ciência enviada por versões antigas do app (com limite por ciclo).

Clientes em espera (1 h depois de "nenhum documento") ou bloqueados pela SEFAZ são pulados automaticamente.

### Busca automática

Na tela **Início** do painel há a chave **Busca automática**. Ela vale na hora, sem reiniciar, e fica salva no banco:

| Ligada (padrão) | Desligada |
|---|---|
| Busca as notas novas nos horários do `CRON_CAPTURA` e 15 s depois de ligar. | Só busca quando você manda capturar (**Capturar agora** no Início ou **Capturar selecionados** em Clientes). |

O app **não dá ciência**: quem dá é o dono da empresa. Quando há notas só com resumo, o **Início** mostra quantas aguardam a ciência do cliente, com o atalho para a lista. O `status` da linha de comando mostra como está a busca automática.

Para parar o servidor no terminal: **Ctrl+C** (ele termina o ciclo em andamento antes de sair).

## Painel web

Endereço: `http://127.0.0.1:3030` (só no próprio computador).

O painel tem um menu lateral com seis telas e, embaixo, o bloco **Notas sem XML**: o total e uma linha por situação (aguardando ciência, aguardando XML, esgotada, erro na ciência), cada uma abrindo a lista filtrada. A última captura aparece no cabeçalho do Início; fora da produção, uma faixa no alto avisa o ambiente (homologação ou SEFAZ simulada).

| Tela | O que mostra |
|---|---|
| **Início** | Atalhos com ícones grandes para as telas, o quadro de **Certificados** (no prazo, a vencer em 30 dias, vencidos), no cabeçalho a chave de **Busca automática** e o botão **Capturar agora** (leva a Clientes) e, quando há notas só com resumo, a faixa com quantas **aguardam a ciência do cliente**. |
| **Notas** | Pastas **Cliente → Ano → Mês**. Dentro do mês: lista com filtros (Todas / Entradas / Saídas, situação, busca por CNPJ, nome ou número, e a opção de buscar em todas as pastas), 50 por página, ordenação pelo cabeçalho, colunas de emitente e destinatário e o botão **Ações** de cada nota (**Ver nota**, **Baixar XML**, **Baixar XML + eventos** — ZIP com a nota e os eventos que têm arquivo, como cancelamento e carta de correção — e **Imprimir DANFE**, que abre a nota já na impressão), além de **Reprocessar** para nota de entrada com erro na ciência ou sem XML depois das tentativas. Marque as notas (ou **Marcar todos**) e use **Baixar selecionados** (até 2.000 por ZIP). **Exportar mês (Domínio/Fortes)** gera o pacote do mês. Clique no número da nota (ou em **Ver**) para abrir a nota legível no formato do DANFE: emitente, destinatário, fatura, impostos, transporte, produtos, dados adicionais e eventos (ciência, cancelamento, CT-e, MDF-e). **Imprimir / PDF** usa a impressão do navegador em A4 (escolha "Salvar como PDF"). Nota só com resumo mostra os dados do resumo. É uma visualização para conferência, não o leiaute oficial do DANFE com todas as medidas. |
| **XMLs não baixados** | Notas de todos os clientes que ainda não têm o XML completo (canceladas ficam de fora), com filtro por situação: aguardando ciência, aguardando XML (ainda dentro do limite de tentativas), esgotada, erro na ciência. Cada linha tem o mesmo botão **Ações** da pasta do mês. |
| **Clientes** | Linha do escritório no alto (certificado e situação) e a lista de clientes, com certificado, última captura (sucesso, erro, espera ou bloqueio da SEFAZ) e pendências. Marque um, vários ou **Marcar todos** e use **Capturar selecionados** (até 500). No computador do sistema, também **Novo cliente**, **Certificado**, **Desativar** e **Reativar**. |
| **Exportar** | Escolhe cliente e competência, gera o pacote e mostra o link para baixar o ZIP. |
| **Execuções** | As últimas 200 execuções (consulta, ciência, download, exportação), com resultado e detalhe. |

O botão **Capturar agora** (no Início) leva à tela **Clientes**, onde se captura um cliente (basta marcá-lo), vários ou todos de uma vez com **Capturar selecionados**. A captura respeita as esperas da SEFAZ; para forçar a consulta de um cliente, use a linha de comando com `--forcar`.

**Atualizar o sistema:** pare o serviço (`nssm stop SmartDoc`), copie o código novo por cima da pasta do sistema (sem apagar `.env`, `data\`, `certs\`, `xmls\` e `exports\`), rode `npm install` na pasta (ele instala o que faltar e já monta o painel) e suba de novo com `nssm restart SmartDoc`. O `npm run painel:build` só serve para remontar o painel sem mudar as dependências.

**Mexer no painel:** o código fica em `painel\`. Para desenvolver, deixe o `servidor` rodando e, em outro PowerShell, rode `npm run painel:dev`; ele abre uma cópia do painel que atualiza ao salvar e conversa com o servidor.

O painel só lê dados, com estas exceções: ligar e desligar a busca automática, disparar captura, gerar exportação, reprocessar uma nota e, só no próprio computador do sistema, cadastrar clientes, trocar certificado e desativar/reativar.

**Acessar de outro computador da rede** (opcional): no `.env`, `PAINEL_HOST=0.0.0.0` e uma `PAINEL_SENHA`. O navegador vai pedir usuário e senha (o usuário pode ser qualquer um; vale a senha). Libere a porta no Firewall do Windows só para a rede interna.

## Notas de serviço (NFS-e)

O sistema também busca as **NFS-e** de cada cliente no **ADN** (Ambiente de Dados Nacional da NFS-e), com o **certificado A1 do próprio cliente**. A mesma consulta traz as notas em que o cliente é **prestador** (saída), **tomador** (entrada) ou intermediário (gravada como entrada).

- Roda junto com a NF-e no **Capturar selecionados** e nos horários automáticos: primeiro a NF-e, depois a NFS-e. Um erro numa não impede a outra. O escritório não busca NFS-e.
- Fila própria por cliente (NSU da NFS-e, separado do da NF-e). Quando a fila acaba, espera 1 hora antes de consultar o mesmo CNPJ de novo, como na NF-e.
- O cancelamento (101101) e o cancelamento por substituição (105102) marcam a nota como cancelada, mesmo quando o evento chega antes da nota.
- **Fortaleza:** as NFS-e emitidas no ISS Fortaleza também chegam pelo ADN (testado em 27/10/2026, inclusive notas de 2023). Só vêm as notas que o município compartilha com o ADN.
- No painel: a tela do mês tem o filtro **NF-e / NFS-e** e a coluna **Modelo**; a nota mostra prestador, tomador, município, competência e valor do serviço; **Execuções** mostra **Consulta NFS-e**.

**Pastas novas:** na primeira abertura desta versão, os XMLs que já existiam passam de `<cliente>\<AAAA-MM>\` para `<cliente>\<AAAA>\<MM>\<NF-e|NFS-e>\<Entradas|Saidas>\`, uma vez só. Se um arquivo estiver aberto e travado, ele fica para a próxima abertura (aparece no log). O espelho do backup passa a ter as pastas antigas e as novas; as antigas podem ser apagadas à mão do backup.

## Exportação para Domínio e Fortes

Pelo painel (tela **Exportar**, ou o botão **Exportar mês (Domínio/Fortes)** na pasta do mês) ou pela linha de comando:

```powershell
npm run cli -- exportar --cnpj 11222333000181 --competencia 2026-10
```

Gera `exports\<CNPJ>_<apelido>_<AAAA-MM>.zip` com:

```
NF-e\Entradas\<chave>-nfe.xml               entradas completas e não canceladas
NF-e\Entradas\Canceladas\<chave>-nfe.xml    entradas completas que foram canceladas
NF-e\Saidas\...                             o mesmo para as saídas
NFS-e\Entradas\<chave>-nfse.xml             serviços tomados (e Canceladas\)
NFS-e\Saidas\<chave>-nfse.xml               serviços prestados (e Canceladas\)
NFS-e...<chave>-nfse.pdf                 DANFSe (PDF) de cada NFS-e, ao lado do XML
notas.xlsx                                 planilha com as abas NF-e, NFS-e e Retenções (todas as notas da competência, inclusive as sem XML completo)
```

Exportar o CNPJ do escritório é recusado (ele não tem notas próprias).

A planilha `notas.xlsx` abre direto no Excel, com cabeçalho congelado e filtro em cada aba:
- **NF-e:** tipo, número, série, emissão, emitente, destinatário, valor, situação (XML completo, só resumo...), cancelada e chave.
- **NFS-e:** tipo, número, competência, emissão, prestador, tomador, valor do serviço, cancelada e chave.
- **Retenções:** para cada NFS-e com XML, ISS (e se foi retido), IRRF, CSLL, INSS, PIS, COFINS, total retido (o `vTotalRet` oficial da nota) e valor líquido.

A mesma planilha pode ser baixada sem exportar, pelo botão **Baixar Excel do mês** na pasta do mês. O PDF de uma NFS-e também sai pelo menu **Ações → Baixar PDF (DANFSe)** e pela tela da nota. O DANFSe segue o leiaute da Nota Técnica 008/2026 v1.02 (a API oficial de geração foi desligada em 03/08/2026); a marca d'água "CANCELADA" ou "SUBSTITUÍDA" sai quando é o caso.

A competência é o **mês de emissão** da NF-e e o **mês de competência** (`dCompet`) da NFS-e.

> **Confirmar com o escritório:** Domínio e Fortes importam o XML de NF-e de entrada, mas a forma exata da importação (pasta, nome dos arquivos, se o ZIP serve direto) precisa ser testada nos dois sistemas antes de adotar o pacote como padrão. Ajustes ficam todos em `src/services/exportacao.js`.

## Comandos

Todos com `npm run cli -- <comando>` (ou `node src/cli.js <comando>`). Ajuda: `npm run cli -- --help`.

| Comando | O que faz |
|---|---|
| `cliente:add --cnpj --razao --uf --pfx [--apelido]` | Cadastra um cliente; pede a senha do certificado sem mostrar. |
| `cliente:cert --cnpj --pfx` | Troca o certificado (renovação). |
| `escritorio:add --cnpj --razao --uf --pfx` | Cadastra o escritório (certificado A1 próprio) para capturar as saídas pelo autXML; pede a senha sem mostrar. |
| `escritorio:cert --pfx` | Troca o certificado do escritório. |
| `cliente:list` | Lista os clientes e o escritório: CNPJ, papel, nome, ativo, NSU, última consulta, último erro, validade do certificado. |
| `cliente:ativar --cnpj` / `cliente:desativar --cnpj` | Liga ou desliga a captura de um cliente. |
| `capturar [--cnpj] [--forcar]` | Ciclo completo (consulta → download) agora. `--forcar` ignora a espera de 1 h, nunca o bloqueio da SEFAZ. |
| `baixar [--cnpj]` | Só tenta baixar o XML das notas com ciência enviada. |
| `exportar --cnpj --competencia AAAA-MM` | Gera o pacote ZIP + CSV. |
| `manifestar --chave [--cnpj] --evento confirmacao\|desconhecimento\|nao-realizada [--justificativa] [--sim]` | Evento conclusivo manual, só para notas de entrada; `--cnpj` é necessário quando a chave existe em mais de um cliente. Mostra a nota e pede confirmação `s/N`. `nao-realizada` exige justificativa de 15 a 255 caracteres. |
| `servidor [--sem-ciclo-inicial] [--atraso-inicial s]` | Agendador + painel (modo do dia a dia). |
| `backup` | Faz o backup agora (mesmo que o do dia já exista). Veja [Backup automático](#backup-automático). |
| `status` | Notas por estado, clientes com erro, certificados vencendo e próximas consultas. |
| `ambiente:producao [--sim]` | Passa o banco de homologação para produção (zera a fila da SEFAZ e descarta as notas de teste). Pede confirmação. |
| `cliente:demo` | Só com `SEFAZ_MOCK=1`: cadastra dois clientes de demonstração. |

Exemplo de manifestação manual:
```powershell
npm run cli -- manifestar --chave 23261012345678000195550010000012221000085542 --evento nao-realizada --justificativa "Mercadoria nao foi entregue no endereco"
```
Atenção: eventos conclusivos são definitivos na SEFAZ.

## Regras e limitações da SEFAZ

O sistema segue as regras do web service de distribuição para não ser bloqueado:

- **Histórico curto:** a SEFAZ só entrega documentos dos **últimos 3 meses** (aproximadamente). Notas mais antigas que isso não vêm pela distribuição; precisam ser obtidas com o fornecedor.
- **NSU por CNPJ:** cada cliente tem sua posição na fila (NSU). O sistema guarda o último NSU depois de cada lote e sempre continua dele. **Não apague o banco** para recomeçar: além de duplicar trabalho, recomeçar do zero costuma gerar bloqueio.
- **Nenhum documento (cStat 137)** ou fila zerada: o cliente fica **1 hora** sem nova consulta por NSU.
- **Consumo indevido (cStat 656):** a SEFAZ bloqueia consultas daquele CNPJ por **1 hora**. O sistema marca o bloqueio e pula o cliente; nem o `--forcar` passa por cima.
- **Consulta por chave** gasta a mesma cota: no máximo `MAX_CONSULTAS_CHAVE_POR_CICLO` por cliente em cada ciclo.
- **Um cliente por vez**, com pausa entre chamadas. Um cliente com erro nunca interrompe os outros.
- O app **não dá ciência**. O XML completo só fica disponível **depois que o dono da empresa der a ciência** no sistema dele; aí chega numa das capturas seguintes.
- Notas que ficaram com "erro na ciência" em versões antigas: **Reprocessar** faz a nota voltar a aguardar a ciência do cliente.
- **Cancelamento** (evento 110111) marca a nota como cancelada; o XML do evento fica guardado junto.
- Fora do escopo: CT-e e eventos conclusivos automáticos (a NFS-e tem seção própria).

## Pastas e arquivos

```
C:\smartdoc\
├─ .env                 configuração (inclui a MASTER_KEY)
├─ certs\               cópias dos certificados (<cnpj>.pfx)
├─ data\nfe.db          banco de dados
├─ xmls\<CNPJ>_<apelido>\<AAAA>\<MM>\
│    NF-e\Entradas\<chave>-nfe.xml                          notas completas
│    NF-e\Entradas\Resumos\<chave>-resumo.xml               NF-e que ainda não têm o XML completo
│    NF-e\Entradas\Eventos\<chave>-evento-<tipo>-<seq>.xml  eventos (cancelamento, ciência, CC-e...)
│    NF-e\Saidas\...                                        o mesmo para as notas emitidas pelo cliente
│    NFS-e\Entradas\<chave>-nfse.xml                        serviços tomados (e Eventos\)
│    NFS-e\Saidas\<chave>-nfse.xml                          serviços prestados (e Eventos\)
├─ xmls\<CNPJ>_escritorio\fora-da-carteira\<AAAA>\<MM>\NF-e\Entradas\   notas do autXML de quem não é cliente
├─ exports\             pacotes ZIP gerados
├─ logs\app.log         registro de tudo o que o sistema faz
└─ src\                 código
```

## Segurança e backup

- As **senhas dos certificados** ficam criptografadas (AES-256-GCM) com a `MASTER_KEY`. Nunca aparecem no banco em texto, no log, no painel ou na tela.
- O painel só abre em `127.0.0.1` por padrão e recusa acesso por outros endereços.
- `certs\`, `.env`, `data\`, `xmls\`, `exports\` e `logs\` **nunca** devem ir para repositório de código (já estão no `.gitignore`).

> **Se a MASTER_KEY se perder**, as senhas guardadas não podem mais ser lidas: será preciso recadastrar o certificado de cada cliente (`cliente:cert`). O backup automático leva o `.env` junto; guarde também uma cópia da chave num cofre de senhas.

### Backup automático

A pasta do backup se escolhe na tela **Cadastros → Backup**:
- O app cria a pasta e testa gravar nela antes de aceitar.
- Ele recusa endereço incompleto e pasta dentro da pasta de dados do Smart Fiscal.
- Se a pasta ficar no mesmo disco do Smart Fiscal, ele avisa.

O `PASTA_BACKUP` do `.env` continua valendo enquanto nenhuma pasta for escolhida na tela. A escolha da tela vale mais, e **Desligar backup** desliga mesmo com o `.env` preenchido.

Com a pasta escolhida, o app faz **um backup por dia**. Ele confere 1 minuto depois de ligar e depois a cada hora se o do dia já existe. Funciona com a busca automática desligada e com o PC desligado à noite (roda quando ele ligar).

```
D:\Backup Smart Fiscal\
├─ xmls\                  espelho dos XMLs: copia só os novos e nunca apaga (guarda tudo)
└─ diarios\AAAA-MM-DD\     uma cópia por dia, as 30 mais recentes
     nfe.db                banco (cópia consistente, mesmo com o sistema rodando)
     certs\                certificados
     .env                  configuração com a MASTER_KEY
     estoque\              dados do SPED: empresas, correções, contador e arquivos gerados (sem os logs)
```

- A tela **Backup** mostra:
  - a situação (em dia, desligado ou com problema);
  - quando foi o último backup e o que ele copiou;
  - o botão **Fazer backup agora**.
- Cada backup também aparece em **Execuções** (tipo Backup), com quantos XMLs novos foram copiados ou o erro.
- O **Início** mostra uma faixa amarela, com o atalho para a tela Backup, só quando há problema: backup desligado, último backup com erro (ex.: disco desconectado) ou 3 dias ou mais sem backup.
- Pela linha de comando: `npm run cli -- backup`.
- **Proteja a pasta de backup:** ela tem os certificados e a chave que abre as senhas deles. Em nuvem, use só a conta do escritório, sem compartilhar a pasta.

**Restaurar** (num PC novo ou depois de perder os dados):
1. Instale o Smart Fiscal e feche-o de vez (botão direito no ícone perto do relógio → **Sair**).
2. Copie de `diarios\<dia mais recente>\` para `%LOCALAPPDATA%\Smart Fiscal\dados\`:
   - o `.env` e a pasta `certs\` para `notas\`;
   - o `nfe.db` para `notas\data\`;
   - o conteúdo de `estoque\` para `estoque\`.
3. Copie a pasta `xmls\` do backup para `notas\`.
4. Se mudou algum caminho `PASTA_*`, confira o `.env`.
5. Abra o Smart Fiscal e confira os clientes, as notas e as empresas do SPED.

## Demonstração sem certificado

Para ver o sistema funcionando sem certificado nem SEFAZ, use a SEFAZ simulada **numa cópia da pasta do sistema** (com o próprio `.env`), para não misturar com os dados reais:

```powershell
$env:SEFAZ_MOCK = "1"
npm run cli -- cliente:demo
npm run cli -- capturar
npm run cli -- servidor
```

O painel mostra "SEFAZ simulada" no topo. Os clientes e notas da demonstração são fictícios.

## Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| `npm.ps1 não pode ser carregado porque a execução de scripts foi desabilitada` | Trava do PowerShell. Use `node src/cli.js <comando>` no lugar de `npm run cli -- <comando>` (e `npm.cmd install`), ou libere scripts do usuário uma vez: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |
| `Este banco foi usado em homologação e o .env agora está em produção` | Falta passar o banco para produção: `node src/cli.js ambiente:producao` (veja [Primeiro teste: homologação](#primeiro-teste-homologação)). |
| `Este banco é de ... e o .env está em ...` | O `.env` aponta para um ambiente diferente do banco (ex.: `SEFAZ_MOCK=1` ligado no banco real). Volte o `.env` ou use outra pasta de dados (`PASTA_DADOS`). |
| `MASTER_KEY ausente ou inválida` | Falta a chave no `.env` ou ela não tem 64 caracteres. Gere de novo (passo 5 da instalação) só se ainda não houver clientes cadastrados. |
| `Senha do certificado incorreta` | Confira a senha com o cliente. |
| `Certificado vencido` / "vence em N dias" | Peça o novo certificado e use `cliente:cert`. |
| `O certificado é do CNPJ ..., de outra empresa` | O `.pfx` não é do cliente informado. |
| Cliente "Bloqueado (656)" | A SEFAZ pediu 1 hora sem consultas. Não faça nada: o sistema volta sozinho. Se repetir sempre, aumente o intervalo do `CRON_CAPTURA`. |
| "Espera da SEFAZ até ..." | Normal depois de "nenhum documento novo". |
| Nota "Sem XML (5/5)" | A SEFAZ não liberou o XML depois de 5 tentativas. Use **Reprocessar** no painel ou peça o XML ao fornecedor. |
| `A porta 3030 já está em uso` | O servidor já está rodando (talvez como serviço). Feche o outro ou mude `PAINEL_PORTA`. |
| `Já existe uma execução em andamento` | Um ciclo está rodando (servidor ou outro comando). Aguarde terminar. |
| O painel não mostra mudança depois de atualizar o sistema | Rode `npm install` na pasta do sistema e reinicie o serviço. |
| `Painel não compilado: rode npm install` | Rode `npm install` na pasta do sistema (precisa de internet) e reinicie o serviço. |

Detalhes de qualquer erro ficam em `logs\app.log`.

