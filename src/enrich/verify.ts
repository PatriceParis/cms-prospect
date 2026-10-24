import type { Client, InStatement } from '@libsql/client';

// Vérifications gratuites sur les contacts trouvés, sans rien envoyer :
//  - e-mail : le domaine existe-t-il et a-t-il un serveur de messagerie (MX) ?
//    Mesure du 24/10 : 2 des 13 e-mails du CRM étaient sur un domaine mort.
//  - site déclaré sur une page Facebook : répond-il encore ? Un ancien site mort
//    est le meilleur signal de besoin (le lien de la page mène nulle part).
// Le DNS passe par DNS-over-HTTPS : le résolveur local refuse parfois les requêtes MX.
// Résultats mis en cache par domaine ou par site dans contact_checks.

export type MxStatus = 'ok' | 'sans_mx' | 'inexistant';
export type SiteStatus = 'repond' | 'mort';
export type Check<S> = { status: S; detail: string | null };

const DOH = 'https://dns.google/resolve';
const RECHECK_DAYS = 30;
const TIMEOUT_MS = 12_000;

// Adresses qui ne recevront pas le message : jamais proposées comme canal.
export const UNDELIVERABLE = new Set<string>(['sans_mx', 'inexistant']);

type DohAnswer = { Status: number; Answer?: { type: number; data: string }[] };

// Status 3 : NXDOMAIN. Un MX « 0 . » (RFC 7505) déclare que le domaine refuse le courrier.
export function classifyMx(r: DohAnswer): Check<MxStatus> | null {
  if (r.Status === 3) return { status: 'inexistant', detail: 'domaine inexistant' };
  if (r.Status !== 0) return null; // erreur du serveur DNS : on réessaiera
  const mx = (r.Answer ?? []).filter(a => a.type === 15).map(a => a.data.trim());
  if (!mx.length) return { status: 'sans_mx', detail: 'aucun serveur de messagerie' };
  if (mx.every(d => /^\d+\s+\.$/.test(d))) return { status: 'sans_mx', detail: 'le domaine refuse le courrier' };
  return { status: 'ok', detail: mx[0].replace(/^\d+\s+/, '').replace(/\.$/, '') };
}

export const emailDomain = (email: string) => email.split('@')[1]?.trim().toLowerCase() || null;

// Liens qui ne sont pas un site propre : réseaux, réservation, pages de liens.
const NOT_A_SITE = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|youtube\.com|linkedin\.com|twitter\.com|x\.com|wa\.me|whatsapp\.com|planity\.com|treatwell\.fr|kiute\.com|booksy\.com|fresha\.com|calendly\.com|linktr\.ee|google\.com|goo\.gl|g\.page|maps\.app\.goo\.gl)$/;

// « institut-beaute-cauderan.fr », « http://www.plenitude-bx.fr/ » → hôte sans www.
export function siteHost(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') && !NOT_A_SITE.test(host) ? host : null;
  } catch {
    return null;
  }
}

// 401/403 : le site existe mais filtre les robots. 404, 410 et 5xx : plus de site.
export function classifyHttp(status: number | null): Check<SiteStatus> {
  if (status === null) return { status: 'mort', detail: 'aucune réponse' };
  if (status === 404 || status === 410 || status >= 500) return { status: 'mort', detail: `HTTP ${status}` };
  return { status: 'repond', detail: `HTTP ${status}` };
}

async function doh(name: string, type: 'MX' | 'A'): Promise<DohAnswer | null> {
  try {
    const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as DohAnswer) : null;
  } catch {
    return null;
  }
}

export async function checkMx(domain: string): Promise<Check<MxStatus> | null> {
  const r = await doh(domain, 'MX');
  return r ? classifyMx(r) : null;
}

async function httpStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (vérification de lien)' } });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

export async function checkSite(host: string): Promise<Check<SiteStatus> | null> {
  const dns = await doh(host, 'A');
  if (!dns) return null;
  if (dns.Status === 3) return { status: 'mort', detail: 'domaine inexistant' };
  const status = (await httpStatus(`https://${host}/`)) ?? (await httpStatus(`http://${host}/`));
  return classifyHttp(status);
}

// Vérifie les domaines d'e-mail et les sites des enrichissements jamais vérifiés (ou
// vérifiés il y a plus de 30 jours). Renvoie le nombre de vérifications faites.
export async function verifyContacts(db: Client, { now = new Date() } = {}): Promise<{ mx: number; sites: number }> {
  const { rows } = await db.execute(`SELECT email, website FROM enrichments WHERE email IS NOT NULL OR website IS NOT NULL`);
  const { rows: known } = await db.execute(`SELECT kind, target, checked_at FROM contact_checks`);
  const limit = new Date(now.getTime() - RECHECK_DAYS * 86_400_000).toISOString();
  const fresh = new Set(known.filter(k => String(k.checked_at) > limit).map(k => `${k.kind}:${k.target}`));
  const domains = [...new Set(rows.map(r => (r.email ? emailDomain(String(r.email)) : null)).filter((d): d is string => !!d))].filter(d => !fresh.has(`mx:${d}`));
  const hosts = [...new Set(rows.map(r => siteHost(r.website as string | null)).filter((h): h is string => !!h))].filter(h => !fresh.has(`site:${h}`));

  const at = now.toISOString();
  const writes: InStatement[] = [];
  const save = (kind: string, target: string, c: Check<string> | null) => {
    if (c) writes.push({
      sql: `INSERT INTO contact_checks (kind, target, status, detail, checked_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (kind, target) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      args: [kind, target, c.status, c.detail, at],
    });
  };
  for (const d of domains) save('mx', d, await checkMx(d));
  for (const h of hosts) save('site', h, await checkSite(h));
  if (writes.length) await db.batch(writes, 'write');
  return { mx: domains.length, sites: hosts.length };
}
