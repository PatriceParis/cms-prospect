// Mini CRM de prospection. JavaScript natif, aucune dépendance.
// Deux vues : « Aujourd'hui » (la file de travail du SDR) et « Tous les leads ».
import { buildScripts, SETTINGS_KEY } from '/scripts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_ORDER = ['A_CONTACTER', 'CONTACTE', 'PAS_DE_REP', 'REP_POSITIVE', 'REP_NEGATIVE', 'NE_PAS_CONTACTER'];
const CLOSED = new Set(['REP_NEGATIVE', 'NE_PAS_CONTACTER']);
const DAILY_NEW = 15; // nouveaux leads proposés chaque jour, en plus des relances
const PREFS_KEY = 'crm-prefs-v2';
const DEFAULT_FILTERS = { q: '', priority: '', sector: '', phone: '', reach: '', status: '', unclaimed: false, due: false };

// Résultats en un clic : statut, relance automatique (jours ouvrés) et effet affiché.
const OUTCOMES = [
  { key: 'noanswer', label: 'Pas de réponse', hint: 'Relance dans 2 jours ouvrés', status: 'PAS_DE_REP', days: 2, outbound: true },
  { key: 'contacted', label: 'Contacté, en attente', hint: 'Message laissé ou envoyé · relance J+3', status: 'CONTACTE', days: 3, outbound: true },
  { key: 'positive', label: 'Intéressé', hint: 'Rappel prévu demain', status: 'REP_POSITIVE', days: 1, tone: 'positive' },
  { key: 'negative', label: 'Pas intéressé', hint: 'Sort de la file', status: 'REP_NEGATIVE', days: null },
  { key: 'optout', label: 'Ne plus contacter', hint: 'Opposition définitive, tous canaux', status: 'NE_PAS_CONTACTER', days: null, tone: 'danger' },
];

const EMAIL_SOURCES = {
  instagram_contact: 'bouton Contact Instagram',
  instagram_bio: 'bio Instagram',
  google_extrait: 'bio Instagram (cache Google)',
  fullenrich_pro: 'FullEnrich, pro',
  fullenrich_perso: 'FullEnrich, perso',
};

const prefs = loadPrefs();
const state = {
  view: prefs.view ?? 'today',
  filters: { ...DEFAULT_FILTERS, ...prefs.filters },
  sort: prefs.sort ?? { key: 'score', dir: 'desc' },
  statuses: {},
  channels: {},
  leads: [],
  navIds: [],
  selectedId: null,
  detail: null,
  pickChannel: 'telephone',
  scriptTab: 'call',
  settings: loadSettings(),
};

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

// --- Utilitaires -----------------------------------------------------------------

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, filters: state.filters, sort: state.sort }));
  } catch { /* stockage indisponible : on garde les réglages en mémoire */ }
}

const PARIS_DAY = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' });
const parisDay = d => PARIS_DAY.format(d);
const today = () => parisDay(new Date());
const dayOf = iso => (iso ? parisDay(new Date(iso)) : null);

function isoDay(d) {
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

// Créneau de contact du cahier des charges : du lundi au vendredi, 9 h-18 h, heure de Paris.
function inCallWindow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now).map(p => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  return !['Sat', 'Sun'].includes(parts.weekday) && hour >= 9 && hour < 18;
}

const frDate = iso => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '');
const frLongDate = () => new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
const frDateTime = iso => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function relative(iso) {
  if (!iso) return '';
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} j`;
}

const phoneDisplay = e164 => (e164 && e164.startsWith('+33') ? `0${e164.slice(3)}`.replace(/(\d{2})(?=\d)/g, '$1 ') : e164 || '');
const phoneTag = kind => ({ fixe: 'fixe', mobile: 'mobile', voip: 'box', autre: 'autre' })[kind] ?? '';
const whatsappLink = e164 => `https://wa.me/${String(e164).replace(/\D/g, '')}`;
const contactName = l => [l.contact_first_name, l.contact_last_name].filter(Boolean).join(' ');
const isDue = l => Boolean(l.next_action_at) && l.next_action_at <= today() && !CLOSED.has(l.crm_status);
const contactedToday = l => dayOf(l.last_attempt_at) === today();
const statusBadge = s => `<span class="badge st-${esc(s)}">${esc(state.statuses[s] ?? s)}</span>`;
const prioBadge = l => `<span class="prio prio-${esc(l.priority)}" title="Score ${esc(l.score)}/8">${esc(l.priority)}</span>`;
const channelTags = l =>
  [l.instagram && 'Instagram', l.email && 'E-mail', l.linkedin_url && 'LinkedIn'].filter(Boolean).map(c => `<span class="tag ch">${c}</span>`).join(' ');

function toast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3500);
}

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

// --- Connexion -------------------------------------------------------------------

function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  $('#login-form [name=password]').focus();
}

