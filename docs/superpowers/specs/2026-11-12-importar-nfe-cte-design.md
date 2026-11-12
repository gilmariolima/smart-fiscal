# Importar XMLs com NF-e e CT-e

Data: 12/11/2026. Amplia o Importar XMLs (desenho de 08/11, versão 1.11.0), que hoje só aceita NFS-e.

## Objetivo

A tela Importar recebe XMLs ou ZIPs com qualquer mistura de **NF-e, NFS-e e CT-e**, mais os eventos desses três tipos, e organiza cada um como a captura organizaria. Os XMLs podem vir do sistema emissor do cliente, de e-mails de fornecedor, de outro sistema ou, mais adiante, do download de notas antigas pela SVRS.

## Fora de escopo

- NFC-e (modelo 65), CT-e OS (modelo 67), GTV-e e qualquer outro documento: entram nos ignorados como "tipo não suportado".
- Resumos (`resNFe`, `resEvento`): não são nota e ficam de fora.
- Baixar notas antigas pela SVRS: tem desenho próprio, depois deste.

## O que é aceito

O app reconhece o documento pela **raiz do XML**, ignorando o prefixo de namespace:

| Raiz | Tipo | Leitura (já existe) |
|---|---|---|
| `nfeProc` com `<mod>55</mod>` | NF-e | `dadosNfeProc` (`extracao.js`) |
| `cteProc` com `<mod>57</mod>` | CT-e | `dadosCte` + `papelDoCliente` (`extracaoCte.js`) |
| `NFSe` | NFS-e | `dadosNfse` (como hoje) |
| `procEventoNFe` | evento de NF-e | `dadosEvento` |
| `procEventoCTe` | evento de CT-e | `dadosEventoCte` |
| `evento` com `infEvento.pedRegEvento` | evento de NFS-e | `dadosEventoNfse` |

Motivos novos nos ignorados:
- `nao-suportado`: XML legível, mas de outro documento (NFC-e, CT-e OS, `NFe` sem `nfeProc`, resumo, qualquer outra raiz). Na tela: "tipo não suportado (só NF-e, NFS-e e CT-e)".
- `sem-protocolo`: `nfeProc` ou `cteProc` sem `protNFe`/`protCTe` com cStat 100 ou 150. Na tela: "nota sem autorização da SEFAZ".
- `homologacao`: `tpAmb` igual a 2. Na tela: "nota de homologação (teste)".

O motivo `nao-nfse` sai e vira `nao-suportado`. A chave tem de ter 44 dígitos na NF-e e no CT-e, e 50 dígitos na NFS-e, como hoje. Fora disso, o motivo é `invalido`.

## Quem fica com a nota

Só entram clientes da carteira (`papel = 'cliente' OR tambem_cliente = 1`), como hoje.

- **NF-e:** emitente cadastrado leva como **saída**; destinatário cadastrado leva como **entrada**. Se os dois forem clientes, a nota vai para os dois.
- **CT-e:** cada cliente que aparece no CT-e leva a nota, com o papel que `papelDoCliente` der: emitente é **saída**, tomador é **entrada**, e remetente, destinatário, expedidor ou recebedor vão para **Outros**. Vários clientes no mesmo CT-e recebem uma linha cada.
- **NFS-e:** como hoje. Prestador é saída, tomador é entrada e, sem nenhum dos dois, o intermediário fica com a nota como entrada.

## Duplicadas e resumos

- Se o cliente já tem a chave com status `completa`, conta como **já existia** e nada no disco ou no banco muda.
- Se o cliente tem a chave da NF-e só como **resumo** (status `resumo` ou `ciencia_*`), a importação completa a linha que já existe, do mesmo jeito que `gravarCompleta` da captura: grava o XML, passa a `completa` e tira o arquivo de resumo da pasta. Conta como importada. O `origem` dessa linha não muda.
- Linha nova: `nsu NULL` e `origem = 'importada'`.

## Eventos

- Um evento é gravado na tabela `eventos`, uma linha por chave, tipo e sequência. O XML vai para a pasta `Eventos e Resumos` do primeiro cliente que tem a nota.
- Se nenhum cliente tem a nota mas algum CNPJ do evento é da carteira, o evento fica com esse cliente, com a direção calculada pela chave (`direcaoPelaChave`). Para eventos de NFS-e, que não têm CNPJ do dono na chave, o evento só entra quando a nota já está no app; fora isso, vai para os ignorados como `cnpj-nao-cadastrado`.
- **Cancelamento** (NF-e e CT-e `110111`; NFS-e `101101` e `105102`): marca `cancelada = 1` em todas as linhas da chave. Nota importada depois de o evento já existir entra como cancelada; isso já funciona pela consulta de cancelamento ao gravar.
- Se o evento já existe com o XML gravado, conta como já existia.

## Sem cliente cadastrado

