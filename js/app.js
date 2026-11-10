// State of Affairs — painel dos projetos, snippets e geração de prompt com o Claude.
// Sem build: ES module servido direto pelo GitHub Pages.

const SNIPPETS_PATH = 'data/snippets.json';
const LS = {
  settings: 'soa.settings.v1',
  queue: 'soa.queue.v1',      // operações de snippets ainda não enviadas ao GitHub
  last: 'soa.lastProject.v1',
};
const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  ghToken: '',
  ghRepo: 'guimota111/stateofaffairs',
  ghBranch: 'main',
};

const $ = (s) => document.querySelector(s);
const state = {
  data: null,           // projects.json
  base: { version: 1, updatedAt: null, snippets: [] },  // snippets.json (remoto)
  queue: loadJSON(LS.queue, []),
  settings: { ...DEFAULTS, ...loadJSON(LS.settings, {}) },
  current: null,
  selected: new Set(),  // ids de snippets marcados para o prompt
  syncing: false,
  syncError: null,
};

// ---------- utilidades ----------
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage indisponível */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function uid() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isErr ? 5000 : 2500);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------- snippets: base remota + fila local ----------
function applyQueue(base, queue) {
  const list = base.snippets.map((s) => ({ ...s }));
  for (const op of queue) {
    if (op.op === 'add') {
      if (!list.some((s) => s.id === op.snippet.id)) list.push({ ...op.snippet });
    } else if (op.op === 'update') {
      const s = list.find((x) => x.id === op.id);
      if (s) Object.assign(s, op.patch);
    } else if (op.op === 'delete') {
      const i = list.findIndex((x) => x.id === op.id);
      if (i >= 0) list.splice(i, 1);
    }
  }
  return list;
}
function allSnippets() { return applyQueue(state.base, state.queue); }
function pendingIds() {
  const ids = new Set();
  state.queue.forEach((op) => ids.add(op.op === 'add' ? op.snippet.id : op.id));
  return ids;
}
function enqueue(op) {
  state.queue.push(op);
  saveJSON(LS.queue, state.queue);
  render();
  scheduleSync();
}

const gh = {
  headers() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.settings.ghToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  },
  url() {
    return `https://api.github.com/repos/${state.settings.ghRepo}/contents/${SNIPPETS_PATH}`;
  },
  async read() {
    const r = await fetch(`${this.url()}?ref=${encodeURIComponent(state.settings.ghBranch)}`, { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return { json: { version: 1, updatedAt: null, snippets: [] }, sha: null };
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || r.statusText}`);
    const body = await r.json();
    return { json: JSON.parse(b64decode(body.content)), sha: body.sha };
  },
  async write(json, sha, message) {
    const r = await fetch(this.url(), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: b64encode(JSON.stringify(json, null, 2) + '\n'),
        branch: state.settings.ghBranch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!r.ok) {
      const err = new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || r.statusText}`);
      err.status = r.status;
      throw err;
    }
  },
};