function onLogged(meta) {
  state.statuses = meta.statuses;
  state.channels = meta.channels;
  $('#login').hidden = true;
  $('#app').hidden = false;
  loadLeads();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    onLogged(await api('/api/login', { method: 'POST', json: { password: new FormData(e.target).get('password') } }));
    e.target.reset();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

// --- Chargement et vues ------------------------------------------------------------

async function loadLeads() {
  try {
    state.leads = (await api('/api/leads')).leads;
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  const sectors = [...new Set(state.leads.map(l => l.search_sector).filter(Boolean))].sort();
  $('#f-sector').innerHTML = `<option value="">Tous secteurs</option>${sectors.map(s => `<option>${esc(s)}</option>`).join('')}`;
  syncFilterInputs();
  render();
}

function setView(view) {
  state.view = view;
  savePrefs();
  render();
}

function render() {
  for (const tab of document.querySelectorAll('.view-tab')) tab.setAttribute('aria-current', tab.dataset.view === state.view ? 'page' : 'false');
  $('#view-today').hidden = state.view !== 'today';
  $('#view-all').hidden = state.view !== 'all';
  const queue = todayQueue();
  $('#today-count').textContent = queue.due.length + queue.fresh.length;
  $('#all-count').textContent = state.leads.length;
  if (state.view === 'today') renderToday(queue);
  else renderAll();
}

document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.view)));

// --- Vue Aujourd'hui -----------------------------------------------------------------

const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.reviews_count ?? 0) - (a.reviews_count ?? 0);

function todayQueue() {
  const open = state.leads.filter(l => !CLOSED.has(l.crm_status) && !contactedToday(l));
  const due = open.filter(isDue).sort((a, b) => a.next_action_at.localeCompare(b.next_action_at) || byScore(a, b));
  const done = state.leads.filter(contactedToday);
  // Quota de nouveaux leads par jour : ceux contactés pour la première fois aujourd'hui le consomment.
  const quota = Math.max(0, DAILY_NEW - done.filter(l => dayOf(l.first_attempt_at) === today()).length);
  const fresh = open.filter(l => l.crm_status === 'A_CONTACTER' && !l.next_action_at).sort(byScore).slice(0, quota);
  return { due, fresh, done };
}

function quickActions(l) {
  if (CLOSED.has(l.crm_status)) return '';
  const links = [];
  if (l.phone) links.push(`<a class="btn sm" href="tel:${esc(l.phone)}">Appeler</a>`);
  if (l.phone_kind === 'mobile') links.push(`<a class="btn sm" href="${esc(whatsappLink(l.phone))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
  if (l.instagram) links.push(`<a class="btn sm" href="https://ig.me/m/${esc(l.instagram)}" target="_blank" rel="noopener noreferrer">DM Instagram</a>`);
  if (l.email) links.push(`<a class="btn sm" href="mailto:${esc(l.email)}">E-mail</a>`);
  return links.join('');
}

function queueItem(l, why) {
  const who = [contactName(l), l.google_category, l.city].filter(Boolean).map(esc).join(' · ');
  return `<li class="q-item ${l.place_id === state.selectedId ? 'selected' : ''}" data-id="${esc(l.place_id)}">
    ${prioBadge(l)}
    <div class="q-main">
      <div class="name">${esc(l.name)}</div>
      <div class="sub">${who}</div>
      <div class="q-why">${why}</div>
    </div>
    <div class="q-actions">${quickActions(l)}<button type="button" class="btn sm primary" data-open>Ouvrir</button></div>
  </li>`;
}

function renderToday(queue) {
  const { due, fresh, done } = queue;
  const remaining = state.leads.filter(l => l.crm_status === 'A_CONTACTER').length;
  const planned = due.length + fresh.length + done.length;
  const pct = planned ? Math.round((done.length / planned) * 100) : 0;
  const dueWhy = l =>
    `<span class="${l.next_action_at < today() ? 'overdue' : ''}">Relance ${l.next_action_at < today() ? 'en retard depuis le' : 'prévue le'} ${esc(frDate(l.next_action_at))}</span>` +
    ` · ${statusBadge(l.crm_status)}${l.crm_channel ? ` <span class="sub">via ${esc(state.channels[l.crm_channel] ?? l.crm_channel)}</span>` : ''}`;
  const freshWhy = l => `Jamais contacté · ${esc(l.reviews_count)} avis, ${esc(l.rating)}★${l.claimed ? '' : ' · <span class="tag warn">fiche non revendiquée</span>'} ${channelTags(l)}`;

  state.navIds = [...due, ...fresh].map(l => l.place_id);
  $('#view-today').innerHTML = `
    <div class="today-head">
      <div>
        <h1>Aujourd'hui</h1>
        <div class="muted">${esc(frLongDate())} · ${due.length} relance${due.length > 1 ? 's' : ''} + ${fresh.length} nouveau${fresh.length > 1 ? 'x' : ''} lead${fresh.length > 1 ? 's' : ''}</div>
        <p class="sub today-explain">La file du jour propose d’abord les relances dues, puis ${DAILY_NEW} nouveaux leads par jour, par ordre de score (priorité A d’abord).
        ${remaining} lead${remaining > 1 ? 's' : ''} sur ${state.leads.length} ${remaining > 1 ? 'restent' : 'reste'} à contacter au total · <button type="button" class="linklike" data-goto-all>voir tous les leads</button></p>
      </div>
      <div class="progress" aria-label="Avancement du jour">
        <div class="sub">${done.length} contacté${done.length > 1 ? 's' : ''} sur ${planned}</div>
        <div class="progress-bar"><span style="width:${pct}%"></span></div>
      </div>
    </div>
    ${inCallWindow() ? '' : '<div class="banner"><strong>Hors créneau.</strong> On contacte du lundi au vendredi, de 9 h à 18 h. Prépare la file, les appels attendront.</div>'}
    ${due.length || fresh.length ? '' : '<div class="empty-state"><strong>File vide pour aujourd\'hui.</strong>Toutes les relances sont faites et aucun nouveau lead n\'attend. Importe un export pour en ajouter.</div>'}
    ${due.length ? `<section class="queue-section"><h2>Relances dues <span class="pill">${due.length}</span></h2><ul class="queue">${due.map(l => queueItem(l, dueWhy(l))).join('')}</ul></section>` : ''}
    ${fresh.length ? `<section class="queue-section"><h2>Nouveaux à contacter <span class="pill">${fresh.length}</span></h2><ul class="queue">${fresh.map(l => queueItem(l, freshWhy(l))).join('')}</ul></section>` : ''}
    ${done.length ? `<section class="queue-section done-list"><details><summary>Déjà contactés aujourd'hui (${done.length})</summary><ul class="queue">${done.map(l => queueItem(l, `${statusBadge(l.crm_status)} · relance ${esc(frDate(l.next_action_at)) || 'aucune'}`)).join('')}</ul></details></section>` : ''}
  `;
}

$('#view-today').addEventListener('click', e => {
  if (e.target.closest('[data-goto-all]')) return setView('all');
  if (e.target.closest('a')) return; // les liens Appeler / WhatsApp / DM agissent seuls
  const item = e.target.closest('.q-item');
  if (item) openLead(item.dataset.id);
});

// --- Vue Tous les leads ----------------------------------------------------------------

function matches(l, f, { ignoreStatus = false } = {}) {
  if (f.priority && l.priority !== f.priority) return false;
  if (f.sector && l.search_sector !== f.sector) return false;
  if (f.phone === 'aucun' ? l.phone : f.phone && l.phone_kind !== f.phone) return false;
  if (f.reach && !(f.reach === 'instagram' ? l.instagram : f.reach === 'email' ? l.email : l.linkedin_url)) return false;
  if (f.unclaimed && l.claimed) return false;
  if (f.due && !isDue(l)) return false;
  if (!ignoreStatus && f.status && l.crm_status !== f.status) return false;
  if (f.q) {
    const hay = `${l.name} ${l.google_category} ${l.city} ${l.postal_code} ${l.address} ${l.phone} ${phoneDisplay(l.phone)} ${contactName(l)} ${l.email ?? ''} ${l.instagram ?? ''}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

function sortValue(l, key) {
  if (key === 'crm_status') return STATUS_ORDER.indexOf(l.crm_status);
  if (key === 'name' || key === 'city') return String(l[key] ?? '').toLocaleLowerCase('fr');
  return l[key] ?? null;
}

function sorted(rows) {
  const { key, dir } = state.sort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === vb) return byScore(a, b);
    if (va === null) return 1; // les valeurs vides toujours en bas
    if (vb === null) return -1;
    return (va < vb ? -1 : 1) * sign;
  });
}