- Nota em que nenhum CNPJ é da carteira vai para a pasta das notas sem cliente do escritório: `<Escritório>/Sem cliente cadastrado/AAAA/MM-Mês/<NF-e|NFS-e|CT-e>/Entradas/XML/<chave>-<tipo>.xml`. Para isso, `caminhoDa` recebe `foraDaCarteira: true`. Não há linha no banco, igual à captura.
- Sem escritório cadastrado, a nota vai para os ignorados como `cnpj-nao-cadastrado`, como hoje.
- Evento sem dono não vai para essa pasta: vai para os ignorados como `cnpj-nao-cadastrado`.

## Levar ao cadastrar

Uma função nova, `levarNotasSemCliente(cnpj)`, em `src/services/notasSemCliente.js`:
1. Varre as pastas "Sem cliente cadastrado" do escritório (a lógica de `pastasForaDaCarteira` passa da captura para este módulo, e a captura passa a usá-lo daqui).
2. Para cada `*-nfe.xml`, `*-cte.xml` e `*-nfse.xml`, lê o XML e vê se o CNPJ cadastrado é parte da nota, com as mesmas regras de "Quem fica com a nota".
3. Grava como o Importar grava: mesmo serviço, `origem = 'importada'`. Confere que o XML ficou com o dono e só então apaga o arquivo da pasta sem cliente, tirando também as pastas que ficaram vazias.
4. Se uma nota falhar, o erro vai para o log e o arquivo fica onde estava. Na próxima vez que o cliente for editado ou o app abrir, a varredura tenta de novo.

É chamada:
- ao cadastrar um cliente (`POST /api/clientes`), depois da resposta, sem segurar a tela. Em seguida o organizador é agendado (`conferirArquivos: true`);
- ao abrir o app, para todos os clientes de uma vez. Isso substitui o `resgatarDeForaDaCarteira` de uso único, que hoje só olha NF-e.

O `corrigirNotasDoEscritorio` continua com a parte de mover as notas que estão no banco em nome do escritório; só a varredura da pasta passa a ser feita pela função nova.

## Resultado

`importar()` passa a devolver:

```js
{
  importadas: { nfe: { entrada, saida }, cte: { entrada, saida, outro }, nfse: { entrada, saida } },
  eventos: n,          // eventos gravados
  semCliente: n,       // notas na pasta Sem cliente cadastrado
  jaExistiam: n,
  ignoradas: [{ nome, motivo }],
  clientesAfetados: [id],
}
```

Na tela, uma linha por tipo que teve nota, por exemplo: "NF-e: 120 entradas, 30 saídas", "CT-e: 15 entradas, 2 em Outros", "NFS-e: 8 saídas". Depois vêm, quando houver: "N eventos", "N sem cliente cadastrado (vão para o cliente quando ele for cadastrado)" e "N já estavam no Smart Fiscal", e por fim a lista de ignorados como hoje.

O subtítulo da página passa a ser "NF-e, NFS-e e CT-e obtidas fora do Smart Fiscal". O texto da área de soltar passa a ser "Solte aqui XMLs de NF-e, NFS-e ou CT-e, ou um ZIP com eles.". O motivo `arquivo-grande` passa a dizer "grande demais para ser uma nota".

## Estrutura do código

- `src/services/importacao.js` cuida de expandir os ZIPs, ler cada XML, escolher o leitor pela raiz, gravar e somar o resultado. Ele não conhece os campos de cada tipo.
- `src/services/importacaoTipos.js` (novo) traz um leitor por tipo: `{ modelo, ler(texto) → { d, xml } | { motivo }, donos(d, porCnpj) → [[cliente, direcao]], linha(d) → campos da tabela notas, nomeArquivo(chave) }`, mais os três leitores de evento. Tudo reaproveita as extrações que já existem.
- `src/services/notasSemCliente.js` (novo) cuida da varredura e de levar as notas ao cadastrar.
- A gravação continua igual: uma transação por nota dentro da transação geral, e um erro de disco numa nota não desfaz as outras.

## Limites

Os de hoje continuam: 5 MB por arquivo, 300 MB por ZIP descompactado e 64 MB por envio. Uma NF-e com muitos itens tem poucas centenas de KB, então cabe com folga.

## Testes (node:test)

- NF-e de saída, de entrada e entre dois clientes.
- NF-e que completa um resumo: a linha vira `completa` e o arquivo de resumo sai da pasta.
- CT-e em que o cliente é emitente, tomador ou remetente (Outros); CT-e com dois clientes.
- NFS-e: os testes de hoje continuam passando.
- Eventos: cancelamento de NF-e e de CT-e antes e depois da nota; evento sem dono.
- Ignorados: NFC-e, CT-e OS, resumo, nota sem protocolo, homologação, chave inválida.
- Duplicada por chave no mesmo cliente.
- Sem cliente: a nota vai para a pasta certa por tipo e, ao cadastrar o CNPJ, vai para o cliente e sai da pasta. Sem escritório, a nota fica nos ignorados.
- ZIP misto com os três tipos.
- Tela: o resultado mostra uma linha por tipo, e os motivos novos aparecem com o texto certo.
