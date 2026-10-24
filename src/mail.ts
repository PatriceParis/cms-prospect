import { randomBytes } from 'node:crypto';
import type { Client, InStatement } from '@libsql/client';
import { salonName } from '../public/scripts.js';
import { CrmError, getLead, parisDay } from './crm.ts';

// E-mail de prospection envoyé depuis la fiche, via Resend. Texte brut, un destinataire.
// Garde-fous du cahier des charges, vérifiés côté serveur avant tout envoi :
//  - du lundi au vendredi, de 9 h à 18 h (heure de Paris) ;
//  - un seul contact sortant par lead et par jour, tous canaux confondus ;
//  - jamais une opposition ni un « pas intéressé », jamais une adresse qui rebondira ou
//    désinscrite (liste de suppression) ;
//  - un lien de désinscription dans chaque message (pied non modifiable + en-têtes
//    List-Unsubscribe en un clic).
// Configuration : RESEND_API (clé), MAIL_FROM (adresse du domaine vérifié chez Resend),
// MAIL_REPLY_TO (boîte où arrivent les réponses), APP_URL (adresse publique du CRM).

const RESEND_URL = 'https://api.resend.com/emails';
const SUBJECT_MAX = 150;
const BODY_MAX = 5000;
const NAME_MAX = 60;
const UNDELIVERABLE = new Set(['sans_mx', 'inexistant']);
const BLOCKED = new Set(['NE_PAS_CONTACTER', 'REP_NEGATIVE']);
const OUTBOUND = `kind = 'statut' AND to_status IN ('CONTACTE', 'PAS_DE_REP') AND channel IS NOT NULL`;
const FOLLOW_UP_DAYS = 3;

export function mailConfig() {
  return {
    key: process.env.RESEND_API ?? process.env.RESEND_API_KEY ?? '',
    from: (process.env.MAIL_FROM ?? '').trim(),
    replyTo: (process.env.MAIL_REPLY_TO ?? '').trim(),
    appUrl: (process.env.APP_URL ?? 'https://cms-prospect.vercel.app').replace(/\/+$/, ''),
  };
}

const PARIS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hour12: false });

export function inContactWindow(now = new Date()): boolean {
  const parts = Object.fromEntries(PARIS.formatToParts(now).map(p => [p.type, p.value]));
  const hour = Number(parts.hour);
  return !['Sat', 'Sun'].includes(String(parts.weekday)) && hour >= 9 && hour < 18;
}

function addBusinessDays(n: number, from: Date): string {
  const d = new Date(from);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n--;
  }
  return parisDay(d);
}

export function unsubscribeUrl(token: string): string {
  return `${mailConfig().appUrl}/api/desinscription?t=${token}`;
}

// Pied ajouté à chaque envoi, hors de portée de l'édition.
export function footer(leadName: string, token: string): string {
  const salon = salonName(leadName);
  const because = /^[aeiouyhàâäéèêëîïôöûü]/i.test(salon) ? 'parce qu’' : 'parce que ';
  return `—\nVous recevez ce message ${because}${salon} est référencé sur Google Maps. Pour ne plus recevoir de message de notre part : ${unsubscribeUrl(token)}`;
}

export type OutgoingEmail = { from: string; to: string; replyTo?: string; subject: string; text: string; headers: Record<string, string>; idempotencyKey: string };
export type Sender = (mail: OutgoingEmail) => Promise<{ id: string }>;