function renderAll() {
  renderKpis();
  renderTabs();
  const rows = sorted(state.leads.filter(l => matches(l, state.filters)));
  state.navIds = rows.map(l => l.place_id);
  $('#count').textContent = `${rows.length} lead${rows.length > 1 ? 's' : ''} affiché${rows.length > 1 ? 's' : ''} sur ${state.leads.length}`;
  renderActiveFilters(rows.length);
  $('#empty').hidden = rows.length > 0;
  $('#empty').textContent = state.leads.length ? 'Aucun lead ne correspond à ces filtres.' : 'Aucun lead pour l’instant : importe un export Apify depuis le menu ⋯.';
  $('#rows').innerHTML = rows.map(rowHtml).join('');
  for (const btn of document.querySelectorAll('[data-sort]')) {
    if (btn.dataset.sort === state.sort.key) btn.dataset.dir = state.sort.dir;
    else delete btn.dataset.dir;
  }
}

function rowHtml(l) {
  const due = isDue(l);
  const who = [contactName(l), l.google_category].filter(Boolean).map(esc).join(' · ');
  return `<tr data-id="${esc(l.place_id)}" class="${l.place_id === state.selectedId ? 'selected' : ''}">
    <td>${prioBadge(l)}</td>
    <td><div class="name">${esc(l.name)}</div><div class="sub">${who}${l.claimed ? '' : ' · <span class="tag warn">fiche non revendiquée</span>'}</div>${channelTags(l) ? `<div class="chs">${channelTags(l)}</div>` : ''}</td>
    <td class="col-city">${esc(l.city)}<div class="sub">${esc(l.postal_code)}</div></td>
    <td class="col-reviews num">${esc(l.reviews_count)} <span class="sub">· ${esc(l.rating)}★</span></td>
    <td class="num">${l.phone ? `${esc(phoneDisplay(l.phone))} <span class="tag">${esc(phoneTag(l.phone_kind))}</span>` : '<span class="sub">—</span>'}</td>
    <td>${statusBadge(l.crm_status)}</td>
    <td class="num ${due ? 'overdue' : ''}">${esc(frDate(l.next_action_at))}</td>
    <td class="col-last sub">${esc(relative(l.last_activity_at))}</td>
  </tr>`;
}

