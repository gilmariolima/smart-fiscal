# Como instalar o Smart Fiscal

Passo a passo para instalar o Smart Fiscal em qualquer computador com Windows.

## Antes de começar

| Precisa | Detalhe |
|---|---|
| Windows 10 ou 11, 64 bits | quase todo computador atual é 64 bits |
| Uns 500 MB livres no disco | |
| Internet | para baixar, para a busca de notas na SEFAZ e para as atualizações |
| Certificado A1 (.pfx) de cada cliente | só para a busca de notas; o SPED não precisa |

**Não precisa** de senha de administrador, nem de instalar Node, Python, Edge ou Chrome. Tudo vem dentro do instalador.

## 1. Baixar o instalador

1. Abra a página **https://github.com/gilmariolima/smart-fiscal/releases/latest**
2. Lá embaixo, em **Assets**, clique em **`Smart-Fiscal-Setup-<versão>.exe`**.
3. O arquivo vai para a pasta **Downloads**.

> O navegador pode avisar que o arquivo "não é baixado com frequência". No Edge, clique nos três pontinhos do aviso e em **Manter**. No Chrome, clique em **Manter**.

## 2. Instalar

1. Se o computador tem o **SmartDoc**, feche-o antes: botão direito no ícone dele perto do relógio > **Sair do SmartDoc**.
2. Abra a pasta **Downloads** e dê **dois cliques** no `Smart-Fiscal-Setup-<versão>.exe`.
3. Se aparecer a tela azul **"O Windows protegeu o computador"**, clique em **Mais informações** e depois em **Executar assim mesmo**. O aviso aparece porque o programa não tem assinatura digital paga; ele não indica vírus.
4. A instalação é automática e não faz perguntas. Em alguns segundos, o Smart Fiscal abre sozinho.

Ficam dois atalhos **Smart Fiscal**: um na **Área de Trabalho** e outro no **Menu Iniciar**. O app também passa a ligar junto com o Windows, no ícone perto do relógio, para a busca automática de notas funcionar.

**Computador que tinha o SmartDoc ou o Estoque SPED:** na primeira vez, o Smart Fiscal copia os clientes, certificados, notas, empresas e SPEDs deles e avisa o que trouxe. Depois disso, pode desinstalar os dois (Configurações → Aplicativos).

## 3. Primeiro uso (uma vez só)

Quem veio do SmartDoc e do Estoque SPED já tem tudo isso e pode pular esta parte.

1. **Cadastros → Contador do SPED:** preencha nome, CPF, CRC, e-mail e município (código IBGE) do contador e clique em **Salvar**. Sem isso, o SPED sai sem o registro 0100, e o PVA recusa.
2. **Cadastros → Clientes → Novo cliente:** CNPJ, razão social, UF e o certificado A1 com a senha, para cada cliente que vai ter as notas buscadas.
3. A busca de notas já trabalha em **produção** (as notas reais da SEFAZ). Não há nada para trocar.

## 4. Usar

- **Notas fiscais:** o Smart Fiscal busca sozinho nos horários marcados (padrão: 8h e 13h). Para buscar na hora, use **Capturar agora** no Início ou, no ícone perto do relógio, **Buscar notas agora**. As notas ficam em **Notas**, por cliente, ano e mês; **Exportar** gera o pacote do mês para o Domínio e o Fortes.
- **SPED Fiscal:** em **Converter inventário**, arraste os arquivos do cliente (relatório de inventário, `.FS` da Fortes, bloco H ou planilha). Confira os dados da empresa (o que estiver em vermelho falta preencher), clique nos itens com **Pendência** para corrigir e use **Baixar SPED** (para o PVA) ou **Baixar para o Domínio**. Os arquivos ficam em **Arquivos gerados**.

## Atualizar

É automático: o Smart Fiscal baixa a versão nova sozinho e pergunta se quer **Reiniciar agora**. Se escolher **Depois**, ela é instalada quando o programa for fechado. Também dá para baixar o instalador novo (passo 1) e instalar por cima: os dados continuam.

## Onde ficam os dados

Cole o caminho abaixo na barra de endereço do Explorador de Arquivos (ou use **Abrir pasta de dados** no menu do ícone perto do relógio):

```
%LOCALAPPDATA%\Smart Fiscal\dados
```

| Pasta | O que é |
|---|---|
| `notas\` | clientes, certificados, notas, XMLs, exportações e o `.env` com a chave dos certificados |
| `estoque\` | empresas, contador e SPEDs gerados |

**Guarde uma cópia do arquivo `notas\.env`** num lugar seguro: sem ele, os certificados cadastrados não abrem.

**Levar para outro computador:** instale o Smart Fiscal no computador novo, saia dele (ícone perto do relógio > Sair), copie a pasta `dados` do computador antigo por cima da nova e abra de novo.

## Desinstalar

**Configurações → Aplicativos → Aplicativos instalados → Smart Fiscal → Desinstalar.**

A pasta `dados` não é apagada, para não perder os cadastros. Para remover tudo, apague também a pasta `%LOCALAPPDATA%\Smart Fiscal`.

## Problemas comuns

| Problema | O que fazer |
|---|---|
| O antivírus da empresa bloqueia o instalador | Peça ao TI para liberar o arquivo `Smart-Fiscal-Setup-<versão>.exe`. |
| Fechei a janela e o programa "sumiu" | Ele continua ligado: clique no ícone perto do relógio (pode estar escondido na setinha ^). |
| Ao abrir de novo, nada acontece | O programa já está aberto: procure a janela na barra de tarefas ou clique no ícone perto do relógio. |
| O SPED mostra "O motor do SPED não ligou" | Saia do Smart Fiscal pelo ícone perto do relógio e abra de novo. Se continuar, mande o arquivo `estoque\painel.log` da pasta de dados. |
| A busca de notas dá erro 656 (consumo indevido) | Outro programa está consultando o mesmo CNPJ (por exemplo, o SmartDoc antigo ainda ligado). Saia do SmartDoc e desinstale. O Smart Fiscal tenta de novo depois de 1 hora. |
