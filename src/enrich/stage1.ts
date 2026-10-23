import { createHash } from 'node:crypto';
import type { Client, InStatement } from '@libsql/client';
import { coreName, decide, evaluate, nafFor, nameTokens, parseAddress, type Candidate, type Decision } from './match.ts';
import { searchCompanies } from './sirene.ts';

// Étage 1 de l'enrichissement : retrouver l'entreprise et la personne derrière la
// fiche Google, via l'API Recherche d'entreprises. D'abord par l'adresse (fiable :
// une enseigne n'est souvent pas déclarée), puis par le nom si l'adresse ne suffit pas.
export const STAGE = 1;
export const SOURCE = 'recherche-entreprises';

export type LeadToEnrich = {
  place_id: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  google_category: string | null;
  search_sector: string | null;
};

export type LeadResult = { lead: LeadToEnrich; decision: Decision | null; error: string | null };

export type RunReport = {
  runId: number;
  mode: string;
  results: LeadResult[];
  counts: { leads: number; found: number; foundHigh: number; foundWithPerson: number; ambiguous: number; notFound: number; errors: number };
};

const LEAD_COLUMNS = 'place_id, name, address, postal_code, google_category, search_sector';

// Leads déjà passés à l'étage 1, pour les rejouer avec les règles du moment.
export async function selectEnriched(db: Client): Promise<LeadToEnrich[]> {
  const { rows } = await db.execute(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE status = 'nouveau' AND place_id IN (SELECT place_id FROM enrichments WHERE stage = ${STAGE})`,
  );
  return rows.map(r => ({ ...r }) as unknown as LeadToEnrich);
}

// Échantillon reproductible : ordre pseudo-aléatoire stable (hash du Place ID),
// réparti entre secteurs au prorata (méthode du plus fort reste). Avec onlyNew,
// on écarte les leads déjà passés à l'étage 1 : échantillon de contrôle, jamais vu
// pendant le réglage des règles.
export async function selectSample(db: Client, size: number, { onlyNew = false } = {}): Promise<LeadToEnrich[]> {
  const { rows } = await db.execute(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE status = 'nouveau'` +
      (onlyNew ? ` AND place_id NOT IN (SELECT place_id FROM enrichments WHERE stage = ${STAGE})` : ''),
  );
  const leads = rows.map(r => ({ ...r }) as unknown as LeadToEnrich);
  const hash = (id: string) => createHash('sha1').update(id).digest('hex');
  const bySector = new Map<string, LeadToEnrich[]>();
  for (const l of leads.sort((a, b) => hash(a.place_id).localeCompare(hash(b.place_id)))) {
    const key = l.search_sector ?? '';
    bySector.set(key, [...(bySector.get(key) ?? []), l]);
  }
  const quotas = [...bySector.entries()].map(([key, list]) => {
    const exact = (size * list.length) / leads.length;
    return { key, list, n: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = Math.min(size, leads.length) - quotas.reduce((s, q) => s + q.n, 0);
  for (const q of [...quotas].sort((a, b) => b.rest - a.rest)) if (left-- > 0) q.n++;
  return quotas.flatMap(q => q.list.slice(0, q.n));
}

// Fiche sans adresse (service à domicile) : recherche par nom dans toute la France,
// acceptée seulement si un seul candidat ressort.
async function matchWithoutPostalCode(lead: LeadToEnrich, naf: string[] | null): Promise<Decision> {
  const tokens = nameTokens(coreName(lead.name));
  if (!naf || tokens.length < 2) return { outcome: 'introuvable', best: null, candidates: [] };
  const found = await searchCompanies({ q: tokens.slice(0, 3).join(' '), etat_administratif: 'A', activite_principale: naf.join(',') });
  const candidates = found.flatMap(u => evaluate({ name: lead.name, address: null, postalCode: null }, u, 'nom'));
  const decision = decide(candidates);
  const accepted = new Set(candidates.filter(c => c.confidence).map(c => c.siren));
  return decision.outcome === 'trouve' && accepted.size > 1 ? { outcome: 'ambigu', best: null, candidates: decision.candidates } : decision;
}

export async function matchLead(lead: LeadToEnrich): Promise<Decision> {
  const naf = nafFor(lead.google_category);
  if (!lead.postal_code) return matchWithoutPostalCode(lead, naf);
  const filters: Record<string, string> = { code_postal: lead.postal_code, etat_administratif: 'A' };
  if (naf) filters.activite_principale = naf.join(',');
  const forMatch = { name: lead.name, address: lead.address, postalCode: lead.postal_code };

  const candidates: Candidate[] = [];
  if (lead.address) {
    const found = await searchCompanies({ q: parseAddress(lead.address).query, ...filters });
    candidates.push(...found.flatMap(u => evaluate(forMatch, u, 'adresse')));
  }
  let decision = decide(candidates);
  if (decision.outcome === 'trouve' && decision.best.confidence === 'haute') return decision;

  // Par le nom : d'abord dans le code postal, puis dans tout le département
  // (une micro-entreprise est souvent domiciliée chez la gérante, ailleurs).
  const tokens = nameTokens(coreName(lead.name)).slice(0, 3);
  const q = tokens.length ? tokens.join(' ') : coreName(lead.name);
  const byName = await searchCompanies({ q, ...filters });
  candidates.push(...byName.flatMap(u => evaluate(forMatch, u, 'nom')));
  decision = decide(candidates);
  if (decision.outcome === 'trouve') return decision;

  const { code_postal: _cp, ...wider } = filters;
  const departement = lead.postal_code.startsWith('97') ? lead.postal_code.slice(0, 3) : lead.postal_code.slice(0, 2);
  const byDept = await searchCompanies({ q, ...wider, departement });
  candidates.push(...byDept.flatMap(u => evaluate({ ...forMatch, postalCode: null }, u, 'nom')));
  return decide(candidates);
}

const UPSERT = `
  INSERT INTO enrichments (place_id, stage, source, outcome, confidence, method, siren, siret, legal_name, legal_form, naf,
    person_first_name, person_last_name, person_other_last_name, person_role, person_missing_reason, candidates, run_id, enriched_at)
  VALUES (:place_id, :stage, :source, :outcome, :confidence, :method, :siren, :siret, :legal_name, :legal_form, :naf,
    :first, :last, :other, :role, :missing, :candidates, :run_id, :at)
  ON CONFLICT (place_id, stage) DO UPDATE SET
    source = excluded.source, outcome = excluded.outcome, confidence = excluded.confidence, method = excluded.method,
    siren = excluded.siren, siret = excluded.siret, legal_name = excluded.legal_name, legal_form = excluded.legal_form,
    naf = excluded.naf, person_first_name = excluded.person_first_name, person_last_name = excluded.person_last_name,
    person_other_last_name = excluded.person_other_last_name, person_role = excluded.person_role,
    person_missing_reason = excluded.person_missing_reason, candidates = excluded.candidates,
    run_id = excluded.run_id, enriched_at = excluded.enriched_at`;

function toRow(r: LeadResult, runId: number, at: string) {
  const best = r.decision?.best ?? null;
  return {
    place_id: r.lead.place_id,
    stage: STAGE,
    source: SOURCE,
    outcome: r.error ? 'erreur' : r.decision!.outcome,
    confidence: best?.confidence ?? null,
    method: best?.foundBy ?? null,
    siren: best?.siren ?? null,
    siret: best?.siret ?? null,
    legal_name: best?.legalName ?? null,
    legal_form: best?.legalForm ?? null,
    naf: best?.naf ?? null,
    first: best?.person?.firstName ?? null,
    last: best?.person?.lastName ?? null,
    other: best?.person?.otherLastName ?? null,
    role: best?.person?.role ?? null,
    missing: best && !best.person ? best.personMissingReason : null,
    // Les candidats écartés restent consultables pour la file manuelle.
    candidates: r.decision?.candidates.length ? JSON.stringify(r.decision.candidates) : r.error,
    run_id: runId,
    at,
  };
}

export async function runStage1(db: Client, leads: LeadToEnrich[], mode: string, onLead?: (r: LeadResult, i: number) => void): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const run = await db.execute({
    sql: `INSERT INTO enrich_runs (stage, source, mode, leads, started_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: [STAGE, SOURCE, mode, leads.length, startedAt],
  });
  const runId = Number(run.rows[0].id);

  const results: LeadResult[] = [];
  for (const [i, lead] of leads.entries()) {
    let result: LeadResult;
    try {
      result = { lead, decision: await matchLead(lead), error: null };
    } catch (err) {
      result = { lead, decision: null, error: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    onLead?.(result, i);
  }

  const found = results.filter(r => r.decision?.outcome === 'trouve');
  const counts = {
    leads: results.length,
    found: found.length,
    foundHigh: found.filter(r => r.decision!.best!.confidence === 'haute').length,
    foundWithPerson: found.filter(r => r.decision!.best!.person).length,
    ambiguous: results.filter(r => r.decision?.outcome === 'ambigu').length,
    notFound: results.filter(r => r.decision?.outcome === 'introuvable').length,
    errors: results.filter(r => r.error).length,
  };

  const at = new Date().toISOString();
  const writes: InStatement[] = results.map(r => ({ sql: UPSERT, args: toRow(r, runId, at) }));
  writes.push({
    sql: `UPDATE enrich_runs SET found = ?, found_high = ?, found_with_person = ?, ambiguous = ?, not_found = ?, errors = ?, finished_at = ? WHERE id = ?`,
    args: [counts.found, counts.foundHigh, counts.foundWithPerson, counts.ambiguous, counts.notFound, counts.errors, at, runId],
  });
  await db.batch(writes, 'write');
  return { runId, mode, results, counts };
}