// Indicateurs sur l'ensemble des leads, quels que soient les filtres de la liste.
function renderKpis() {
  const all = state.leads;
  const touched = all.filter(l => l.crm_status !== 'A_CONTACTER');
  const replied = all.filter(l => ['REP_POSITIVE', 'REP_NEGATIVE', 'NE_PAS_CONTACTER'].includes(l.crm_status));
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
  const kpi = (value, label, hint) => `<div class="kpi" title="${esc(hint)}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  $('#kpis').innerHTML = [
    kpi(all.length, 'leads au total', 'Tous les leads ciblés, hors fiches écartées à l’import'),
    kpi(all.filter(l => l.crm_status === 'A_CONTACTER').length, 'à contacter', 'Jamais contactés'),
    kpi(touched.length, 'déjà contactés', 'Au moins un contact noté'),
    kpi(pct(replied.length, touched.length), 'taux de réponse', 'Réponses reçues (intéressé, pas intéressé, opposition) rapportées aux leads contactés'),
    kpi(all.filter(l => l.crm_status === 'REP_POSITIVE').length, 'intéressés', 'Statut RÉP POSITIVE'),
    kpi(all.filter(l => l.priority === 'A').length, 'en priorité A', 'Score de 7 ou 8 sur 8 : les plus prometteurs'),
  ].join('');
}

const FILTER_LABELS = {
  q: v => `Recherche « ${v} »`,
  priority: v => `Priorité ${v}`,
  sector: v => v,
  phone: v => ({ fixe: 'Téléphone fixe', mobile: 'Téléphone mobile', voip: 'Box (09)', aucun: 'Sans numéro' })[v] ?? v,
  reach: v => ({ instagram: 'Avec Instagram', email: 'Avec e-mail', linkedin: 'Avec LinkedIn' })[v] ?? v,
  status: v => `Statut ${state.statuses[v] ?? v}`,
  unclaimed: () => 'Fiche non revendiquée',
  due: () => 'À relancer',
};

function renderActiveFilters(shown) {
  const active = Object.entries(state.filters).filter(([, v]) => v);
  const bar = $('#active-filters');
  bar.hidden = !active.length;
  bar.innerHTML = active.length
    ? `<span class="sub">Filtres actifs :</span>
       ${active.map(([k, v]) => `<button type="button" class="chip" data-clear="${esc(k)}" title="Retirer ce filtre">${esc(FILTER_LABELS[k](v))} <span aria-hidden="true">✕</span></button>`).join('')}
       <button type="button" class="btn ghost sm" data-clear-all>Tout effacer</button>
       <span class="sub">${shown} lead${shown > 1 ? 's' : ''} affiché${shown > 1 ? 's' : ''} sur ${state.leads.length}</span>`
    : '';
}

$('#active-filters').addEventListener('click', e => {
  const one = e.target.closest('[data-clear]');
  if (one) {
    const key = one.dataset.clear;
    state.filters[key] = DEFAULT_FILTERS[key];
  } else if (e.target.closest('[data-clear-all]')) {
    state.filters = { ...DEFAULT_FILTERS };
  } else return;
  savePrefs();
  syncFilterInputs();
  render();
});

function renderTabs() {
  const base = state.leads.filter(l => matches(l, state.filters, { ignoreStatus: true }));
  const count = s => base.filter(l => !s || l.crm_status === s).length;
  const tab = (value, label) =>
    `<button type="button" class="tab" data-status="${esc(value)}" aria-pressed="${state.filters.status === value}">${esc(label)} <span class="n">${count(value)}</span></button>`;
  $('#status-tabs').innerHTML = tab('', 'Tous') + STATUS_ORDER.map(s => tab(s, state.statuses[s] ?? s)).join('');
}

function syncFilterInputs() {
  const f = state.filters;
  for (const [id, key] of [['f-q', 'q'], ['f-priority', 'priority'], ['f-sector', 'sector'], ['f-phone', 'phone'], ['f-reach', 'reach']]) $(`#${id}`).value = f[key];
  $('#f-unclaimed').checked = f.unclaimed;
  $('#f-due').checked = f.due;
}

function setFilter(key, value) {
  state.filters[key] = value;
  savePrefs();
  render();
}

$('#f-q').addEventListener('input', e => setFilter('q', e.target.value.trim()));
for (const [id, key] of [['f-priority', 'priority'], ['f-sector', 'sector'], ['f-phone', 'phone'], ['f-reach', 'reach']]) {
  $(`#${id}`).addEventListener('change', e => setFilter(key, e.target.value));
}
$('#f-unclaimed').addEventListener('change', e => setFilter('unclaimed', e.target.checked));
$('#f-due').addEventListener('change', e => setFilter('due', e.target.checked));
$('#status-tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-status]');
  if (btn) setFilter('status', btn.dataset.status);
});
document.querySelector('.leads thead').addEventListener('click', e => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  const key = btn.dataset.sort;
  const textual = key === 'name' || key === 'city' || key === 'crm_status' || key === 'next_action_at';
  state.sort = state.sort.key === key ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: textual ? 'asc' : 'desc' };
  savePrefs();
  render();
});
$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openLead(tr.dataset.id);
});

