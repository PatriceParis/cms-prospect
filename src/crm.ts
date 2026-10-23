import type { Client, InStatement, Row } from '@libsql/client';

export type LeadFields = Record<string, unknown>;
const plain = (r: Row): LeadFields => ({ ...r });

export const CRM_STATUSES = {
  A_CONTACTER: 'À CONTACTER',
  CONTACTE: 'CONTACTÉ',
  PAS_DE_REP: 'PAS DE RÉP',
  REP_POSITIVE: 'RÉP POSITIVE',
  REP_NEGATIVE: 'RÉP NÉGATIVE',
  NE_PAS_CONTACTER: 'NE PAS CONTACTER',
} as const;
export type CrmStatus = keyof typeof CRM_STATUSES;

export const CHANNELS = {
  telephone: 'Téléphone',
  email: 'E-mail',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  visite: 'Visite',
  autre: 'Autre',
} as const;
export type Channel = keyof typeof CHANNELS;

// Opposition RGPD : un lead passé en NE_PAS_CONTACTER y reste définitivement,
// sans relance possible. Les futurs modules d'envoi liront ce statut.
const OPPOSITION: CrmStatus = 'NE_PAS_CONTACTER';
const NOTE_MAX = 2000;

export class CrmError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const isStatus = (v: unknown): v is CrmStatus => typeof v === 'string' && Object.hasOwn(CRM_STATUSES, v);
const isChannel = (v: unknown): v is Channel => typeof v === 'string' && Object.hasOwn(CHANNELS, v);

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const LIST_COLUMNS = `
  l.place_id, l.name, l.search_sector, l.google_category, l.rating, l.reviews_count, l.phone, l.phone_kind,
  l.address, l.postal_code, l.city, l.photos_count, l.claimed, l.maps_url, l.score, l.priority,
  l.crm_status, l.crm_channel, l.next_action_at, l.crm_updated_at,
  l.contact_first_name, l.contact_last_name, l.contact_role, l.email, l.email_source, l.instagram, l.linkedin_url`;

// Tentative de contact sortante : un statut CONTACTÉ ou PAS DE RÉP enregistré avec un canal.
const OUTBOUND = `a.kind = 'statut' AND a.to_status IN ('CONTACTE', 'PAS_DE_REP') AND a.channel IS NOT NULL`;

export async function listLeads(db: Client) {
  const { rows } = await db.execute(`
    SELECT ${LIST_COLUMNS},
      (SELECT max(at) FROM activities a WHERE a.place_id = l.place_id) AS last_activity_at,
      (SELECT max(at) FROM activities a WHERE a.place_id = l.place_id AND ${OUTBOUND}) AS last_attempt_at,
      (SELECT min(at) FROM activities a WHERE a.place_id = l.place_id AND ${OUTBOUND}) AS first_attempt_at
    FROM leads l WHERE l.status <> 'hors_cible'
    ORDER BY l.score DESC, l.reviews_count DESC`);
  return rows.map(plain);
}

// Jour calendaire à Paris, pour le garde-fou « un contact par jour » (le serveur tourne en UTC).
const PARIS_DAY = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' });
export const parisDay = (d: Date) => PARIS_DAY.format(d);

export async function getLead(db: Client, placeId: string): Promise<LeadFields & { activities: LeadFields[] }> {
  const lead = await db.execute({
    sql: `SELECT ${LIST_COLUMNS}, l.opening_hours, l.neighborhood, l.first_seen_at FROM leads l WHERE l.place_id = ? AND l.status <> 'hors_cible'`,
    args: [placeId],
  });
  if (!lead.rows.length) throw new CrmError('Lead introuvable', 404);
  const activities = await db.execute({
    sql: 'SELECT id, at, author, kind, from_status, to_status, channel, body FROM activities WHERE place_id = ? ORDER BY at DESC, id DESC',
    args: [placeId],
  });
  return { ...plain(lead.rows[0]), activities: activities.rows.map(plain) };
}

export type LeadChange = {
  status?: unknown;
  channel?: unknown;
  note?: unknown;
  nextActionAt?: unknown; // AAAA-MM-JJ, ou null pour retirer la relance
};

