# SPED Fiscal (inventário do bloco H)

> Parte do Smart Fiscal que veio do Estoque SPED. Instalação, atualização e desenvolvimento estão no [README](../README.md). O motor fica em `estoque/` e os dados em `%LOCALAPPDATA%\Smart Fiscal\dados\estoque`.

Converte o inventário do cliente em **SPED Fiscal (EFD ICMS/IPI) com o bloco H**, pronto para importar no PVA.

Entradas aceitas (o tipo é reconhecido pelo conteúdo):

- relatório **Registro de Inventário** em texto (colunas de largura fixa);
- arquivo **.FS da Fortes** (registros CAB/GRP/UND/PRO/IIV);
- **bloco H** solto ou SPED completo (`.txt` com `|H010|`);
- **planilhas** `.xls`, `.xlsx`, `.csv` (Planilha Modelo, Estoque Escriturado ou parecidas).

O primeiro arquivo com valores é o inventário; os demais só completam descrição, NCM, unidade, tipo do item, conta contábil e custo unitário (e, se trouxerem quantidade diferente, isso aparece nas pendências). O que não dá para resolver sozinho vai para o CSV de pendências.

Cada conversão gera dois arquivos:

| Arquivo | Para quê |
|---|---|
| `SPED_<CNPJ>_<data>.txt` | EFD ICMS/IPI com o bloco H, no leiaute da Receita, para o PVA |
| `DOMINIO_<CNPJ>_<data>.txt` | o inventário no leiaute do `produtos.txt` da Planilha Modelo (sem cabeçalho, separado por `;`: código, descrição, unidade, NCM, CEST, conta contábil, quantidade, valor unitário, valor total, ICMS recuperável), para importar no Domínio |

Os dois saem do mesmo inventário e têm o mesmo total.

## Modelo de planilha para o cliente

`modelos/Modelo_Inventario_Estoque_SPED.xlsx` é a planilha para mandar ao cliente quando ele não tem um relatório de inventário: empresa, CNPJ e data no topo (o app lê dali), uma linha por item com código, descrição, unidade, NCM, CEST, conta contábil, quantidade, valor unitário (o total é calculado) e ICMS recuperável, uma aba de instruções e uma de exemplo. Preenchida, é só arrastar no Estoque SPED. Para mudar o modelo, edite `modelos/gerar_modelo.py` e rode de novo.

## Arquivos de clientes

O conversor foi conferido com inventários reais (relatórios de inventário de matriz e filial com quase 8 mil itens, um `.FS` da Fortes, Estoque Escriturado e a Planilha Modelo): o total do SPED bateu com o total do relatório, a não ser quando o próprio relatório arredonda o total (aí vale a soma das linhas, que é o que o PVA exige no H005, e a diferença aparece nas pendências). Os casos que esses arquivos mostraram estão em `estoque/tests/arquivos` como cópias sintéticas, sem dados de cliente.

No relatório de inventário o código e a descrição vêm na mesma coluna. O app separa pelos primeiros termos com número ou barra (`2022GSG/03 RELOGIO ...`), aceita um prefixo curto de letras (`BG 99100-003-A`, `GC 1999885`) e tira o traço entre os dois (`5095 - EXPOSITOR`). O "P/" de "para" fica na descrição, mesmo tendo barra (`PU11599JS/02 PULS.P/REL. PHALANX`). Sem número no começo, o código é o que vem antes de " - " (`BIP LITE BLACK - SMARTWATCH`) ou um termo curto com hífen (`MW-CX CAIXA EM ACO`). Códigos com espaço separados com segurança geram um aviso só para o arquivo; vão para as pendências do item os casos duvidosos (código antes do " - ", código grudado numa palavra, como `CX2038GSG/01CAIXA`). Linha sem código vira `SEMCOD0001`... e código repetido com outra descrição vira `<código>-2`: os dois casos também vão para as pendências, para conferir com o cliente.

## Observações fiscais

