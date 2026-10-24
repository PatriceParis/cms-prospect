import type { Client, InStatement } from '@libsql/client';
import { runActor } from './apify.ts';
import {
  facebookCandidates, facebookEmail, facebookPage, instagramCandidates, instagramEmail, instagramShortcode, judgeFacebook, judgeInstagram, judgeLinkedIn,
  type Confidence, type FbPage, type IgCandidate, type IgProfile, type LeadContact, type Organic,
} from './channels.ts';
import { enrichContacts } from './fullenrich.ts';
import { coreName } from './match.ts';
import { runStage1, type LeadToEnrich } from './stage1.ts';
import { emailDomain, siteHost, UNDELIVERABLE, verifyContacts } from './verify.ts';

// Cascade de collecte des contacts, dans l'ordre retenu le 23/10 (Facebook ajouté le 24/10) :
//   1 registre (personne) → 2 Instagram (compte, e-mail public) → 5 Facebook (e-mail public,
//   ancien site) → 3 LinkedIn (profil) → vérification DNS des e-mails et des sites
//   → 4 FullEnrich, en dernier recours, pour les dirigeants nommés encore sans e-mail valable.
// Chaque étape ne traite que les leads qu'elle n'a jamais vus : relancer ne refacture rien.
export const STAGE = { REGISTRE: 1, INSTAGRAM: 2, LINKEDIN: 3, FULLENRICH: 4, FACEBOOK: 5 } as const;

const GOOGLE = 'apify/google-search-scraper';
const IG_PROFILES = 'memo23/apify-instagram-profile-scraper-ppe';
const FB_PAGES = 'apify/facebook-pages-scraper';

type SerpItem = { searchQuery?: { term?: string }; organicResults?: Organic[] };
type Person = { firstName: string; lastName: string };

export type StageRow = {
  placeId: string;
  outcome: 'trouve' | 'ambigu' | 'introuvable' | 'erreur';
  confidence?: Confidence | null;
  method?: string | null;
  email?: string | null;
  emailSource?: string | null;
  instagram?: string | null;
  linkedinUrl?: string | null;
  contactPhone?: string | null;
  facebookUrl?: string | null;
  website?: string | null;
  candidates?: unknown;
};

export type StageReport = { stage: number; leads: number; found: number; withEmail: number; cost: string | null };

const SOURCES: Record<number, string> = { 2: 'instagram (google + profils)', 3: 'linkedin (google)', 4: 'fullenrich', 5: 'facebook (google + pages)' };

