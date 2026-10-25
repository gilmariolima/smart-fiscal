# Smart Fiscal

O app do escritório para duas rotinas fiscais, numa janela só:

- **Notas fiscais:** busca na SEFAZ as NF-e emitidas contra os clientes, dá ciência, baixa os XMLs, organiza por cliente e mês e exporta para o Domínio e o Fortes. Funciona sozinho nos horários marcados. Também importa e confere os **cupons fiscais (CF-e do SAT/MFE)** dos clientes. Detalhes em [docs/NOTAS.md](docs/NOTAS.md).
- **SPED Fiscal:** converte o inventário do cliente (relatório, `.FS` da Fortes, bloco H ou planilha) no SPED EFD ICMS/IPI com o bloco H, pronto para o PVA, com as pendências para conferir e a correção dos itens no próprio painel. Detalhes em [docs/SPED.md](docs/SPED.md).

Junta o antigo **SmartDoc** (notas) e o antigo **Estoque SPED** (inventário), com a estrutura, a atualização automática e o visual do Estoque SPED.

**Para instalar em qualquer computador:** baixe o instalador na [última versão](https://github.com/gilmariolima/smart-fiscal/releases/latest) e siga o passo a passo em [INSTALAR.md](INSTALAR.md).

## Como o app funciona

- Abre numa janela própria, com o menu lateral dividido em **Notas fiscais**, **SPED Fiscal** e **Cadastros**.
- **Fechar a janela não desliga o app.** Ele fica no ícone perto do relógio, e a busca automática de notas continua nos horários. Para abrir de novo, clique no ícone; para desligar de vez, use botão direito no ícone > **Sair do Smart Fiscal**.
- **Liga junto com o Windows**, direto no ícone perto do relógio, sem abrir a janela. Dá para desligar em "Iniciar com o Windows", no menu do ícone.
- **Atualiza sozinho.** Ao abrir, e a cada 6 horas, procura uma versão nova em Releases e baixa em segundo plano; quando termina, pergunta se reinicia agora ou instala ao fechar. Sem internet, nada acontece (o que houve fica em `atualizacao.log`, na pasta de dados).
- Abrir o atalho com o app já ligado só traz a janela para a frente.

Por dentro são dois motores: o das **notas** (Node, o servidor do antigo SmartDoc, que roda dentro do app e serve o painel) e o do **SPED** (Python embutido, o motor do antigo Estoque SPED, que roda à parte numa porta livre). O painel repassa `/estoque` para o motor do SPED com o token daquela execução; nada fica aberto para outros programas ou outros computadores.

## Dados

Ficam em `%LOCALAPPDATA%\Smart Fiscal\dados`, fora da pasta do programa. Atualizar ou desinstalar **nunca** apaga os dados.

| Pasta | O que tem |
|---|---|
| `notas\` | `.env` (com a `MASTER_KEY` que abre os certificados), banco, certificados, XMLs, exportações e logs das notas |
| `estoque\` | empresas, correções de itens, contador do SPED, SPEDs gerados (`saida\`, ou a pasta escolhida em Arquivos gerados) e o `painel.log` do SPED |
| `atualizacao.log` | o que a atualização automática fez |

**Guarde uma cópia do `notas\.env`**: sem a `MASTER_KEY`, os certificados cadastrados não abrem.

### Vindo do SmartDoc e do Estoque SPED

Na primeira vez, o Smart Fiscal **copia** os dados dos dois (`%LOCALAPPDATA%\SmartDoc\dados` e `%LOCALAPPDATA%\Estoque SPED\dados`) para as pastas `notas\` e `estoque\`. Nada é apagado: os apps antigos continuam com os dados deles.

- O SmartDoc tem de estar fechado na hora da cópia (o banco aberto poderia sair copiado pela metade). Se estiver aberto, o Smart Fiscal pede para fechá-lo.
- Depois da cópia, o SmartDoc deixa de ligar com o Windows: dois programas buscando as mesmas notas na SEFAZ dão erro de consumo indevido.
- A cópia só acontece para a parte que ainda está vazia no Smart Fiscal. Depois, pode desinstalar o SmartDoc e o Estoque SPED.

## Publicar uma versão nova

O GitHub gera o instalador sozinho:

1. Aumente o `version` do `package.json` (ex.: `npm version 1.1.0 --no-git-tag-version`) e junte na `main`.
2. Em **Actions → Publicar versão → Run workflow** (com `main` escolhida), clique em **Run workflow**. O GitHub cria a versão `v<versão>` com o número do `package.json`.
3. O workflow (`.github/workflows/publicar.yml`) roda os testes, gera o instalador num Windows e anexa à versão o `Smart-Fiscal-Setup-<versão>.exe` e o `latest.yml` que a atualização automática lê. Leva uns 5 minutos.

Também dá para criar a versão à mão em **Releases → Draft a new release**, com a tag `v<versão>` na `main`. Se a tag não bater com o `package.json`, ou se a versão já existir, o workflow para e diz o que fazer. Os testes também rodam sozinhos (workflow **Testes**) em todo pull request e a cada mudança na `main`.

**Gerar o instalador no próprio computador** (para testar antes de publicar; Windows 64 bits, Node 22+ e internet):

```powershell
npm ci
npm run pacote
```

Sai em `pacote\Smart-Fiscal-Setup-<versão>.exe`, sem publicar nada. O `npm run pacote` monta antes o Python embutido do SPED (`estoque\python`: o Python 3.12 *embeddable* oficial com openpyxl, et_xmlfile e xlrd, conferidos pelo sha256); sem internet, use `npm run preparar-python -- --zip python-3.12.10-embed-amd64.zip`.

## Desenvolvimento

```powershell
npm install               # instala e compila o painel (vite build)
npm run preparar-python   # só no Windows; fora dele o SPED usa o python3 do sistema
npm run app               # abre o app a partir do código
npm test                  # todos os testes: notas, app e ponte (Node) e o motor do SPED (Python)
npm run painel:dev        # painel com recarga automática (o servidor precisa estar rodando)
```

| Pasta | O que tem |
|---|---|
| `electron/` | o app: janela, ícone perto do relógio, os dois motores, pasta de dados, cópia dos apps antigos e atualização automática |
| `src/` | motor das notas: SEFAZ, banco SQLite, agendador e o servidor do painel (com a ponte `/estoque`) |
| `painel/` | o painel (React): telas das notas em `telas/`, do SPED em `sped/`, visual em `estilo.css` |
| `estoque/` | motor do SPED em Python (`gerar_sped.py`, `painel.py`) e os testes dele |
| `test/` | testes do motor das notas, do app e da ponte com o SPED |
| `modelos/` | Planilha Modelo de inventário para o cliente |
| `scripts/` | montagem do Python embutido |
| `docs/` | o que cada parte faz, as regras da SEFAZ e as observações fiscais |
| `.github/workflows/` | testes a cada pull request e publicação da versão |