// --- Fiche du lead ------------------------------------------------------------------------

async function openLead(id) {
  state.selectedId = id;
  render();
  $('#panel').hidden = false;
  $('#scrim').hidden = false;
  $('#panel').innerHTML = '<div class="p-body"><p class="muted">Chargement…</p></div>';
  try {
    state.detail = await api(`/api/leads/${encodeURIComponent(id)}`);
  } catch (err) {
    $('#panel').innerHTML = `<div class="p-body"><p class="error">${esc(err.message)}</p></div>`;
    return;
  }
  const d = state.detail;
  state.pickChannel = d.phone ? 'telephone' : d.instagram ? 'instagram' : d.email ? 'email' : 'autre';
  state.scriptTab = scriptTabs(d)[0]?.key ?? 'call';
  renderPanel();
}

// --- Scripts et messages ------------------------------------------------------------------

function scriptTabs(d) {
  return [
    d.phone && { key: 'call', label: 'Appel' },
    d.instagram && { key: 'instagram', label: 'Instagram' },
    d.phone_kind === 'mobile' && { key: 'whatsapp', label: 'WhatsApp' },
    d.email && { key: 'email', label: 'E-mail' },
  ].filter(Boolean);
}

function messageBlock(text, actions) {
  return `<pre class="msg">${esc(text)}</pre><div class="msg-actions">${actions}</div>`;
}

function scriptSection(d) {
  const tabs = scriptTabs(d);
  if (!tabs.length) return '';
  const s = buildScripts(d, state.settings);
  state.scripts = s;
  const title = `Script${s.followUp ? ' · relance' : ''}`;
  if (s.missing.length) {
    return `<section class="p-section"><h3>${title}</h3>
      <p class="notice">Renseigne ton prénom et le nom de la marque pour activer les scripts et les messages.
      <button type="button" class="btn sm" data-settings>Régler</button></p></section>`;
  }
  const tab = tabs.some(t => t.key === state.scriptTab) ? state.scriptTab : tabs[0].key;
  let body = '';
  if (tab === 'call') {
    body = `<ol class="steps">${s.call.steps.map(x => `<li><b>${esc(x.title)}</b><p>${esc(x.text)}</p></li>`).join('')}</ol>
      <details class="more"><summary>Objections fréquentes</summary><dl class="objections">${s.call.objections.map(o => `<dt>${esc(o.q)}</dt><dd>${esc(o.a)}</dd>`).join('')}</dl></details>
      <details class="more"><summary>Message à laisser sur la messagerie</summary><p class="voicemail">${esc(s.call.voicemail)}</p></details>`;
  } else if (tab === 'instagram') {
    body = messageBlock(s.instagram, `<button type="button" class="btn sm primary" data-copy="instagram" data-open-url="https://ig.me/m/${esc(d.instagram)}" data-channel-used="instagram">Copier et ouvrir le DM</button><button type="button" class="btn sm" data-copy="instagram">Copier</button>`);
  } else if (tab === 'whatsapp') {
    const wa = `https://wa.me/${String(d.phone).replace(/\D/g, '')}?text=${encodeURIComponent(s.whatsapp)}`;
    body = messageBlock(s.whatsapp, `<a class="btn sm primary" href="${esc(wa)}" target="_blank" rel="noopener noreferrer" data-channel-used="whatsapp">Ouvrir WhatsApp avec ce message</a><button type="button" class="btn sm" data-copy="whatsapp">Copier</button>`);
  } else if (tab === 'email') {
    const mailto = `mailto:${d.email}?subject=${encodeURIComponent(s.email.subject)}&body=${encodeURIComponent(s.email.body)}`;
    body = `<div class="subject"><span class="sub">Objet</span> ${esc(s.email.subject)}</div>` +
      messageBlock(s.email.body, `<a class="btn sm primary" href="${esc(mailto)}" data-channel-used="email">Ouvrir dans la messagerie</a><button type="button" class="btn sm" data-copy="email">Copier</button>`);
  }
  return `<section class="p-section">
    <h3>${title}</h3>
    <div class="seg script-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" data-script-tab="${t.key}" aria-selected="${t.key === tab}">${t.label}</button>`).join('')}</div>
    ${body}
    <p class="kbd">Après l’envoi, note le résultat ci-dessous (« Contacté, en attente »).</p>
  </section>`;
}

function useChannel(channel) {
  if (!state.channels[channel]) return;
  state.pickChannel = channel;
  for (const b of document.querySelectorAll('[data-channel]')) b.setAttribute('aria-checked', b.dataset.channel === channel);
}

async function copyScript(key) {
  const s = state.scripts;
  const text = key === 'email' ? `Objet : ${s.email.subject}\n\n${s.email.body}` : s[key];
  try {
    await navigator.clipboard.writeText(text);
    toast('Message copié');
    return true;
  } catch {
    toast('Copie impossible : sélectionne le texte à la main.', { error: true });
    return false;
  }
}

function closePanel() {
  state.selectedId = null;
  state.detail = null;
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  render();
}

function step(delta) {
  const ids = state.navIds;
  const i = ids.indexOf(state.selectedId);
  const next = ids[i + delta] ?? (i === -1 ? ids[0] : null);
  if (next) openLead(next);
}

function reachButtons(d) {
  const out = [];
  if (d.phone) out.push(`<a class="btn primary" href="tel:${esc(d.phone)}">Appeler ${esc(phoneDisplay(d.phone))}</a>`);
  if (d.phone_kind === 'mobile') out.push(`<a class="btn" href="${esc(whatsappLink(d.phone))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
  if (d.instagram) out.push(`<a class="btn" href="https://ig.me/m/${esc(d.instagram)}" target="_blank" rel="noopener noreferrer">DM Instagram</a>`);
  if (d.email) out.push(`<a class="btn" href="mailto:${esc(d.email)}">E-mail</a>`);
  if (d.linkedin_url) out.push(`<a class="btn" href="${esc(d.linkedin_url)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`);
  if (d.maps_url) out.push(`<a class="btn ghost" href="${esc(d.maps_url)}" target="_blank" rel="noopener noreferrer">Fiche Google</a>`);
  return out.join('');
}

