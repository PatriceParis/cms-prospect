// Mini CRM de consultation des leads. JavaScript natif, aucune dépendance.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_ORDER = ['A_CONTACTER', 'CONTACTE', 'PAS_DE_REP', 'REP_POSITIVE', 'REP_NEGATIVE', 'NE_PAS_CONTACTER'];
const CLOSED = new Set(['REP_NEGATIVE', 'NE_PAS_CONTACTER']);
const FILTERS_KEY = 'crm-filters-v1';
const DEFAULT_FILTERS = { q: '', priority: '', sector: '', phone: '', status: '', unclaimed: false, due: false };

const state = {
  me: null,
  statuses: {},
  channels: {},
  leads: [],
  filters: loadFilters(),
  selectedId: null,
  detail: null,
  draft: null,
};

// --- Utilitaires -------------------------------------------------------------

function loadFilters() {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}
function saveFilters() {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(state.filters)); } catch { /* stockage indisponible */ }
}

function isoDay(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addBusinessDays(n, from = new Date()) {
  const d = new Date(from);
  while (n > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n--;
  }
  return isoDay(d);
}
const today = () => isoDay();
const frDate = iso => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '');
const frDateTime = iso => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function relative(iso) {
  if (!iso) return '';
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} j`;
}
const phoneDisplay = e164 => (e164 && e164.startsWith('+33') ? `0${e164.slice(3)}`.replace(/(\d{2})(?=\d)/g, '$1 ') : e164 || '');
const isDue = l => Boolean(l.next_action_at) && l.next_action_at <= today() && !CLOSED.has(l.crm_status);
const statusBadge = s => `<span class="badge st-${esc(s)}">${esc(state.statuses[s] ?? s)}</span>`;
const phoneTag = kind => ({ fixe: 'fixe', mobile: 'mobile', voip: 'box', autre: 'autre' })[kind] ?? '';

async function api(path, { json, body, headers, ...opts } = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error(data.error || 'Connexion requise');
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// --- Connexion -----------------------------------------------------------------

function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  $('#login-form [name=name]').focus();
}

function onLogged(me) {
  state.me = me.name;
  state.statuses = me.statuses;
  state.channels = me.channels;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = me.name;
  loadLeads();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    onLogged(await api('/api/login', { method: 'POST', json: { name: form.get('name'), password: form.get('password') } }));
    e.target.reset();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', json: {} }).catch(() => {});
  closePanel();
  showLogin();
});

// --- Liste ---------------------------------------------------------------------

async function loadLeads() {
  try {
    state.leads = (await api('/api/leads')).leads;
  } catch (err) {
    $('#rows').innerHTML = '';
    $('#empty').hidden = false;
    $('#empty').textContent = err.message;
    return;
  }
  const sectors = [...new Set(state.leads.map(l => l.search_sector).filter(Boolean))].sort();
  $('#f-sector').innerHTML = `<option value="">Tous secteurs</option>${sectors.map(s => `<option>${esc(s)}</option>`).join('')}`;
  syncFilterInputs();
  render();
}

function matches(l, f, { ignoreStatus = false } = {}) {
  if (f.priority && l.priority !== f.priority) return false;
  if (f.sector && l.search_sector !== f.sector) return false;
  if (f.phone === 'aucun' ? l.phone : f.phone && l.phone_kind !== f.phone) return false;
  if (f.unclaimed && l.claimed) return false;
  if (f.due && !isDue(l)) return false;
  if (!ignoreStatus && f.status && l.crm_status !== f.status) return false;
  if (f.q) {
    const hay = `${l.name} ${l.google_category} ${l.city} ${l.postal_code} ${l.address} ${l.phone} ${phoneDisplay(l.phone)}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

function render() {
  renderKpis();
  renderTabs();
  const rows = state.leads.filter(l => matches(l, state.filters));
  $('#count').textContent = `${rows.length} / ${state.leads.length} leads`;
  $('#empty').hidden = rows.length > 0;
  $('#empty').textContent = 'Aucun lead ne correspond à ces filtres.';
  $('#rows').innerHTML = rows.map(rowHtml).join('');
}