async function loadBase() {
  if (state.settings.ghToken) {
    try {
      state.base = (await gh.read()).json;
      state.syncError = null;
      return;
    } catch (e) {
      state.syncError = e.message;
    }
  }
  try {
    const r = await fetch(`${SNIPPETS_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) state.base = await r.json();
  } catch { /* offline: fica a base vazia + fila local */ }
}

let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 600);
}
function describeQueue(queue) {
  const n = { add: 0, update: 0, delete: 0 };
  queue.forEach((op) => n[op.op]++);
  const parts = [];
  if (n.add) parts.push(`${n.add} novo(s)`);
  if (n.update) parts.push(`${n.update} alteração(ões)`);
  if (n.delete) parts.push(`${n.delete} removido(s)`);
  return `snippets: ${parts.join(', ')}`;
}
async function sync(attempt = 0) {
  if (!state.settings.ghToken || !state.queue.length || state.syncing) { renderBadge(); return; }
  state.syncing = true;
  renderBadge();
  const sending = state.queue.slice();
  try {
    const { json, sha } = await gh.read();
    const merged = { version: 1, ...json, snippets: applyQueue(json, sending) };
    merged.updatedAt = new Date().toISOString();
    await gh.write(merged, sha, describeQueue(sending));
    state.base = merged;
    state.queue = state.queue.slice(sending.length);
    saveJSON(LS.queue, state.queue);
    state.syncError = null;
  } catch (e) {
    state.syncError = e.message;
    if ((e.status === 409 || e.status === 422) && attempt < 2) {
      state.syncing = false;
      return sync(attempt + 1);
    }
    toast('Não consegui salvar no GitHub: ' + e.message, true);
  } finally {
    state.syncing = false;
    render();
    if (state.queue.length && !state.syncError) scheduleSync();
  }
}

// ---------- renderização ----------
function statusClass(s) { return 'st-' + (s || '').toLowerCase(); }
function openCount(projectId) {
  return allSnippets().filter((s) => s.project === projectId && s.status !== 'done').length;
}

function renderPicker() {
  const q = $('#pickerSearch').value.trim().toLowerCase();
  const groups = $('#pickerGroups');
  const html = state.data.categories.map((cat) => {
    const items = state.data.projects.filter((p) => p.category === cat.id).filter((p) => {
      if (!q) return true;
      return [p.name, p.repo, p.summary, p.status, ...(p.stack || [])].join(' ').toLowerCase().includes(q);
    });
    if (!items.length) return '';
    return `<div class="group"><h4>${esc(cat.name)}</h4><div class="proj-grid">${items.map((p) => {
      const n = openCount(p.id);
      return `<button type="button" class="proj-chip${state.current?.id === p.id ? ' active' : ''}" data-id="${esc(p.id)}">
        <span class="n">${esc(p.name)}${n ? `<span class="count" title="snippets abertos">${n}</span>` : ''}</span>
        <span class="m">${esc(p.status)} · ${esc(fmtDate(p.lastActivity))}</span>
      </button>`;
    }).join('')}</div></div>`;
  }).join('');
  groups.innerHTML = html || '<p class="empty">Nenhum projeto encontrado.</p>';
}

function renderProject() {
  const p = state.current;
  $('#projectView').hidden = !p;
  if (!p) { $('#pickerCurrent').textContent = 'Escolha um projeto'; return; }
  $('#pickerCurrent').textContent = p.name;
  document.title = `${p.name} · State of Affairs`;
  $('#pName').textContent = p.name;
  const st = $('#pStatus');
  st.textContent = p.status;
  st.className = 'pill ' + statusClass(p.status);
  $('#pVisibility').textContent = p.visibility === 'private' ? '🔒 privado' : 'público';
  $('#pSummary').textContent = p.summary;
  $('#pStack').innerHTML = (p.stack || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('');
  const links = [`<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener">↗ Repositório</a>`];
  if (p.url) links.unshift(`<a href="${esc(p.url)}" target="_blank" rel="noopener">↗ Abrir o site</a>`);
  links.push(`<a href="https://github.com/${esc(p.repo)}/commits" target="_blank" rel="noopener">↗ Commits</a>`);
  $('#pLinks').innerHTML = links.join('');

  $('#pLast').textContent = p.lastActivity ? `última atividade ${fmtDate(p.lastActivity)}` : '';
  const ups = [...(p.updates || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('#pUpdates').innerHTML = ups.length
    ? ups.map((u) => `<li><div class="d">${esc(fmtDate(u.date))}${u.snippet ? '<span class="from-snippet">✓ snippet</span>' : ''}</div><div>${esc(u.text)}</div></li>`).join('')
    : '<li class="empty" style="border:0">Sem atualizações registradas.</li>';

  renderSnippets();
}

function renderSnippets() {
  const p = state.current;
  if (!p) return;
  const showDone = $('#showDone').checked;
  const pend = pendingIds();
  const order = { alta: 0, normal: 1, baixa: 2 };
  const list = allSnippets()
    .filter((s) => s.project === p.id && (showDone || s.status !== 'done'))
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || order[a.priority] - order[b.priority] || (a.createdAt || '').localeCompare(b.createdAt || ''));

  // seleção padrão: todos os abertos
  list.forEach((s) => { if (s.status !== 'done' && !state.selected.has('x:' + s.id)) state.selected.add(s.id); });

  $('#snippetList').innerHTML = list.length ? list.map((s) => {
    const done = s.status === 'done';
    const checked = !done && state.selected.has(s.id);
    return `<li class="snip${done ? ' done' : ''}" data-id="${esc(s.id)}">
      <input type="checkbox" class="sel" ${checked ? 'checked' : ''} ${done ? 'disabled' : ''} title="Incluir no prompt" aria-label="Incluir no prompt">
      <div>
        <div class="t">${esc(s.title)}</div>
        ${s.body ? `<div class="b">${esc(s.body)}</div>` : ''}
        <div class="meta">
          ${s.priority !== 'normal' ? `<span class="tag ${esc(s.priority)}">${esc(s.priority)}</span>` : ''}
          ${pend.has(s.id) ? '<span class="tag pending">não sincronizado</span>' : ''}
          ${done ? `<span class="tag ok">feito ${esc(fmtDate(s.doneAt))}</span>${s.doneNote ? `<span>${esc(s.doneNote)}</span>` : ''}` : `<span>criado ${esc(fmtDate(s.createdAt))}</span>`}
        </div>
      </div>
      <div class="snip-actions">
        ${done
          ? '<button class="icon-btn" data-act="reopen" title="Reabrir">↺</button>'
          : '<button class="icon-btn" data-act="edit" title="Editar">✎</button><button class="icon-btn" data-act="done" title="Marcar como feito">✓</button>'}
        <button class="icon-btn" data-act="delete" title="Excluir">🗑</button>
      </div>
    </li>`;
  }).join('') : '<li class="empty">Nenhum snippet ainda. Escreva acima o que você quer mudar neste projeto.</li>';

  const sel = selectedSnippets();
  $('#selCount').textContent = sel.length ? `${sel.length} snippet(s) marcado(s)` : 'nenhum snippet marcado';
}

function renderBadge() {
  const b = $('#syncBadge');
  const n = state.queue.length;
  if (!state.settings.ghToken) {
    b.className = 'sync-badge' + (n ? ' pending' : '');
    b.textContent = n ? `${n} só neste navegador` : 'modo leitura';
    b.title = 'Configure um token do GitHub em Ajustes para salvar os snippets no repositório.';
  } else if (state.syncing) {
    b.className = 'sync-badge pending'; b.textContent = 'salvando…'; b.title = '';
  } else if (state.syncError) {
    b.className = 'sync-badge pending'; b.textContent = n ? `${n} pendente(s) · erro` : 'erro'; b.title = state.syncError;
  } else {
    b.className = 'sync-badge' + (n ? ' pending' : ' ok');
    b.textContent = n ? `${n} pendente(s)` : 'sincronizado';
    b.title = `data/snippets.json em ${state.settings.ghRepo}@${state.settings.ghBranch}`;
  }
}

function render() {
  renderPicker();
  renderProject();
  renderBadge();
}

// ---------- seleção / navegação ----------
function setPickerOpen(open) {
  $('#pickerToggle').setAttribute('aria-expanded', String(open));
  $('#pickerPanel').hidden = !open;
  if (open) setTimeout(() => $('#pickerSearch').focus(), 0);
}
function selectProject(id, { push = true } = {}) {
  const p = state.data.projects.find((x) => x.id === id) || null;
  state.current = p;
  state.selected = new Set();
  $('#outputBox').hidden = true;
  $('#extraNotes').value = '';
  if (p) {
    saveJSON(LS.last, p.id);
    if (push && location.hash !== '#' + p.id) history.replaceState(null, '', '#' + p.id);
    setPickerOpen(false);
  }
  render();
  if (p) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function selectedSnippets() {
  if (!state.current) return [];
  return allSnippets().filter((s) => s.project === state.current.id && s.status !== 'done' && state.selected.has(s.id));
}

// ---------- prompt ----------
function projectContext(p) {
  const ups = [...(p.updates || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8);
  return [
    `Projeto: ${p.name}`,
    `Repositório: https://github.com/${p.repo} (${p.visibility === 'private' ? 'privado' : 'público'})`,
    p.url ? `Site no ar: ${p.url}` : null,
    `Status: ${p.status}`,
    `Stack: ${(p.stack || []).join(', ') || '—'}`,
    `Resumo: ${p.summary}`,
    ups.length ? `Últimas atualizações:\n${ups.map((u) => `- ${u.date}: ${u.text}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}
function snippetsBlock(list) {
  return list.map((s, i) => `${i + 1}. [${s.id}] ${s.title}${s.priority !== 'normal' ? ` (prioridade ${s.priority})` : ''}${s.body ? `\n   ${s.body.replace(/\n/g, '\n   ')}` : ''}`).join('\n');
}

function buildLocalPrompt(p, list, extra) {
  return `Você está trabalhando no repositório ${p.repo}.

## Contexto
${projectContext(p)}

## O que mudar
${snippetsBlock(list)}
${extra ? `\n## Instruções extras\n${extra}\n` : ''}
## Como trabalhar
- Leia o código e o README antes de mudar qualquer coisa; siga os padrões que já existem no projeto.
- Implemente cada item acima. Se algum estiver ambíguo, pergunte antes de inventar.
- Rode os checks do projeto (build, lint, testes) antes de commitar.
- Faça commits descritivos em português.

## Ao terminar
Liste, para cada item, o id entre colchetes (ex.: [s_abc123]), se foi feito ou não e uma frase do que mudou. Essa lista será usada para fechar os snippets no State of Affairs.`;
}

const SYSTEM_PROMPT = `Você escreve prompts para o Claude Code, o agente de programação que vai abrir o repositório indicado e implementar mudanças.

Você recebe o contexto de um projeto (resumo, stack, últimas atualizações) e uma lista de "snippets": pedidos curtos de mudança escritos pelo dono do projeto, cada um com um id entre colchetes.

Escreva UM prompt em português do Brasil, pronto para colar no Claude Code, que:
- situe o agente no projeto em poucas linhas (o que é, stack, onde está publicado);
- transforme cada snippet em uma tarefa clara, com o comportamento esperado e critérios de aceite verificáveis, sem inventar requisitos que o dono não pediu; quando um snippet for vago, registre a dúvida como pergunta que o agente deve fazer antes de implementar aquele item;
- agrupe ou ordene as tarefas quando houver dependência entre elas e respeite as prioridades;
- peça que o agente leia o código existente e siga seus padrões, rode os checks do projeto e faça commits descritivos;
- termine pedindo um relatório final com, para cada id de snippet, se foi feito ou não e uma frase do que mudou (esse relatório será usado para fechar os snippets automaticamente).

Responda somente com o prompt, sem introdução nem comentários. Use Markdown simples.`;

async function callClaude(p, list, extra) {
  const { apiKey, model } = state.settings;
  const userMsg = `${projectContext(p)}\n\nSnippets:\n${snippetsBlock(list)}${extra ? `\n\nInstruções extras do dono:\n${extra}` : ''}`;
  const body = {
    model: model || DEFAULTS.model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  };
  const baseHeaders = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const send = (withFallbacks) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: withFallbacks ? { ...baseHeaders, 'anthropic-beta': 'server-side-fallback-2026-07-01' } : baseHeaders,
    body: JSON.stringify(withFallbacks ? { ...body, fallbacks: 'default' } : body),
  });

  let r = await send(true);
  if (r.status === 400) {
    const err = await r.clone().json().catch(() => ({}));
    if (/fallback|beta/i.test(err?.error?.message || '')) r = await send(false);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || r.statusText;
    if (r.status === 401) throw new Error('Chave da API inválida (401). Confira em Ajustes.');
    if (r.status === 429) throw new Error('Limite de requisições atingido (429). Tente de novo em instantes.');
    throw new Error(`API ${r.status}: ${msg}`);
  }
  if (json.stop_reason === 'refusal') {
    throw new Error('O modelo recusou o pedido' + (json.stop_details?.explanation ? `: ${json.stop_details.explanation}` : '.'));
  }
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('A resposta veio vazia.');
  return { text, model: json.model, truncated: json.stop_reason === 'max_tokens', usage: json.usage };
}

function showOutput(text, meta) {
  $('#output').textContent = text;
  $('#outputMeta').textContent = meta;
  $('#outputBox').hidden = false;
  $('#outputBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- eventos ----------
function bindEvents() {
  $('#pickerToggle').addEventListener('click', () => setPickerOpen($('#pickerPanel').hidden));
  $('#pickerSearch').addEventListener('input', renderPicker);
  $('#pickerSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('#pickerGroups .proj-chip'); if (first) selectProject(first.dataset.id); }
    if (e.key === 'Escape' && state.current) setPickerOpen(false);
  });
  $('#pickerGroups').addEventListener('click', (e) => {
    const chip = e.target.closest('.proj-chip');
    if (chip) selectProject(chip.dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); setPickerOpen(true); }
  });
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && id !== state.current?.id) selectProject(id, { push: false });
  });

  $('#showDone').addEventListener('change', renderSnippets);

  $('#snippetForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#snTitle').value.trim();
    if (!title || !state.current) return;
    const snippet = {
      id: uid(),
      project: state.current.id,
      title,
      body: $('#snBody').value.trim(),
      priority: $('#snPriority').value,
      status: 'open',
      createdAt: new Date().toISOString(),
      doneAt: null,
      doneNote: null,
    };
    state.selected.add(snippet.id);
    enqueue({ op: 'add', snippet });
    e.target.reset();
    $('#snTitle').focus();
    toast(state.settings.ghToken ? 'Snippet criado — salvando no GitHub…' : 'Snippet salvo neste navegador.');
  });

  $('#snippetList').addEventListener('click', (e) => {
    const li = e.target.closest('.snip');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) { state.selected.add(id); state.selected.delete('x:' + id); }
      else { state.selected.delete(id); state.selected.add('x:' + id); }
      renderSnippets();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const s = allSnippets().find((x) => x.id === id);
    if (!s) return;
    if (act === 'done') {
      const note = prompt('Nota opcional sobre o que foi feito:', '') ?? null;
      if (note === null) return;
      enqueue({ op: 'update', id, patch: { status: 'done', doneAt: new Date().toISOString(), doneNote: note.trim() || null } });
    } else if (act === 'reopen') {
      enqueue({ op: 'update', id, patch: { status: 'open', doneAt: null, doneNote: null } });
    } else if (act === 'delete') {
      if (confirm(`Excluir o snippet “${s.title}”?`)) enqueue({ op: 'delete', id });
    } else if (act === 'edit') {
      const title = prompt('Título:', s.title);
      if (title === null || !title.trim()) return;
      const body = prompt('Detalhes:', s.body || '');
      if (body === null) return;
      enqueue({ op: 'update', id, patch: { title: title.trim(), body: body.trim() } });
    }
  });

  $('#localPromptBtn').addEventListener('click', () => {
    const list = selectedSnippets();
    if (!list.length) return toast('Marque pelo menos um snippet.', true);
    showOutput(buildLocalPrompt(state.current, list, $('#extraNotes').value.trim()), 'montado localmente, sem IA');
  });

  $('#generateBtn').addEventListener('click', async () => {
    const list = selectedSnippets();
    if (!list.length) return toast('Marque pelo menos um snippet.', true);
    if (!state.settings.apiKey) { toast('Coloque sua chave da API do Claude em Ajustes.', true); return openSettings(); }
    const btn = $('#generateBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Gerando…';
    try {
      const res = await callClaude(state.current, list, $('#extraNotes').value.trim());
      const tokens = res.usage ? ` · ${res.usage.input_tokens}→${res.usage.output_tokens} tokens` : '';
      showOutput(res.text, `gerado por ${res.model}${tokens}${res.truncated ? ' · ⚠️ cortado no limite' : ''}`);
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Gerar prompt com Claude';
    }
  });

  $('#copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#output').textContent); toast('Prompt copiado.'); }
    catch { toast('Não consegui copiar — selecione o texto manualmente.', true); }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsDialog').addEventListener('close', async () => {
    if ($('#settingsDialog').returnValue !== 'save') return;
    const prevToken = state.settings.ghToken;
    state.settings = {
      apiKey: $('#setApiKey').value.trim(),
      model: $('#setModel').value.trim() || DEFAULTS.model,
      ghToken: $('#setGhToken').value.trim(),
      ghRepo: $('#setGhRepo').value.trim() || DEFAULTS.ghRepo,
      ghBranch: $('#setGhBranch').value.trim() || DEFAULTS.ghBranch,
    };
    saveJSON(LS.settings, state.settings);
    toast('Ajustes salvos.');
    if (state.settings.ghToken && state.settings.ghToken !== prevToken) {
      await loadBase();
      render();
      if (state.syncError) toast('GitHub: ' + state.syncError, true);
      else sync();
    }
  });
}

function openSettings() {
  const s = state.settings;
  $('#setApiKey').value = s.apiKey;
  $('#setModel').value = s.model;
  $('#setGhToken').value = s.ghToken;
  $('#setGhRepo').value = s.ghRepo;
  $('#setGhBranch').value = s.ghBranch;
  $('#settingsDialog').showModal();
}

// ---------- início ----------
async function init() {
  bindEvents();
  try {
    const r = await fetch(`data/projects.json?t=${Date.now()}`, { cache: 'no-store' });
    state.data = await r.json();
  } catch (e) {
    document.querySelector('.wrap').innerHTML = `<p class="empty">Não consegui carregar data/projects.json (${esc(e.message)}).</p>`;
    return;
  }
  $('#generatedAt').textContent = `${state.data.projects.length} projetos · atualizado em ${fmtDate(state.data.generatedAt)}`;
  await loadBase();
  const id = location.hash.slice(1) || loadJSON(LS.last, null);
  if (id && state.data.projects.some((p) => p.id === id)) selectProject(id);
  else { render(); setPickerOpen(true); }
  if (state.queue.length) scheduleSync();
}

init();