async function saveStage(db: Client, stage: number, mode: string, rows: StageRow[], cost: string | null): Promise<StageReport> {
  const now = new Date().toISOString();
  const found = rows.filter(r => r.outcome === 'trouve').length;
  const withEmail = rows.filter(r => r.email).length;
  const run = await db.execute({
    sql: `INSERT INTO enrich_runs (stage, source, mode, leads, found, found_high, found_with_email, ambiguous, not_found, errors, cost, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [
      stage, SOURCES[stage], mode, rows.length, found, rows.filter(r => r.confidence === 'haute').length, withEmail,
      rows.filter(r => r.outcome === 'ambigu').length, rows.filter(r => r.outcome === 'introuvable').length,
      rows.filter(r => r.outcome === 'erreur').length, cost, now, now,
    ],
  });
  const runId = Number(run.rows[0].id);
  const writes: InStatement[] = rows.map(r => ({
    sql: `INSERT INTO enrichments (place_id, stage, source, outcome, confidence, method, email, email_source, instagram, linkedin_url, contact_phone, facebook_url, website, candidates, run_id, enriched_at)
          VALUES (:place_id, :stage, :source, :outcome, :confidence, :method, :email, :email_source, :instagram, :linkedin_url, :contact_phone, :facebook_url, :website, :candidates, :run_id, :at)
          ON CONFLICT (place_id, stage) DO UPDATE SET source = excluded.source, outcome = excluded.outcome, confidence = excluded.confidence,
            method = excluded.method, email = excluded.email, email_source = excluded.email_source, instagram = excluded.instagram,
            linkedin_url = excluded.linkedin_url, contact_phone = excluded.contact_phone, facebook_url = excluded.facebook_url,
            website = excluded.website, candidates = excluded.candidates, run_id = excluded.run_id, enriched_at = excluded.enriched_at`,
    args: {
      place_id: r.placeId, stage, source: SOURCES[stage], outcome: r.outcome, confidence: r.confidence ?? null, method: r.method ?? null,
      email: r.email ?? null, email_source: r.emailSource ?? null, instagram: r.instagram ?? null, linkedin_url: r.linkedinUrl ?? null,
      contact_phone: r.contactPhone ?? null, facebook_url: r.facebookUrl ?? null, website: r.website ?? null,
      candidates: r.candidates === undefined ? null : JSON.stringify(r.candidates), run_id: runId, at: now,
    },
  }));
  if (writes.length) await db.batch(writes, 'write');
  return { stage, leads: rows.length, found, withEmail, cost };
}

const usd = (n: number | null) => (n === null ? null : `${n.toFixed(3)} $`);

// --- Étape 2 : Instagram --------------------------------------------------------

export async function runInstagram(db: Client, leads: LeadContact[], mode: string): Promise<StageReport> {
  if (!leads.length) return { stage: STAGE.INSTAGRAM, leads: 0, found: 0, withEmail: 0, cost: null };
  // Google, une requête par lead (la recherche native d'Instagram ne renvoie rien sans compte).
  const queryOf = (l: LeadContact) => `site:instagram.com ${coreName(l.name)} ${l.city ?? ''}`.trim();
  const queries = [...new Set(leads.map(queryOf))];
  const serp = await runActor<SerpItem>(GOOGLE, {
    queries: queries.join('\n'), maxPagesPerQuery: 1, countryCode: 'fr', languageCode: 'fr', saveHtmlToKeyValueStore: false,
  }, { maxChargeUsd: Math.max(0.5, queries.length * 0.005) });
  const organicByQuery = new Map(serp.items.map(i => [i.searchQuery?.term ?? '', i.organicResults ?? []]));
  const candidatesByLead = new Map(leads.map(l => [l.placeId, instagramCandidates(l, organicByQuery.get(queryOf(l)) ?? [])]));

  // Profils (e-mail du bouton Contact, téléphone, bio) ; une publication renvoie à son auteur.
  const all = [...candidatesByLead.values()].flat();
  const profiles = new Map<string, IgProfile>();
  const postAuthor = new Map<string, string>();
  let cost = serp.costUsd ?? 0;
  const scrape = async (urls: string[]) => {
    if (!urls.length) return;
    const run = await runActor<IgProfile & { url?: string; author_username?: string }>(IG_PROFILES, { startUrls: urls, includePosts: false }, { maxChargeUsd: Math.max(0.5, urls.length * 0.01) });
    cost += run.costUsd ?? 0;
    for (const item of run.items) {
      if (item.username) profiles.set(item.username.toLowerCase(), item);
      const code = item.url ? instagramShortcode(item.url) : null;
      if (code && item.author_username) postAuthor.set(code, item.author_username.toLowerCase());
    }
  };
  await scrape([...new Set(all.map(c => c.url))]);
  await scrape([...new Set([...postAuthor.values()].filter(h => !profiles.has(h)))].map(h => `https://www.instagram.com/${h}/`));

  const handleOf = (c: IgCandidate) => c.handle ?? postAuthor.get(instagramShortcode(c.url) ?? '') ?? null;
  const rows: StageRow[] = leads.map(lead => {
    const seen = new Set<string>();
    const judged = (candidatesByLead.get(lead.placeId) ?? []).map(c => {
      const handle = handleOf(c);
      const profile = handle ? (profiles.get(handle) ?? null) : null;
      return { c, handle, profile, ...judgeInstagram(lead, { ...c, handle }, profile) };
    }).filter(j => j.handle && !seen.has(j.handle) && seen.add(j.handle)); // un compte trouvé deux fois (profil et publication) ne compte qu'une fois
    const best = judged.find(j => j.confidence === 'haute') ?? judged.find(j => j.confidence === 'moyenne');
    const candidates = judged.map(j => ({ handle: j.handle, confidence: j.confidence, proof: j.proof }));
    if (!best) return { placeId: lead.placeId, outcome: judged.length ? 'ambigu' : 'introuvable', candidates };
    // Deux comptes différents au même niveau sans preuve forte : on ne choisit pas à l'aveugle.
    if (best.confidence === 'moyenne' && judged.filter(j => j.confidence === 'moyenne' && j.handle !== best.handle).length) {
      return { placeId: lead.placeId, outcome: 'ambigu', candidates };
    }
    const email = instagramEmail(best.profile, best.c.snippet);
    return {
      placeId: lead.placeId,
      outcome: 'trouve',
      confidence: best.confidence,
      method: best.proof,
      instagram: best.handle,
      email: email?.email ?? null,
      emailSource: email?.source ?? null,
      contactPhone: best.profile?.business_phone_number || null,
      candidates,
    };
  });
  return saveStage(db, STAGE.INSTAGRAM, mode, rows, usd(cost));
}

// --- Étape 5 : Facebook (e-mail public, site déclaré) --------------------------------

const pageKey = (url: string) => url.toLowerCase().replace(/^https?:\/\/(?:www\.|m\.|[a-z]{2}-[a-z]{2}\.)?/, '').replace(/\/+$/, '');

// Leads avec téléphone seulement : c'est la seule preuve acceptée (judgeFacebook).
export async function runFacebook(db: Client, leads: LeadContact[], mode: string): Promise<StageReport> {
  if (!leads.length) return { stage: STAGE.FACEBOOK, leads: 0, found: 0, withEmail: 0, cost: null };
  const queryOf = (l: LeadContact) => `site:facebook.com ${coreName(l.name)} ${l.city ?? ''}`.trim();
  const queries = [...new Set(leads.map(queryOf))];
  const serp = await runActor<SerpItem>(GOOGLE, {
    queries: queries.join('\n'), maxPagesPerQuery: 1, countryCode: 'fr', languageCode: 'fr', saveHtmlToKeyValueStore: false,
  }, { maxChargeUsd: Math.max(0.5, queries.length * 0.005) });
  const organicByQuery = new Map(serp.items.map(i => [i.searchQuery?.term ?? '', i.organicResults ?? []]));
  const candidatesByLead = new Map(leads.map(l => [l.placeId, facebookCandidates(l, organicByQuery.get(queryOf(l)) ?? [])]));

  const urls = [...new Set([...candidatesByLead.values()].flat().map(c => c.url))];
  let cost = serp.costUsd ?? 0;
  const pages = new Map<string, FbPage>();
  if (urls.length) {
    const run = await runActor<FbPage>(FB_PAGES, { startUrls: urls.map(url => ({ url })) }, { maxChargeUsd: Math.max(0.5, urls.length * 0.012) });
    cost += run.costUsd ?? 0;
    for (const p of run.items) for (const u of [p.facebookUrl, p.pageUrl]) if (u) pages.set(pageKey(facebookPage(u) ?? u), p);
  }

  const rows: StageRow[] = leads.map(lead => {
    const judged = (candidatesByLead.get(lead.placeId) ?? []).map(c => {
      const page = pages.get(pageKey(c.url)) ?? null;
      return { c, page, valid: judgeFacebook(lead, page) };
    });
    const candidates = judged.map(j => ({ url: j.c.url, title: j.page?.title ?? j.c.title, phone: j.page?.phone ?? null, valid: j.valid }));
    const valid = judged.filter(j => j.valid);
    if (!valid.length) return { placeId: lead.placeId, outcome: judged.length ? 'ambigu' : 'introuvable', candidates };
    const withEmail = valid.find(j => facebookEmail(j.page));
    const site = valid.flatMap(j => [j.page?.website, ...(j.page?.websites ?? [])]).find(w => siteHost(w));
    return {
      placeId: lead.placeId,
      outcome: 'trouve',
      confidence: 'haute',
      method: 'téléphone de la page',
      facebookUrl: valid[0].c.url,
      email: withEmail ? facebookEmail(withEmail.page) : null,
      emailSource: withEmail ? 'facebook' : null,
      website: site ?? null,
      candidates,
    };
  });
  return saveStage(db, STAGE.FACEBOOK, mode, rows, usd(cost));
}

// --- Étape 3 : LinkedIn ----------------------------------------------------------

export async function runLinkedIn(db: Client, leads: (LeadContact & { person: Person })[], mode: string): Promise<StageReport> {
  if (!leads.length) return { stage: STAGE.LINKEDIN, leads: 0, found: 0, withEmail: 0, cost: null };
  const queryOf = (l: { person: Person }) => `site:linkedin.com/in "${l.person.firstName} ${l.person.lastName}"`;
  const queries = [...new Set(leads.map(queryOf))];
  const serp = await runActor<SerpItem>(GOOGLE, {
    queries: queries.join('\n'), maxPagesPerQuery: 1, countryCode: 'fr', languageCode: 'fr', saveHtmlToKeyValueStore: false,
  }, { maxChargeUsd: Math.max(0.5, queries.length * 0.005) });
  const organicByQuery = new Map(serp.items.map(i => [i.searchQuery?.term ?? '', i.organicResults ?? []]));
  const rows: StageRow[] = leads.map(lead => {
    const judged = (organicByQuery.get(queryOf(lead)) ?? [])
      .map(r => ({ url: r.url ?? '', confidence: judgeLinkedIn(lead, lead.person, r) }))
      .filter(j => j.confidence);
    const best = judged.find(j => j.confidence === 'haute') ?? judged[0];
    return best
      ? { placeId: lead.placeId, outcome: 'trouve', confidence: best.confidence, linkedinUrl: best.url.split('?')[0], candidates: judged }
      : { placeId: lead.placeId, outcome: 'introuvable' };
  });
  return saveStage(db, STAGE.LINKEDIN, mode, rows, usd(serp.costUsd));
}

// --- Étape 4 : FullEnrich (dernier recours) -----------------------------------------

const USABLE = new Set(['DELIVERABLE', 'HIGH_PROBABILITY']);

export async function runFullEnrich(db: Client, leads: (LeadContact & { person: Person })[], mode: string): Promise<StageReport> {
  if (!leads.length) return { stage: STAGE.FULLENRICH, leads: 0, found: 0, withEmail: 0, cost: null };
  const { results, credits } = await enrichContacts(
    leads.map(l => ({ placeId: l.placeId, firstName: l.person.firstName, lastName: l.person.lastName, companyName: coreName(l.name) })),
    `cms-prospect ${mode}`,
  );
  const byLead = new Map(results.map(r => [r.placeId, r]));
  const rows: StageRow[] = leads.map(lead => {
    const r = byLead.get(lead.placeId);
    const pick = [r?.workEmail, r?.personalEmail].find(e => e && USABLE.has(e.status));
    if (!pick && !r?.linkedinUrl) return { placeId: lead.placeId, outcome: 'introuvable' };
    return {
      placeId: lead.placeId,
      outcome: 'trouve',
      confidence: pick ? (pick.status === 'DELIVERABLE' ? 'haute' : 'moyenne') : null,
      email: pick?.email.toLowerCase() ?? null,
      emailSource: pick ? (pick === r?.workEmail ? 'fullenrich_pro' : 'fullenrich_perso') : null,
      linkedinUrl: r?.linkedinUrl ?? null,
    };
  });
  return saveStage(db, STAGE.FULLENRICH, mode, rows, `${credits} crédits`);
}

// --- Consolidation sur le lead -----------------------------------------------------

type EnrichRow = Record<string, unknown> & { place_id: string; stage: number };

// Meilleure valeur par champ : pour l'e-mail, Instagram puis Facebook (confirmés par le
// téléphone) puis FullEnrich, en sautant les domaines qui ne reçoivent pas de courrier ;
// LinkedIn (Google) avant celui renvoyé par FullEnrich.
export async function consolidate(db: Client): Promise<number> {
  const { rows } = await db.execute(`SELECT * FROM enrichments ORDER BY place_id, stage`);
  const checks = (await db.execute(`SELECT kind, target, status FROM contact_checks`)).rows;
  const statusOf = (kind: string) => new Map(checks.filter(c => c.kind === kind).map(c => [String(c.target), String(c.status)]));
  const mx = statusOf('mx');
  const sites = statusOf('site');
  const mxOf = (email: unknown) => mx.get(emailDomain(String(email)) ?? '') ?? null;
  const byLead = new Map<string, Map<number, EnrichRow>>();
  for (const r of rows as unknown as EnrichRow[]) {
    const stages = byLead.get(r.place_id) ?? new Map();
    stages.set(Number(r.stage), r);
    byLead.set(r.place_id, stages);
  }
  const now = new Date().toISOString();
  const writes: InStatement[] = [];
  for (const [placeId, s] of byLead) {
    const reg = s.get(STAGE.REGISTRE);
    const ig = s.get(STAGE.INSTAGRAM);
    const li = s.get(STAGE.LINKEDIN);
    const fe = s.get(STAGE.FULLENRICH);
    const fb = s.get(STAGE.FACEBOOK);
    const person = reg?.outcome === 'trouve' && reg.person_first_name ? reg : null;
    const igOk = ig?.outcome === 'trouve' ? ig : null;
    const fbOk = fb?.outcome === 'trouve' ? fb : null;
    const emails = [igOk, fbOk, fe?.outcome === 'trouve' ? fe : null].filter(r => r?.email);
    // Une adresse qui rebondira reste affichée (marquée) seulement faute de mieux.
    const emailRow = emails.find(r => !UNDELIVERABLE.has(mxOf(r!.email) ?? '')) ?? emails[0];
    const host = siteHost(fbOk?.website as string | null);
    writes.push({
      sql: `UPDATE leads SET contact_first_name = ?, contact_last_name = ?, contact_role = ?, email = ?, email_source = ?, email_check = ?,
              instagram = ?, linkedin_url = ?, facebook = ?, site_declared = ?, site_status = ?, contacts_updated_at = ? WHERE place_id = ?`,
      args: [
        (person?.person_first_name as string) ?? null, (person?.person_last_name as string) ?? null, (person?.person_role as string) ?? null,
        (emailRow?.email as string) ?? null, (emailRow?.email_source as string) ?? null, emailRow ? mxOf(emailRow.email) : null,
        (igOk?.instagram as string) ?? null,
        ((li?.outcome === 'trouve' ? li.linkedin_url : null) ?? fe?.linkedin_url ?? null) as string | null,
        (fbOk?.facebook_url as string) ?? null, host, host ? (sites.get(host) ?? null) : null,
        now, placeId,
      ],
    });
  }
  if (writes.length) await db.batch(writes, 'write');
  return writes.length;
}

// --- Orchestration -------------------------------------------------------------------

export type CascadeReport = { registre: number; stages: StageReport[]; verified: { mx: number; sites: number }; consolidated: number };

// E-mails des étapes Instagram et Facebook dont le domaine n'est pas connu pour rebondir.
async function deliverableEmails(db: Client): Promise<Set<string>> {
  const { rows } = await db.execute(`SELECT place_id, email FROM enrichments WHERE stage IN (${STAGE.INSTAGRAM}, ${STAGE.FACEBOOK}) AND outcome = 'trouve' AND email IS NOT NULL`);
  const bad = new Set((await db.execute(`SELECT target, status FROM contact_checks WHERE kind = 'mx'`)).rows.filter(r => UNDELIVERABLE.has(String(r.status))).map(r => String(r.target)));
  return new Set(rows.filter(r => !bad.has(emailDomain(String(r.email)) ?? '')).map(r => String(r.place_id)));
}

export async function runCascade(db: Client, placeIds: string[], { fullEnrich = true, mode = 'cascade' } = {}): Promise<CascadeReport> {
  const ids = new Set(placeIds);
  const leadRows = (await db.execute(`SELECT place_id, name, address, postal_code, city, phone, google_category, search_sector FROM leads WHERE status = 'nouveau'`))
    .rows.filter(r => ids.has(String(r.place_id)));
  const done = async (stage: number) =>
    new Set((await db.execute({ sql: 'SELECT place_id FROM enrichments WHERE stage = ?', args: [stage] })).rows.map(r => String(r.place_id)));

  // 1. Registre
  const reg = await done(STAGE.REGISTRE);
  const toRegister = leadRows.filter(r => !reg.has(String(r.place_id))).map(r => ({ ...r }) as unknown as LeadToEnrich);
  if (toRegister.length) await runStage1(db, toRegister, mode);

  const contact = (r: Record<string, unknown>): LeadContact => ({
    placeId: String(r.place_id), name: String(r.name), city: (r.city as string) ?? null, address: (r.address as string) ?? null, phone: (r.phone as string) ?? null,
  });
  const persons = new Map(
    (await db.execute(`SELECT place_id, person_first_name, person_last_name FROM enrichments WHERE stage = 1 AND outcome = 'trouve' AND person_first_name IS NOT NULL`))
      .rows.map(r => [String(r.place_id), { firstName: String(r.person_first_name), lastName: String(r.person_last_name) }]),
  );
  const withPerson = (l: LeadContact) => (persons.has(l.placeId) ? [{ ...l, person: persons.get(l.placeId)! }] : []);
  const leads = leadRows.map(contact);
  const stages: StageReport[] = [];

  // 2. Instagram
  const ig = await done(STAGE.INSTAGRAM);
  stages.push(await runInstagram(db, leads.filter(l => !ig.has(l.placeId)), mode));

  // 5. Facebook (avant LinkedIn et FullEnrich : gratuit à valider, payé à la page)
  const fb = await done(STAGE.FACEBOOK);
  stages.push(await runFacebook(db, leads.filter(l => l.phone && !fb.has(l.placeId)), mode));

  // 3. LinkedIn
  const li = await done(STAGE.LINKEDIN);
  stages.push(await runLinkedIn(db, leads.filter(l => !li.has(l.placeId)).flatMap(withPerson), mode));

  // Vérification DNS : un e-mail qui rebondira ne dispense pas de FullEnrich.
  const verified = await verifyContacts(db);

  // 4. FullEnrich : dirigeants nommés toujours sans e-mail valable après Instagram et Facebook
  if (fullEnrich) {
    const fe = await done(STAGE.FULLENRICH);
    const hasEmail = await deliverableEmails(db);
    stages.push(await runFullEnrich(db, leads.filter(l => !fe.has(l.placeId) && !hasEmail.has(l.placeId)).flatMap(withPerson), mode));
    const again = await verifyContacts(db);
    verified.mx += again.mx;
    verified.sites += again.sites;
  }

  return { registre: toRegister.length, stages, verified, consolidated: await consolidate(db) };
}