- O período padrão do arquivo é o **segundo mês depois do inventário**, como manda o Guia Prático: o inventário de 31/12/2025 vai na EFD de 02/2026 (e com o leiaute de 2026). Outro período pode ser informado, e aí uma pendência lembra a regra.
- O arquivo leva só o inventário (bloco H), com a apuração (E110) zerada: não transmita como substituto de uma EFD que tem notas e apuração.
- Só o motivo 01 (final do período) é gerado: os motivos 02 a 06 exigem o H020/H030 (CST, base e ICMS de cada item), que os arquivos de inventário não trazem.
- Itens em poder de terceiros ou de terceiros em poder do informante (IND_PROP 1 e 2) saem com o COD_PART e o registro 0150 quando o participante é conhecido: pelo 0150 de um SPED de entrada ou por um CNPJ na coluna "Participante"/"CNPJ do terceiro" da planilha (o app consulta nome e município). Sem participante, o item fica fora do arquivo, que continua válido, e a pendência explica o porquê. A coluna "Qtd. em terceiros" vira um H010 próprio com IND_PROP 1.
- Faltando CEP, endereço ou bairro (registro 0005), CRC do contabilista (0100), ou com município de outra UF, o arquivo sai com pendência: o PVA recusaria.

## O que vira pendência

O app nunca muda nem descarta um dado do cliente sem avisar. Vão para as pendências (e para o CSV ao lado do SPED):

- linha sem código (entra como `SEMCOD0001`), linha de relatório que não casa com o formato, linha sem código nem descrição que tem números;
- números ambíguos (`1.500` sem nenhum outro número com casas decimais no arquivo) e planilhas que misturam vírgula e ponto decimal;
- código ou descrição com caractere que o ISO-8859-1 não tem, código cortado em 60 caracteres, unidade cortada em 6;
- TIPO_ITEM fora da tabela, CEST sem 7 dígitos, NCM sem 8 dígitos, ICMS recuperável maior que o valor do item;
- outra aba da planilha com inventário, itens do arquivo de complemento que não estão no inventário, SPED de entrada com mais de um H005;
- total diferente de quantidade × unitário (fórmula errada na planilha): vale quantidade × unitário, e o item vai para as pendências;
- descrição no limite de tamanho do relatório (cortada), "código" tirado do texto antes do " - " que aparece com descrições diferentes;
- nome no arquivo diferente do nome do CNPJ na Receita (CNPJ digitado errado), inventário fora de 31/12 com o motivo 01;
- unidades fora da tabela ou com duas siglas para a mesma unidade (PCT e PCTE), itens com tipo de indústria e Atividade "Outros".

Avisos que valem para o arquivo todo (NCM faltando no comércio, quantidades arredondadas para 3 casas) aparecem uma vez só, e não em cada item: o filtro "Com pendência" mostra o que é de cada item. Item sem descrição sai como `ITEM <código>` e fica sempre com pendência; se nenhum item do arquivo tem descrição, um aviso geral também pede o cadastro do cliente.

## Corrigir um item no painel

Clique no item (na lista "Todos", "Com pendência" ou "Fora do arquivo") para corrigir código, descrição, NCM, unidade, tipo, quantidade ou valor unitário. "Salvar e gerar de novo" refaz o SPED com a correção, e as conferências do app rodam de novo sobre o valor corrigido: corrigida a quantidade fracionada, a pendência some; com a quantidade preenchida, o item que estava fora entra no arquivo. O item corrigido aparece como **Corrigido**, e "Desfazer correção" volta o que veio do arquivo.

Código, descrição, NCM, unidade e tipo ficam guardados por CNPJ (`ajustes.json`, na pasta de dados) e valem também nos próximos inventários da empresa, para o mesmo item do mesmo arquivo. Quantidade e valor valem só para o inventário aberto. O arquivo do cliente nunca é alterado.

## Vários arquivos juntos

O primeiro arquivo com quantidade e valor é o inventário (a estrela troca qual é); os outros completam descrição, NCM, unidade, tipo e valor pelo código. Um arquivo de **outro estabelecimento** (outro CNPJ, como matriz e filial) ou de **outra data** (o inventário do ano anterior) serve só como cadastro: o app não compara quantidades nem usa valores dele. Para gerar o SPED da matriz e o da filial, converta cada um sozinho.