function renderPanel() {
  const d = state.detail;
  const locked = d.crm_status === 'NE_PAS_CONTACTER';
  const doneToday = contactedToday(state.leads.find(l => l.place_id === d.place_id) ?? d);
  const pos = state.navIds.indexOf(d.place_id);
  const navLabel = pos >= 0 ? `${pos + 1} / ${state.navIds.length}` : '';
  const who = contactName(d);

  $('#panel').innerHTML = `
    <header class="p-head">
      <div>
        <div class="p-kicker">${prioBadge(d)} Priorité ${esc(d.priority)} · score ${esc(d.score)}/8 · ${esc(d.google_category)}</div>
        <h2>${esc(d.name)}</h2>
        <div class="sub">${who ? `${esc(who)}${d.contact_role ? `, ${esc(d.contact_role)}` : ''} · ` : ''}${esc(d.city)}</div>
      </div>
      <div class="p-nav">
        <button type="button" class="btn ghost icon" data-nav="-1" title="Précédent (↑)" ${pos > 0 ? '' : 'disabled'}>‹</button>
        <span class="pos">${esc(navLabel)}</span>
        <button type="button" class="btn ghost icon" data-nav="1" title="Suivant (↓)" ${pos >= 0 && pos < state.navIds.length - 1 ? '' : 'disabled'}>›</button>
        <button type="button" class="btn ghost icon" data-action="close" title="Fermer (Échap)">✕</button>
      </div>
    </header>
    <div class="p-body">
      <div class="p-status">
        ${statusBadge(d.crm_status)}
        ${d.next_action_at ? `<span class="sub ${isDue(d) ? 'overdue' : ''}">Relance le ${esc(frDate(d.next_action_at))}</span>` : ''}
        ${d.claimed ? '' : '<span class="tag warn">fiche non revendiquée</span>'}
      </div>
      ${scoreDetail(d)}
      ${locked ? '<p class="notice stop">Opposition enregistrée : ne plus contacter ce lead, sur aucun canal.</p>' : ''}
      ${!locked && doneToday ? '<p class="notice">Déjà contacté aujourd’hui : prochain contact demain au plus tôt. Une réponse reçue peut toujours être notée.</p>' : ''}
      ${!locked && d.phone_kind === 'mobile' ? '<p class="notice">Numéro mobile : vérifie en début d’appel qu’il s’agit bien de la ligne du salon.</p>' : ''}

      ${locked ? '' : `<section class="p-section"><h3>Joindre</h3><div class="reach">${reachButtons(d) || '<span class="muted">Aucun canal connu.</span>'}</div></section>`}

      ${locked ? '' : scriptSection(d)}

      <section class="p-section">
        <h3>Noter le résultat</h3>
        ${locked ? '' : `<div class="seg" role="radiogroup" aria-label="Canal utilisé">
          ${Object.entries(state.channels).map(([k, v]) => `<button type="button" role="radio" data-channel="${esc(k)}" aria-checked="${state.pickChannel === k}">${esc(v)}</button>`).join('')}
        </div>`}
        <textarea id="note" rows="2" maxlength="2000" placeholder="Note (facultative) : ce qui s’est dit, l’objection, le meilleur moment pour rappeler…"></textarea>
        ${locked ? '<div class="more-grid"><button type="button" class="btn" data-note-only>Ajouter la note</button></div>' : `<div class="outcomes">
          ${OUTCOMES.map(o => `<button type="button" class="outcome ${o.tone ?? ''}" data-outcome="${o.key}" ${o.outbound && doneToday ? 'disabled' : ''}><b>${esc(o.label)}</b><span>${esc(o.hint)}</span></button>`).join('')}
          <button type="button" class="outcome" data-note-only><b>Note seule</b><span>Sans changer le statut</span></button>
        </div>
        <details class="more"><summary>Autre mise à jour (statut ou date au choix)</summary>
          <div class="more-grid">
            <label class="field">Statut<select id="more-status">${STATUS_ORDER.map(s => `<option value="${s}" ${s === d.crm_status ? 'selected' : ''}>${esc(state.statuses[s])}</option>`).join('')}</select></label>
            <label class="field">Relance le<input type="date" id="more-date" value="${esc(d.next_action_at ?? '')}"></label>
            <button type="button" class="btn" data-more-save>Enregistrer</button>
          </div>
        </details>`}
      </section>

      <section class="p-section">
        <h3>Fiche</h3>
        <dl class="facts">
          ${who ? `<dt>Gérant(e)</dt><dd>${esc(who)}${d.contact_role ? ` <span class="sub">· ${esc(d.contact_role)}</span>` : ''}</dd>` : ''}
          <dt>Téléphone</dt><dd>${d.phone ? `${esc(phoneDisplay(d.phone))} <span class="tag">${esc(phoneTag(d.phone_kind))}</span>` : '—'}</dd>
          ${d.instagram ? `<dt>Instagram</dt><dd><a href="https://www.instagram.com/${esc(d.instagram)}/" target="_blank" rel="noopener noreferrer">@${esc(d.instagram)}</a></dd>` : ''}
          ${d.email ? `<dt>E-mail</dt><dd>${esc(d.email)} <span class="sub">· ${esc(EMAIL_SOURCES[d.email_source] ?? d.email_source ?? '')}</span></dd>` : ''}
          <dt>Adresse</dt><dd>${esc(d.address)}, ${esc(d.postal_code)} ${esc(d.city)}</dd>
          <dt>Google</dt><dd>${esc(d.reviews_count)} avis · ${esc(d.rating)}★ · ${esc(d.photos_count)} photos</dd>
          ${d.opening_hours ? `<dt>Horaires</dt><dd class="sub">${esc(d.opening_hours)}</dd>` : ''}
        </dl>
      </section>

      <section class="p-section">
        <h3>Historique</h3>
        ${d.activities.length ? `<ol class="timeline">${d.activities.map(activityHtml).join('')}</ol>` : '<p class="muted">Aucune action pour l’instant.</p>'}
      </section>
      <p class="kbd">Raccourcis : ↑ ↓ lead précédent / suivant · Échap fermer</p>
    </div>
  `;
}

