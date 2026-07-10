# Migração ADM x Dino — Espaços Confinados

## Modo fácil: clique duplo

Dê duplo clique em **`rodar-migracao.bat`**. Na primeira vez ele pergunta a
URL da API, e-mail/senha do manager e o ID da Unity, salva isso em
`config.txt` (ao lado do .bat) e reaproveita da próxima vez. Ele roda tudo em
sequência: gera os dados da planilha → extrai as fotos → mostra um relatório
do que vai mudar → pede confirmação (`SIM`) → só então grava de verdade no
Dino. Pode rodar quantas vezes quiser, é seguro (nunca duplica nada).

Se quiser trocar o e-mail/senha/URL depois, é só apagar `config.txt` que ele
pergunta de novo.

Arquivos nesta pasta:
- `rodar-migracao.bat` — clique duplo, roda tudo (recomendado).
- `build_import_data.py` — lê as duas planilhas ("De-Para ADM x Dino Classificado.xlsx" e "Planilha Eletrônica do Inventário de E.C.xlsx"), filtra as linhas "Verde" e gera `import_data.json`.
- `extract_images.py` — extrai as fotos que estão **coladas dentro da própria planilha** (coluna "Foto" da aba "2-Base de dados gerais") para a pasta `extracted_images/`.
- `import_data.json` — os 102 registros já processados, prontos para importar.
- `reconcile.js` — script que efetivamente grava no Dino via API (chamado pelo .bat, mas pode ser rodado sozinho — veja abaixo).

## Reprocessando a planilha (ex.: rodar de novo em produção)

Por padrão, `build_import_data.py` procura as duas planilhas numa pasta
`planilha adm` ao lado desta (`../planilha adm`, igual está hoje no seu
Desktop). Se as planilhas estiverem em outro lugar — por exemplo, se você
levar essa pasta `dino-adm-migration` pra outra máquina/servidor —, aponte
para o local correto:

```bash
export PLANILHAS_DIR="/caminho/para/a/pasta/com/as/duas/planilhas"
python build_import_data.py
```

Isso regenera `import_data.json` do zero a partir das planilhas atuais —
rode de novo sempre que quiser reconferir os dados antes de rodar o
`reconcile.js` (por exemplo, se a planilha for atualizada, ou pra reexecutar
a verificação em produção com as mesmas duas planilhas que estarão lá).

## Como rodar em produção

### 1. Pré-requisitos
- Node.js instalado na máquina onde for rodar (o script usa `axios`, que já vem no `node_modules` do Dino-Server — aponte `NODE_PATH` pra lá, ou rode `npm install axios` dentro desta pasta).
- Um usuário **manager** de produção com permissão de **edit** no módulo Inventários, e acesso à Unity de destino.
- O **ID da Unity** de produção onde os espaços devem entrar (não o nome — pegue o UUID).

### 2. Variáveis de ambiente

```
BASE_URL=https://sua-api-de-producao.com   # (padrão: http://localhost:3000)
MIGRATION_EMAIL=email-do-manager@empresa.com
MIGRATION_PASSWORD=senha-do-manager
CLIENT_NAME=Archer Daniels Midland          # nome do tenant/cliente, como aparece no Dino
UNITY_NAME=São Lourenço da Mata             # nome da unidade dentro desse cliente
```

O script faz login, olha a lista de clientes/unidades que esse manager tem
acesso, e resolve `CLIENT_NAME`/`UNITY_NAME` para o UUID certo sozinho
(comparação ignora acento/maiúsculas). Se preferir, ainda dá pra pular essa
busca e informar o UUID direto com `UNITY_ID=...` (é o que o modo de teste
local usa) — nesse caso `CLIENT_NAME`/`UNITY_NAME` são ignorados.

### 3. Primeiro, SEMPRE rode em modo relatório (não grava nada)

```bash
export RECONCILE_REPORT_ONLY=true
export BASE_URL=... MIGRATION_EMAIL=... MIGRATION_PASSWORD=... UNITY_ID=...
node reconcile.js
```

Isso gera `reconcile_report.json` com o plano completo, sem tocar no banco. Confira:

- **`created`** — espaços que ainda não existem em produção e seriam criados do zero.
- **`filledGaps`** — espaços que já existem e teriam campos vazios preenchidos (mostra quais campos exatamente, e se ganharia bocas de visita novas).
- **`alreadyMatched`** — espaços onde não há nada a fazer.
- **`mismatches`** — **revise isso com atenção**: espaços onde o valor já cadastrado é DIFERENTE do valor da planilha. O script nunca sobrescreve isso sozinho; decida manualmente se corrige.
- **`rescueCatalogMissing`** — espaços cujo tipo de resgate esperado não foi encontrado no catálogo da Unity, nem por aproximação (nesse caso, alguém precisa cadastrar esse método de resgate manualmente antes, o script **nunca cria** um novo, só vincula aos que já existem).
- **Seção `rescue-fuzzy-match`** dentro de `mismatches` — o nome do método de resgate no catálogo de produção não bate 100% com o nome que veio da planilha, mas achei uma correspondência por aproximação (mesmo "Tipo XX" e "Terrestre"/"Suspenso"). **Revise isso manualmente** antes de confiar — o script vincula mesmo assim, mas avisa que não foi um match exato, já que você me disse que em produção os métodos de resgate já existem cadastrados e podem ter nomes escritos de forma um pouco diferente da planilha.
- **`manholesSkipped`** — espaços que já tinham boca(s) de visita cadastradas; não foram tocados para evitar duplicar.
- **`failed`** — erros de execução (rede, permissão, etc.). Quando um registro falha em modo LIVE, o script tenta automaticamente descartar (`discard`) qualquer rascunho de Geral/Ventilação/Resgate que tenha ficado aberto/pela metade daquela tentativa naquele espaço específico, pra não deixar nada preso — se não houver nada pra descartar, isso é ignorado silenciosamente.

### 4. Depois de revisar o relatório, rode de verdade

```bash
unset RECONCILE_REPORT_ONLY
node reconcile.js
```

O script é **idempotente**: pode rodar de novo sem medo — ele sempre confere o que já existe antes de criar ou preencher algo.

Enquanto roda, ele mostra no terminal, registro por registro (`[3/102] TQ 07 -
Tanque 07`), exatamente o que está fazendo: criando instalação/área, criando
o espaço, preenchendo quais campos, anexando qual foto, vinculando qual
resgate. Nada acontece silenciosamente.

## Como desfazer (rollback)

Toda vez que `reconcile.js` roda em modo LIVE (gravação real) e faz pelo
menos uma alteração, ele salva um arquivo
`migration_journal_<data-hora>.json` nesta pasta com a lista exata de tudo
que foi feito, na ordem em que foi feito. No fim da execução ele mostra o
comando pronto para desfazer:

```bash
node rollback.js "migration_journal_2026-07-10T13-41-38-443Z.json"
```

O rollback usa as mesmas variáveis de ambiente (`BASE_URL`,
`MIGRATION_EMAIL`, `MIGRATION_PASSWORD`, `CLIENT_NAME`/`UNITY_NAME` ou
`UNITY_ID`) e desfaz as ações na ordem inversa, uma por uma, sem parar se
uma falhar:

- **Fotos anexadas** → removidas (só a referência daquela foto específica).
- **Bocas de visita criadas** → removidas, mas só as que este run criou —
  se alguém adicionou outra boca de visita manualmente depois, ela é
  preservada.
- **Campos preenchidos** (Geral/Ventilação) → voltam para vazio, só os
  campos exatos que este run preencheu.
- **Vínculo de resgate** → desfeito, mas só se ninguém trocou o vínculo
  depois (se trocou, o rollback pula e avisa, nunca sobrescreve).
- **Espaço confinado criado do zero** → é **desativado** (`isActive:
  false`), não excluído — o Dino não tem endpoint de exclusão de espaço
  confinado, então desativar é a mesma ação reversível que um manager teria
  disponível pela tela, e mantém o histórico de auditoria intacto.
- **Instalação/Área criada** → **não é excluída automaticamente** (fica só
  listada no relatório do rollback para revisão manual) — como outros
  espaços do mesmo run (ou já existentes) podem estar usando a mesma
  instalação/área, excluir automaticamente arriscaria quebrar outros
  registros. Se ficar vazia e você quiser mesmo removê-la, tem endpoint de
  exclusão nessas duas telas do próprio Dino.

Um relatório `..._rollback_report.json` é salvo ao lado do journal com o que
foi revertido, ignorado e o que falhou.

⚠️ O rollback só é seguro/preciso enquanto ninguém mais mexeu nesses mesmos
espaços confinados entre o run e o rollback — por isso, se algo der errado,
o ideal é rodar o rollback o quanto antes.

## O que o script faz (resumo)