export const resendSender: Sender = async mail => {
  const { key } = mailConfig();
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': mail.idempotencyKey },
    body: JSON.stringify({
      from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, headers: mail.headers,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok || !body.id) throw new CrmError(`Envoi refusé par Resend : ${body.message ?? `HTTP ${res.status}`}`, 502);
  return { id: body.id };
};

const cleanName = (s: unknown) => String(s ?? '').replace(/["<>\r\n]/g, '').trim().slice(0, NAME_MAX);

export type EmailDraft = { subject?: unknown; body?: unknown; fromName?: unknown };

export async function sendProspectEmail(db: Client, placeId: string, draft: EmailDraft, { now = new Date(), send = resendSender }: { now?: Date; send?: Sender } = {}) {
  const subject = typeof draft.subject === 'string' ? draft.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  const body = typeof draft.body === 'string' ? draft.body.replace(/\r\n?/g, '\n').trim() : '';
  if (!subject || subject.length > SUBJECT_MAX) throw new CrmError(`Objet manquant ou trop long (${SUBJECT_MAX} caractères au plus)`);
  if (!body || body.length > BODY_MAX) throw new CrmError(`Message manquant ou trop long (${BODY_MAX} caractères au plus)`);

  const lead = (await db.execute({
    sql: `SELECT name, email, email_check, crm_status FROM leads WHERE place_id = ? AND status NOT IN ('hors_cible', 'exclu')`,
    args: [placeId],
  })).rows[0];
  if (!lead) throw new CrmError('Lead introuvable', 404);
  const to = String(lead.email ?? '').trim().toLowerCase();
  if (!to) throw new CrmError('Aucune adresse e-mail pour ce lead');
  if (BLOCKED.has(String(lead.crm_status))) throw new CrmError('Ce lead ne doit plus être contacté.', 409);
  if (UNDELIVERABLE.has(String(lead.email_check))) throw new CrmError('Cette adresse rebondira : le domaine ne reçoit pas de courrier.', 409);
  const suppressed = (await db.execute({ sql: `SELECT 1 FROM suppressions WHERE email = ?`, args: [to] })).rows.length > 0;
  if (suppressed) throw new CrmError('Adresse désinscrite : plus aucun e-mail vers elle.', 409);
  if (!inContactWindow(now)) throw new CrmError('Hors créneau : les e-mails partent du lundi au vendredi, de 9 h à 18 h.', 409);
  const last = (await db.execute({ sql: `SELECT max(at) AS at FROM activities WHERE place_id = ? AND ${OUTBOUND}`, args: [placeId] })).rows[0]?.at;
  if (last && parisDay(new Date(String(last))) === parisDay(now)) {
    throw new CrmError('Déjà contacté aujourd’hui : un seul contact par lead et par jour, tous canaux confondus.', 409);
  }

  const config = mailConfig();
  const missing = [!config.key && 'RESEND_API', !config.from && 'MAIL_FROM'].filter(Boolean);
  if (missing.length) throw new CrmError(`Envoi non configuré : ${missing.join(', ')} manquant (domaine d’envoi à vérifier chez Resend).`, 503);

  const token = randomBytes(16).toString('base64url');
  const text = `${body}\n\n${footer(String(lead.name), token)}`;
  const fromName = cleanName(draft.fromName);
  const { id } = await send({
    from: fromName ? `${fromName} <${config.from}>` : config.from,
    to,
    replyTo: config.replyTo || undefined,
    subject,
    text,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl(token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    idempotencyKey: token,
  });

  // Envoi parti : on l'enregistre sans revérifier le garde-fou (le message ne revient pas).
  const at = now.toISOString();
  const status = String(lead.crm_status) === 'REP_POSITIVE' ? 'REP_POSITIVE' : 'CONTACTE';
  const next = status === 'CONTACTE' ? addBusinessDays(FOLLOW_UP_DAYS, now) : null;
  const writes: InStatement[] = [
    {
      sql: `INSERT INTO emails (place_id, to_email, subject, body, provider_id, unsub_token, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [placeId, to, subject, text, id, token, at],
    },
    {
      sql: `INSERT INTO activities (place_id, at, author, kind, from_status, to_status, channel, body) VALUES (?, ?, '', 'statut', ?, ?, 'email', ?)`,
      args: [placeId, at, String(lead.crm_status), status, `E-mail envoyé : « ${subject} »`],
    },
    {
      sql: `UPDATE leads SET crm_status = ?, crm_channel = 'email', crm_updated_at = ?${next ? ', next_action_at = ?' : ''} WHERE place_id = ?`,
      args: next ? [status, at, next, placeId] : [status, at, placeId],
    },
  ];
  if (next) writes.push({ sql: `INSERT INTO activities (place_id, at, author, kind, body) VALUES (?, ?, '', 'relance', ?)`, args: [placeId, at, next] });
  await db.batch(writes, 'write');
  return getLead(db, placeId);
}

// --- Désinscription (lien public dans chaque e-mail) ---------------------------------

export async function unsubscribeInfo(db: Client, token: string): Promise<{ email: string; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = (await db.execute({
    sql: `SELECT e.to_email, l.name FROM emails e JOIN leads l USING (place_id) WHERE e.unsub_token = ?`,
    args: [token],
  })).rows[0];
  return row ? { email: String(row.to_email), name: String(row.name) } : null;
}

// Opposition définitive : liste de suppression + lead en NE PAS CONTACTER, tous canaux.
export async function unsubscribe(db: Client, token: string, now = new Date()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
  const row = (await db.execute({
    sql: `SELECT e.place_id, e.to_email, l.crm_status FROM emails e JOIN leads l USING (place_id) WHERE e.unsub_token = ?`,
    args: [token],
  })).rows[0];
  if (!row) return false;
  const at = now.toISOString();
  const writes: InStatement[] = [{
    sql: `INSERT INTO suppressions (email, place_id, reason, at) VALUES (?, ?, 'désinscription par e-mail', ?) ON CONFLICT (email) DO NOTHING`,
    args: [String(row.to_email), String(row.place_id), at],
  }];
  if (String(row.crm_status) !== 'NE_PAS_CONTACTER') {
    writes.push(
      {
        sql: `INSERT INTO activities (place_id, at, author, kind, from_status, to_status, body) VALUES (?, ?, '', 'statut', ?, 'NE_PAS_CONTACTER', 'Désinscription demandée depuis l’e-mail')`,
        args: [String(row.place_id), at, String(row.crm_status)],
      },
      { sql: `UPDATE leads SET crm_status = 'NE_PAS_CONTACTER', next_action_at = NULL, crm_updated_at = ? WHERE place_id = ?`, args: [at, String(row.place_id)] },
    );
  }
  await db.batch(writes, 'write');
  return true;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function unsubscribePage(state: 'confirmer' | 'fait' | 'invalide', token = '', name = ''): string {
  const body = state === 'invalide'
    ? '<h1>Lien invalide</h1><p>Ce lien de désinscription n’est pas reconnu. Répondez simplement « STOP » à notre message : nous ne vous contacterons plus.</p>'
    : state === 'fait'
      ? '<h1>C’est noté</h1><p>Vous ne recevrez plus de message de notre part.</p>'
      : `<h1>Ne plus recevoir nos messages</h1><p>${esc(salonName(name))} ne sera plus contacté par e-mail ni par téléphone.</p>
         <form method="post" action="/api/desinscription?t=${esc(token)}"><button type="submit">Confirmer</button></form>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Désinscription</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#1d1d1f;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
}
