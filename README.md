# State of Affairs 🧭

Painel dos meus projetos, publicado no GitHub Pages. Escolho um projeto e vejo:

- nome, resumo e stack;
- as últimas atualizações;
- **snippets**: pedidos curtos de mudança que eu escrevo;
- um botão que manda o contexto do projeto e os snippets marcados para a **API do Claude**, que devolve um prompt pronto para colar no Claude Code. Também dá para montar o prompt sem IA.

Site estático, sem build: `index.html` + `css/` + `js/` + `data/`.

## Publicar

**Settings → Pages → Deploy from a branch → `main` / `(root)`**. O `.nojekyll` já está no repo.
Endereço: `https://guimota111.github.io/stateofaffairs/`.

## Configurar (botão ⚙️ Ajustes, no navegador)

| Campo | Para quê |
|---|---|
| Chave da API do Claude | Gerar o prompt. A chamada sai direto do navegador (`anthropic-dangerous-direct-browser-access`). |
| Modelo | Padrão `claude-opus-5-5`. |
| Token do GitHub | Salvar os snippets no repo. Use um **fine-grained token** com acesso **só** a `stateofaffairs` e permissão **Contents: Read and write**. |
| Repositório / branch | Padrão `guimota111/stateofaffairs` / `main`. |

As chaves ficam no `localStorage` deste navegador e nunca entram no repositório. Sem token do GitHub, os snippets ficam
salvos só no navegador (aparecem como “não sincronizado”) e sobem quando o token for configurado.

> ⚠️ O repositório é público: tudo em `data/` (inclusive resumos de repos privados e os snippets) fica visível.
> Para esconder, deixe o repo privado (Pages em repo privado exige GitHub Pro) ou tire os projetos privados de `projects.json`.

## Dados — contrato para a skill de atualização

A skill que vai manter o site lê e escreve só estes dois arquivos.

### `data/projects.json`

```jsonc
{
  "generatedAt": "AAAA-MM-DD",          // data da última atualização feita pela skill
  "owner": "guimota111",
  "categories": [{ "id": "trabalho", "name": "Laudos & rotina de trabalho" }],
  "projects": [{
    "id": "patoteca",                    // estável; vira o #hash da URL e liga os snippets
    "name": "Patoteca (Clube do Livro)",
    "repo": "guimota111/clubedolivro",
    "visibility": "public | private",
    "category": "trabalho | escalas | estudo | pessoal | outros",
    "status": "ativo | estável | pausado | inicial | protótipo | arquivado | vazio",
    "url": "https://… ou null",          // site no ar
    "stack": ["React", "Vite"],
    "summary": "Resumo breve em 2–3 frases.",
    "lastActivity": "AAAA-MM-DD",        // data do commit mais recente (qualquer branch ativa)
    "updates": [                         // mais recente primeiro; manter ~5–8 itens
      { "date": "AAAA-MM-DD", "text": "O que mudou, em uma frase.", "snippet": "s_… (opcional)" }
    ]
  }]
}
```

### `data/snippets.json`

```jsonc
{
  "version": 1,
  "updatedAt": "ISO-8601",
  "snippets": [{
    "id": "s_mwamyj15lo27",
    "project": "patoteca",               // = projects[].id
    "title": "Modo escuro na estante",
    "body": "Detalhes (opcional)",
    "priority": "alta | normal | baixa",
    "status": "open | done",
    "createdAt": "ISO-8601",
    "doneAt": "ISO-8601 ou null",
    "doneNote": "texto ou null"          // ex.: "feito em abc1234 — tema escuro com toggle"
  }]
}
```

### O que a skill deve fazer

1. Para cada projeto, ler os commits recentes do repo (incluindo branches ativas) e atualizar `updates`, `lastActivity`, `status` e, se mudou muito, `summary`/`stack`.
2. Para cada snippet `open`, verificar nos commits/PRs se a mudança foi feita. Se sim: `status: "done"`, `doneAt`, `doneNote` com o commit/PR, e acrescentar um item em `updates` com `"snippet": "<id>"`.
3. O prompt gerado pelo site pede ao Claude Code um relatório final com o **id de cada snippet** (`[s_…]`) e se foi feito — a skill pode usar esse relatório ou os commits para fechar os snippets.
4. Atualizar `generatedAt` e commitar os dois arquivos.

## Estrutura

```
index.html         casca da página
css/style.css      visual (tema claro/escuro automático)
js/app.js          seletor de projeto, snippets (GitHub Contents API), chamada ao Claude
data/projects.json resumos e atualizações dos projetos
data/snippets.json snippets de mudanças
```