function rowHtml(l) {
  const due = isDue(l);
  return `<tr data-id="${esc(l.place_id)}" class="${l.place_id === state.selectedId ? 'selected' : ''}">
    <td><span class="prio prio-${esc(l.priority)}" title="Score ${esc(l.score)}/8">${esc(l.priority)}</span></td>
    <td><div class="name">${esc(l.name)}</div><div class="sub">${esc(l.google_category)}${l.claimed ? '' : ' · <span class="tag warn">fiche non revendiquée</span>'}</div></td>
    <td class="col-city">${esc(l.city)}<div class="sub">${esc(l.postal_code)}</div></td>
    <td class="col-reviews num">${esc(l.reviews_count)} <span class="sub">· ${esc(l.rating)}★</span></td>
    <td class="num">${l.phone ? `${esc(phoneDisplay(l.phone))} <span class="tag">${esc(phoneTag(l.phone_kind))}</span>` : '<span class="sub">—</span>'}</td>
    <td>${statusBadge(l.crm_status)}</td>
    <td class="num ${due ? 'overdue' : ''}">${esc(frDate(l.next_action_at))}</td>
    <td class="col-last sub">${esc(relative(l.last_activity_at))}</td>
  </tr>`;
}

function renderKpis() {
  const all = state.leads;
  const touched = all.filter(l => l.crm_status !== 'A_CONTACTER');
  const replied = all.filter(l => ['REP_POSITIVE', 'REP_NEGATIVE', 'NE_PAS_CONTACTER'].includes(l.crm_status));
  const positive = all.filter(l => l.crm_status === 'REP_POSITIVE');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
  const kpi = (value, label) => `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  $('#kpis').innerHTML = [
    kpi(all.length, 'leads'),
    kpi(all.filter(l => l.priority === 'A').length, 'priorité A'),
    kpi(all.filter(isDue).length, "à relancer aujourd'hui"),
    kpi(touched.length, 'contactés'),
    kpi(pct(replied.length, touched.length), 'taux de réponse'),
    kpi(positive.length, 'réponses positives'),
  ].join('');
}

function renderTabs() {
  const base = state.leads.filter(l => matches(l, state.filters, { ignoreStatus: true }));
  const count = s => base.filter(l => !s || l.crm_status === s).length;
  const tab = (value, label) =>
    `<button type="button" class="tab" data-status="${esc(value)}" aria-pressed="${state.filters.status === value}">${esc(label)} <span class="n">${count(value)}</span></button>`;
  $('#status-tabs').innerHTML = tab('', 'Tous') + STATUS_ORDER.map(s => tab(s, state.statuses[s] ?? s)).join('');
}

function syncFilterInputs() {
  const f = state.filters;
  $('#f-q').value = f.q;
  $('#f-priority').value = f.priority;
  $('#f-sector').value = f.sector;
  $('#f-phone').value = f.phone;
  $('#f-unclaimed').checked = f.unclaimed;
  $('#f-due').checked = f.due;
}

function setFilter(key, value) {
  state.filters[key] = value;
  saveFilters();
  render();
}

$('#f-q').addEventListener('input', e => setFilter('q', e.target.value.trim()));
$('#f-priority').addEventListener('change', e => setFilter('priority', e.target.value));
$('#f-sector').addEventListener('change', e => setFilter('sector', e.target.value));
$('#f-phone').addEventListener('change', e => setFilter('phone', e.target.value));
$('#f-unclaimed').addEventListener('change', e => setFilter('unclaimed', e.target.checked));
$('#f-due').addEventListener('change', e => setFilter('due', e.target.checked));
$('#status-tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-status]');
  if (btn) setFilter('status', btn.dataset.status);
});
$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openLead(tr.dataset.id);
});

// --- Fiche ---------------------------------------------------------------------

async function openLead(id) {
  state.selectedId = id;
  render();
  const panel = $('#panel');
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    state.detail = await api(`/api/leads/${encodeURIComponent(id)}`);
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  resetDraft();
  renderPanel();
}

function resetDraft() {
  const d = state.detail;
  state.draft = {
    status: d.crm_status,
    channel: d.crm_channel || (d.phone ? 'telephone' : ''),
    note: '',
    nextActionAt: d.next_action_at || '',
  };
}

function closePanel() {
  state.selectedId = null;
  state.detail = null;
  $('#panel').hidden = true;
  render();
}

function renderPanel() {
  const d = state.detail;
  const draft = state.draft;
  const locked = d.crm_status === 'NE_PAS_CONTACTER';
  const mobileWarning = d.phone_kind === 'mobile'
    ? '<p class="notice soft">Numéro mobile : vérifie qu’il s’agit bien de la ligne professionnelle avant d’appeler.</p>'
    : '';

  $('#panel').innerHTML = `
    <div class="panel-head">
      <div>
        <h2>${esc(d.name)}</h2>
        <div class="sub">${esc(d.google_category)} · ${esc(d.search_sector)}</div>
      </div>
      <button type="button" class="ghost" data-action="close" aria-label="Fermer">✕</button>
    </div>
    <div class="row" style="margin-top:10px">
      <span class="prio prio-${esc(d.priority)}">${esc(d.priority)}</span>
      <span class="sub">score ${esc(d.score)}/8</span>
      ${statusBadge(d.crm_status)}
      ${d.claimed ? '<span class="tag">fiche revendiquée</span>' : '<span class="tag warn">fiche non revendiquée</span>'}
    </div>
    <dl class="facts">
      <dt>Téléphone</dt><dd>${d.phone ? `<a href="tel:${esc(d.phone)}">${esc(phoneDisplay(d.phone))}</a> <span class="tag">${esc(phoneTag(d.phone_kind))}</span>` : '—'}</dd>
      <dt>Adresse</dt><dd>${esc(d.address)}, ${esc(d.postal_code)} ${esc(d.city)}</dd>
      <dt>Google</dt><dd>${esc(d.reviews_count)} avis · ${esc(d.rating)}★ · ${esc(d.photos_count)} photos${d.maps_url ? ` · <a href="${esc(d.maps_url)}" target="_blank" rel="noopener noreferrer">Voir la fiche</a>` : ''}</dd>
      ${d.opening_hours ? `<dt>Horaires</dt><dd class="sub">${esc(d.opening_hours)}</dd>` : ''}
      ${d.next_action_at ? `<dt>Relance</dt><dd class="${isDue(d) ? 'overdue' : ''}">${esc(frDate(d.next_action_at))}</dd>` : ''}
    </dl>
    ${mobileWarning}
    ${locked ? '<p class="notice">Opposition enregistrée : ne plus contacter ce lead, sur aucun canal.</p>' : ''}

    <h3>Mettre à jour</h3>
    <form id="lead-form">
      <div class="status-pick" role="group" aria-label="Statut">
        ${STATUS_ORDER.map(s => `<button type="button" class="badge st-${s}" data-pick="${s}" aria-pressed="${draft.status === s}" ${locked && s !== 'NE_PAS_CONTACTER' ? 'disabled' : ''}>${esc(state.statuses[s])}</button>`).join('')}
      </div>
      <div class="form-grid">
        <label>Canal
          <select name="channel">
            <option value="">—</option>
            ${Object.entries(state.channels).map(([k, v]) => `<option value="${esc(k)}" ${draft.channel === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </label>
        <label>Note
          <textarea name="note" rows="3" maxlength="2000" placeholder="Ce qui s’est dit, l’objection, le nom du gérant…">${esc(draft.note)}</textarea>
        </label>
        <label>Relance le
          <div class="row">
            <input type="date" name="next" value="${esc(draft.nextActionAt)}" ${locked ? 'disabled' : ''}>
            <button type="button" data-next="3" ${locked ? 'disabled' : ''}>J+3</button>
            <button type="button" data-next="7" ${locked ? 'disabled' : ''}>J+7</button>
            <button type="button" data-next="" ${locked ? 'disabled' : ''}>Aucune</button>
          </div>
        </label>
        <div class="row">
          <button type="submit" class="primary">Enregistrer</button>
          <span class="error" id="lead-error" role="alert"></span>
        </div>
      </div>
    </form>

    <h3>Historique</h3>
    ${d.activities.length ? `<ol class="timeline">${d.activities.map(activityHtml).join('')}</ol>` : '<p class="muted">Aucune action pour l’instant.</p>'}
  `;
}

function activityHtml(a) {
  const who = `<span class="when">${esc(frDateTime(a.at))} · ${esc(a.author)}</span>`;
  let what = '';
  if (a.kind === 'statut') {
    const channel = a.channel ? ` · ${esc(state.channels[a.channel] ?? a.channel)}` : '';
    what = a.from_status === a.to_status ? `${statusBadge(a.to_status)} nouvelle tentative${channel}` : `${statusBadge(a.from_status)} → ${statusBadge(a.to_status)}${channel}`;
  } else if (a.kind === 'relance') {
    what = a.body ? `Relance prévue le ${esc(frDate(a.body))}` : 'Relance retirée';
  }
  const body = a.kind !== 'relance' && a.body ? `<div class="body">${esc(a.body)}</div>` : '';
  return `<li>${who}<div>${what}</div>${body}</li>`;
}

$('#panel').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  const form = $('#lead-form');
  if (t.dataset.action === 'close') return closePanel();
  if (t.dataset.pick) {
    const s = t.dataset.pick;
    if (s === 'NE_PAS_CONTACTER' && state.detail.crm_status !== s &&
      !confirm('Opposition définitive : ce lead ne pourra plus être recontacté, sur aucun canal. Confirmer ?')) return;
    state.draft = readForm(form);
    state.draft.status = s;
    if (s === 'NE_PAS_CONTACTER' || s === 'REP_NEGATIVE') state.draft.nextActionAt = '';
    else if ((s === 'CONTACTE' || s === 'PAS_DE_REP') && !state.draft.nextActionAt) state.draft.nextActionAt = addBusinessDays(3);
    return renderPanel();
  }
  if (t.dataset.next !== undefined) {
    form.next.value = t.dataset.next ? addBusinessDays(Number(t.dataset.next)) : '';
  }
});