Para cada um dos 102 espaços da planilha:
1. Garante que a Instalação e a Área existem (cria se faltar).
2. Procura um espaço confinado existente com a mesma tag na mesma instalação.
   - **Não existe** → cria do zero (Geral + Ventilação + Resgate).
   - **Já existe** → só preenche os campos que estiverem vazios; nunca sobrescreve o que já tem.
3. Bocas de visita: só adiciona se o espaço ainda não tiver nenhuma cadastrada.
4. Resgate: só vincula ao método já existente no catálogo da Unity (não cria método novo) — se o espaço já estiver vinculado a algum, não mexe.

## Fotos das bocas de visita

A aba "2-Base de dados gerais" da planilha de inventário tem uma foto **colada
dentro da própria célula** (coluna "Foto") para cada um dos 188 espaços — não
é um link, é a imagem de verdade embutida no arquivo .xlsx. `extract_images.py`
extrai essas 188 fotos (mais as 188 da coluna "Foto do Equip. Resgate", que
não são usadas por enquanto) para `extracted_images/`, casando cada uma pelo
Nº de Cadastro ADM.

`reconcile.js` pega essa foto e anexa em **todas as bocas de visita** do
espaço (a mesma foto repetida em cada uma, já que a planilha só tem 1 foto
por espaço, não uma por boca de visita) — só nas que ainda não tiverem
nenhuma imagem (nunca duplica). A legenda de cada uma é numerada por ordem
de criação: "Boca de visita 1", "Boca de visita 2", etc. Também anexa a
mesma foto no campo geral "Imagens do Espaço Confinado".

Se precisar corrigir legendas antigas (de antes dessa convenção) pra esse
padrão "Boca de visita N", rode `node normalize_captions.js` — só atualiza o
texto da legenda, não mexe nas imagens.

Os **links do Google Drive** de cada espaço (coluna "Link das Fotos") NÃO são
baixados automaticamente — testei 4 formas diferentes (download direto,
fetch via JavaScript, canvas, ponte entre ferramentas de automação) e todas
esbarram em bloqueios de segurança do Drive/navegador que não dá pra
contornar. Esses links ficam salvos em `customFieldsJson.linkFotos` /
`referenceDocument` do cadastro geral, como referência, mas o upload dessas
fotos específicas (se quiser mais do que a 1 já extraída da planilha)
precisa ser manual.

## Disposição, Local, Escada e Campos Customizados

- **Disposição (Vertical/Horizontal)**: a planilha não tem essa coluna, então é derivada — se tem valor em "Altura", é Vertical (equipamento em pé); se não tem Altura mas tem "Comprimento", é Horizontal (deitado).
- **Local**: cópia direta da coluna "Local ou Área" da planilha (ex.: "Fábrica 1 / Externa") — não precisa derivar nada, já vem pronta.
- **Possui escada?**: verdadeiro se a palavra "escada" aparecer no Acesso Interno OU no Acesso Externo (ex.: "Acesso Externo: Escada 90º" já conta).
- **Campos Customizados** (seção "Custom Fields" na tela): Formato Geométrico, Tipo de Iluminação, Acesso Externo, Acesso Interno.

⚠️ Importante: o campo `customFieldsJson` só aparece na tela se seguir o formato exato `{blocks: [{id, type:"field", content:{label, value}}, ...]}` — um dicionário simples de chave/valor fica invisível (foi um bug que corrigi nesta rodada). Se for adicionar mais campos customizados no futuro, siga esse mesmo formato.

## O que NÃO é preenchido (por decisão ou por falta de campo)

- **Riscos** — deixado de fora a pedido.
- **Energias Perigosas** — deixado em branco por enquanto.
- **Elaborado por**, **Situação (Ativo/Desativado)**, **Empresa/Nº E.C./Responsável Técnico (ADM)**, **Data de Revisão**, **Quantidade de B.V.**, **BV≥600mm** — não existe campo próprio no Dino para esses hoje; não são migrados (nem para customFieldsJson, que é invisível na tela).
- **Blocos customizados do Resgate** ("Instalação de POAnco"/"Sistema"/"Plano de Salvamento" completo que eu tinha guardado em `RescueMethod.customFieldsJson.blocks`) — o editor de Resgate usa uma estrutura de colunas/drag-and-drop bem mais complexa que ainda não replico corretamente; esse texto pode não aparecer na aba "Campos Customizados" do Resgate. Ainda não corrigi isso.