export async function updateLead(db: Client, placeId: string, change: LeadChange) {
  const { rows } = await db.execute({
    sql: `SELECT crm_status, crm_channel, next_action_at FROM leads WHERE place_id = ? AND status <> 'hors_cible'`,
    args: [placeId],
  });
  if (!rows.length) throw new CrmError('Lead introuvable', 404);
  const current = { status: String(rows[0].crm_status) as CrmStatus, nextActionAt: rows[0].next_action_at as string | null };

  if (change.status !== undefined && !isStatus(change.status)) throw new CrmError(`Statut inconnu : ${String(change.status)}`);
  if (change.channel !== undefined && change.channel !== null && !isChannel(change.channel)) throw new CrmError(`Canal inconnu : ${String(change.channel)}`);
  if (change.note !== undefined && typeof change.note !== 'string') throw new CrmError('La note doit être un texte');
  if (change.nextActionAt !== undefined && change.nextActionAt !== null && (typeof change.nextActionAt !== 'string' || !isIsoDate(change.nextActionAt)))
    throw new CrmError('Date de relance invalide (AAAA-MM-JJ attendu)');

  const status = change.status as CrmStatus | undefined;
  const channel = (change.channel ?? null) as Channel | null;
  const note = typeof change.note === 'string' ? change.note.trim() : '';
  if (note.length > NOTE_MAX) throw new CrmError(`Note trop longue (${NOTE_MAX} caractères au plus)`);
  let nextActionAt = change.nextActionAt as string | null | undefined;

  if (current.status === OPPOSITION) {
    if (status !== undefined && status !== OPPOSITION) throw new CrmError('Opposition enregistrée : ce lead ne peut plus être recontacté.', 409);
    if (nextActionAt) throw new CrmError('Opposition enregistrée : aucune relance possible.', 409);
  }
  if (status === OPPOSITION) nextActionAt = null;

  // Un statut identique accompagné d'un canal ou d'une note compte comme une nouvelle tentative.
  const logStatus = status !== undefined && (status !== current.status || channel !== null || note !== '');
  const nextChanged = nextActionAt !== undefined && nextActionAt !== current.nextActionAt;
  if (!logStatus && !note && !nextChanged) throw new CrmError('Rien à enregistrer');

  // Garde-fou du cahier des charges : un seul contact sortant par lead et par jour, tous
  // canaux confondus. Une réponse reçue, une note ou une correction sans canal passent.
  if (logStatus && channel && (status === 'CONTACTE' || status === 'PAS_DE_REP')) {
    const last = await db.execute({
      sql: `SELECT max(at) AS at FROM activities a WHERE a.place_id = ? AND ${OUTBOUND}`,
      args: [placeId],
    });
    const lastAt = last.rows[0]?.at as string | null;
    if (lastAt && parisDay(new Date(lastAt)) === parisDay(new Date())) {
      throw new CrmError('Déjà contacté aujourd’hui : un seul contact par lead et par jour, tous canaux confondus.', 409);
    }
  }

  const now = new Date().toISOString();
  const writes: InStatement[] = [];
  const sets = ['crm_updated_at = :now'];
  if (status !== undefined) sets.push('crm_status = :status');
  if (status !== undefined && channel) sets.push('crm_channel = :channel');
  if (nextActionAt !== undefined) sets.push('next_action_at = :next');
  writes.push({ sql: `UPDATE leads SET ${sets.join(', ')} WHERE place_id = :id`, args: { now, status: status ?? null, channel, next: nextActionAt ?? null, id: placeId } });

  // L'accès par mot de passe seul n'identifie pas la personne : la colonne author reste vide.
  const author = '';
  const activity = 'INSERT INTO activities (place_id, at, author, kind, from_status, to_status, channel, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  if (logStatus) writes.push({ sql: activity, args: [placeId, now, author, 'statut', current.status, status, channel, note || null] });
  else if (note) writes.push({ sql: activity, args: [placeId, now, author, 'note', null, null, null, note] });
  if (nextChanged) writes.push({ sql: activity, args: [placeId, now, author, 'relance', null, null, null, nextActionAt ?? null] });

  await db.batch(writes, 'write');
  return getLead(db, placeId);
}

const CSV_COLUMNS: [label: string, key: string][] = [
  ['Établissement', 'name'],
  ['Secteur', 'search_sector'],
  ['Catégorie Google', 'google_category'],
  ['Priorité', 'priority'],
  ['Score /8', 'score'],
  ['Statut CRM', 'crm_status_label'],
  ['Gérant(e)', 'contact_label'],
  ['E-mail', 'email'],
  ['Instagram', 'instagram_url'],
  ['LinkedIn', 'linkedin_url'],
  ['Dernier canal', 'crm_channel'],
  ['Relance le', 'next_action_at'],
  ['Téléphone', 'phone'],
  ['Type de numéro', 'phone_kind'],
  ['Adresse', 'address'],
  ['CP', 'postal_code'],
  ['Ville', 'city'],
  ['Nb avis', 'reviews_count'],
  ['Note', 'rating'],
  ['Fiche revendiquée', 'claimed_label'],
  ['Lien Google Maps', 'maps_url'],
];

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise les formules à l'ouverture dans Excel
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(db: Client): Promise<string> {
  const leads = await listLeads(db);
  const lines = [CSV_COLUMNS.map(([label]) => label).join(';')];
  for (const l of leads) {
    const row: Record<string, unknown> = {
      ...l,
      crm_status_label: CRM_STATUSES[l.crm_status as CrmStatus] ?? l.crm_status,
      claimed_label: l.claimed ? 'Oui' : 'Non',
      contact_label: [l.contact_first_name, l.contact_last_name].filter(Boolean).join(' '),
      instagram_url: l.instagram ? `https://www.instagram.com/${l.instagram}/` : '',
    };
    lines.push(CSV_COLUMNS.map(([, key]) => csvCell(row[key])).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