// Détail du score (calculé côté serveur avec la règle de src/score.ts).
function scoreDetail(d) {
  const p = d.score_points;
  if (!p) return '';
  const rating = String(d.rating ?? '—').replace('.', ',');
  const row = (label, pts) => `<li><span>${label}</span><b>+${pts}</b></li>`;
  return `<details class="more score-why"><summary>Pourquoi priorité ${esc(d.priority)} ?</summary>
    <ul class="score-list">
      ${row(`${esc(d.reviews_count)} avis <span class="sub">(30 et plus : 3, de 10 à 29 : 2, sinon 1)</span>`, p.reviews)}
      ${row(`Note ${esc(rating)}/5 <span class="sub">(4,5 ou plus : 1)</span>`, p.rating)}
      ${row(d.claimed ? 'Fiche Google revendiquée <span class="sub">(non revendiquée : 2)</span>' : 'Fiche Google non revendiquée', p.unclaimed)}
      ${row(d.phone ? 'Téléphone sur la fiche' : 'Pas de téléphone sur la fiche', p.phone)}
      ${row(`${esc(d.photos_count)} photos <span class="sub">(10 ou plus : 1)</span>`, p.photos)}
      <li class="total"><span>Score</span><b>${esc(d.score)}/8</b></li>
    </ul>
    <p class="sub">Priorité A : 7 ou 8 · B : 5 ou 6 · C : 4 ou moins.</p>
  </details>`;
}

function activityHtml(a) {
  let what = '';
  if (a.kind === 'statut') {
    const channel = a.channel ? ` · ${esc(state.channels[a.channel] ?? a.channel)}` : '';
    what = a.from_status === a.to_status ? `${statusBadge(a.to_status)} nouvelle tentative${channel}` : `${statusBadge(a.from_status)} → ${statusBadge(a.to_status)}${channel}`;
  } else if (a.kind === 'relance') {
    what = a.body ? `Relance prévue le ${esc(frDate(a.body))}` : 'Relance retirée';
  } else {
    what = 'Note';
  }
  const body = a.kind !== 'relance' && a.body ? `<div class="body">${esc(a.body)}</div>` : '';
  return `<li><span class="when">${esc(frDateTime(a.at))}</span><div>${what}</div>${body}</li>`;
}