function readForm(form) {
  return {
    status: state.draft.status,
    channel: form.channel.value,
    note: form.note.value,
    nextActionAt: form.next.value,
  };
}

$('#panel').addEventListener('submit', async e => {
  e.preventDefault();
  const d = state.detail;
  const draft = readForm(e.target);
  const payload = {};
  // Même statut + note = nouvelle tentative ; le canal pré-rempli seul ne compte pas.
  const statusTouched = draft.status !== d.crm_status || draft.note.trim() !== '';
  if (statusTouched) {
    payload.status = draft.status;
    payload.channel = draft.channel || null;
  }
  if (draft.note.trim()) payload.note = draft.note;
  if ((draft.nextActionAt || null) !== (d.next_action_at || null)) payload.nextActionAt = draft.nextActionAt || null;
  if (!Object.keys(payload).length) {
    $('#lead-error').textContent = 'Rien à enregistrer.';
    return;
  }
  try {
    state.detail = await api(`/api/leads/${encodeURIComponent(d.place_id)}`, { method: 'POST', json: payload });
    const i = state.leads.findIndex(l => l.place_id === d.place_id);
    if (i >= 0) {
      const { activities, ...fields } = state.detail;
      state.leads[i] = { ...state.leads[i], ...fields, last_activity_at: activities[0]?.at ?? state.leads[i].last_activity_at };
    }
    resetDraft();
    renderPanel();
    render();
  } catch (err) {
    $('#lead-error').textContent = err.message;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#panel').hidden && !$('#import-dialog').open) closePanel();
});

// --- Import ----------------------------------------------------------------------

$('#import-open').addEventListener('click', () => {
  $('#import-result').innerHTML = '';
  $('#import-form').reset();
  $('#import-dialog').showModal();
});
$('#import-close').addEventListener('click', () => $('#import-dialog').close());
$('#import-form').addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('#import-file').files[0];
  if (!file) return;
  const out = $('#import-result');
  const btn = $('#import-submit');
  btn.disabled = true;
  out.textContent = 'Import en cours…';
  try {
    const { ingest: r, score } = await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const out_of_target = r.outOfTarget.length
      ? `<ul>${r.outOfTarget.map(o => `<li>${esc(o.name)} — ${esc(o.reason)}</li>`).join('')}</ul>`
      : '';
    out.innerHTML = `<b>${esc(r.file)}</b> : ${r.rowsRead} lignes, ${r.inserted} nouveaux, ${r.updated} mis à jour, ${r.unchanged} inchangés.
      ${score.scored} leads scorés.${r.outOfTarget.length ? ` ${r.outOfTarget.length} hors cible, écartés :` : ''}${out_of_target}`;
    await loadLeads();
  } catch (err) {
    out.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// --- Démarrage -------------------------------------------------------------------

api('/api/me').then(onLogged).catch(err => showLogin(err.message === 'Connexion requise' ? '' : err.message));