async function save(payload, done) {
  const d = state.detail;
  try {
    state.detail = await api(`/api/leads/${encodeURIComponent(d.place_id)}`, { method: 'POST', json: payload });
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  const i = state.leads.findIndex(l => l.place_id === d.place_id);
  if (i >= 0) {
    const { activities, ...fields } = state.detail;
    const lastAttempt = activities.find(a => a.kind === 'statut' && a.channel && (a.to_status === 'CONTACTE' || a.to_status === 'PAS_DE_REP'));
    state.leads[i] = {
      ...state.leads[i],
      ...fields,
      last_activity_at: activities[0]?.at ?? state.leads[i].last_activity_at,
      last_attempt_at: lastAttempt?.at ?? state.leads[i].last_attempt_at,
      first_attempt_at: state.leads[i].first_attempt_at ?? lastAttempt?.at ?? null,
    };
  }
  toast(done);
  // Dans la file du jour, on enchaîne : le lead traité sort de la file, on ouvre le suivant.
  if (state.view === 'today') {
    const before = state.navIds;
    const pos = before.indexOf(d.place_id);
    render();
    const next = state.navIds.find(id => !before.slice(0, pos).includes(id) && id !== d.place_id) ?? null;
    if (next) openLead(next);
    else closePanel();
  } else {
    render();
    renderPanel();
  }
}

$('#panel').addEventListener('click', async e => {
  // Liens d'envoi (WhatsApp, messagerie) : on laisse le lien s'ouvrir et on présélectionne le canal.
  const link = e.target.closest('a[data-channel-used]');
  if (link) return useChannel(link.dataset.channelUsed);
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.settings !== undefined) return openSettings();
  if (t.dataset.scriptTab) {
    state.scriptTab = t.dataset.scriptTab;
    return renderPanel();
  }
  if (t.dataset.copy) {
    const copied = await copyScript(t.dataset.copy);
    if (copied && t.dataset.openUrl) window.open(t.dataset.openUrl, '_blank', 'noopener');
    if (t.dataset.channelUsed) useChannel(t.dataset.channelUsed);
    return;
  }
  const d = state.detail;
  const note = $('#note')?.value.trim() ?? '';
  if (t.dataset.action === 'close') return closePanel();
  if (t.dataset.nav) return step(Number(t.dataset.nav));
  if (t.dataset.channel) {
    state.pickChannel = t.dataset.channel;
    for (const b of document.querySelectorAll('[data-channel]')) b.setAttribute('aria-checked', b.dataset.channel === state.pickChannel);
    return;
  }
  if (t.dataset.outcome) {
    const o = OUTCOMES.find(x => x.key === t.dataset.outcome);
    if (o.status === 'NE_PAS_CONTACTER' && !confirm('Opposition définitive : ce lead ne pourra plus être recontacté, sur aucun canal. Confirmer ?')) return;
    const next = o.days ? addBusinessDays(o.days) : null;
    const payload = { status: o.status, channel: state.pickChannel, nextActionAt: next };
    if (note) payload.note = note;
    return save(payload, `${o.label}${next ? ` · relance le ${frDate(next)}` : ''}`);
  }
  if (t.dataset.noteOnly !== undefined) {
    if (!note) return toast('Écris une note avant de l’enregistrer.', { error: true });
    return save({ note }, 'Note ajoutée');
  }
  if (t.dataset.moreSave !== undefined) {
    const status = $('#more-status').value;
    const date = $('#more-date').value || null;
    const payload = {};
    if (status !== d.crm_status || note) payload.status = status;
    if (note) payload.note = note;
    if (date !== (d.next_action_at ?? null)) payload.nextActionAt = date;
    if (!Object.keys(payload).length) return toast('Rien à enregistrer.', { error: true });
    return save(payload, 'Fiche mise à jour');
  }
});

$('#scrim').addEventListener('click', closePanel);

document.addEventListener('keydown', e => {
  if ($('#panel').hidden || $('#import-dialog').open || $('#settings-dialog').open) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape') return typing ? document.activeElement.blur() : closePanel();
  if (typing) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
});

// --- Menu, import, déconnexion -------------------------------------------------------------

function toggleMenu(open = $('#menu').hidden) {
  $('#menu').hidden = !open;
  $('#menu-open').setAttribute('aria-expanded', String(open));
}
$('#menu-open').addEventListener('click', e => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu-wrap')) toggleMenu(false);
});
function openSettings() {
  const form = $('#settings-form');
  form.sender.value = state.settings.sender ?? '';
  form.brand.value = state.settings.brand ?? '';
  $('#settings-dialog').showModal();
}
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-form').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  state.settings = { sender: form.sender.value.trim(), brand: form.brand.value.trim() };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* stockage indisponible : réglages gardés pour cette session */ }
  $('#settings-dialog').close();
  toast('Réglages enregistrés');
  if (state.detail) renderPanel();
});

$('#menu').addEventListener('click', async e => {
  const action = e.target.closest('[data-menu]')?.dataset.menu;
  toggleMenu(false);
  if (action === 'settings') openSettings();
  if (action === 'import') {
    $('#import-result').innerHTML = '';
    $('#import-form').reset();
    $('#import-dialog').showModal();
  }
  if (action === 'logout') {
    await api('/api/logout', { method: 'POST', json: {} }).catch(() => {});
    closePanel();
    showLogin();
  }
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
    const excluded = r.outOfTarget.length ? `<ul>${r.outOfTarget.map(o => `<li>${esc(o.name)} — ${esc(o.reason)}</li>`).join('')}</ul>` : '';
    out.innerHTML = `<b>${esc(r.file)}</b> : ${r.rowsRead} lignes, ${r.inserted} nouveaux, ${r.updated} mis à jour, ${r.unchanged} inchangés.
      ${score.scored} leads scorés.${r.outOfTarget.length ? ` ${r.outOfTarget.length} hors cible, écartés :` : ''}${excluded}`;
    await loadLeads();
    toast('Import terminé');
  } catch (err) {
    out.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// --- Démarrage --------------------------------------------------------------------------------

api('/api/me').then(onLogged).catch(err => showLogin(err.message === 'Connexion requise' ? '' : err.message));
