import type { Client, InStatement } from '@libsql/client';
import { consolidate } from './cascade.ts';

// Recopie les résultats d'enrichissement d'une base (la base locale) vers une autre (la
// production) sans refaire aucun appel payant. Seuls les leads présents dans la base
// cible sont concernés ; un résultat plus ancien n'écrase jamais un résultat plus récent.
const CHUNK = 100;

async function columns(db: Client, table: string): Promise<string[]> {
  return (await db.execute(`PRAGMA table_info(${table})`)).rows.map(r => String(r.name));
}

async function writeChunks(db: Client, writes: InStatement[]) {
  for (let i = 0; i < writes.length; i += CHUNK) await db.batch(writes.slice(i, i + CHUNK), 'write');
}

export type SyncReport = { runs: number; enrichments: number; skippedLeads: number; consolidated: number };

export async function copyEnrichments(source: Client, target: Client): Promise<SyncReport> {
  const targetLeads = new Set((await target.execute('SELECT place_id FROM leads')).rows.map(r => String(r.place_id)));
  if (!targetLeads.size) throw new Error('La base cible n’a aucun lead : importe d’abord l’export Apify (npm run ingest).');

  const sourceRunCols = new Set(await columns(source, 'enrich_runs'));
  const rc = (await columns(target, 'enrich_runs')).filter(c => sourceRunCols.has(c));
  const runs = (await source.execute(`SELECT ${rc.join(', ')} FROM enrich_runs`)).rows;
  await writeChunks(target, runs.map(r => ({
    sql: `INSERT INTO enrich_runs (${rc.join(', ')}) VALUES (${rc.map(() => '?').join(', ')}) ON CONFLICT (id) DO NOTHING`,
    args: rc.map(c => r[c] ?? null),
  })));

  const sourceEnrCols = new Set(await columns(source, 'enrichments'));
  const ec = (await columns(target, 'enrichments')).filter(c => sourceEnrCols.has(c));
  const rows = (await source.execute(`SELECT ${ec.join(', ')} FROM enrichments`)).rows;
  const kept = rows.filter(r => targetLeads.has(String(r.place_id)));
  const updates = ec.filter(c => c !== 'place_id' && c !== 'stage').map(c => `${c} = excluded.${c}`).join(', ');
  await writeChunks(target, kept.map(r => ({
    sql: `INSERT INTO enrichments (${ec.join(', ')}) VALUES (${ec.map(() => '?').join(', ')})
          ON CONFLICT (place_id, stage) DO UPDATE SET ${updates} WHERE excluded.enriched_at > enrichments.enriched_at`,
    args: ec.map(c => r[c] ?? null),
  })));

  // Vérifications DNS et HTTP : la plus récente l'emporte.
  const checks = (await source.execute('SELECT kind, target, status, detail, checked_at FROM contact_checks')).rows;
  await writeChunks(target, checks.map(c => ({
    sql: `INSERT INTO contact_checks (kind, target, status, detail, checked_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (kind, target) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at
          WHERE excluded.checked_at > contact_checks.checked_at`,
    args: [c.kind, c.target, c.status, c.detail, c.checked_at],
  })));

  return {
    runs: runs.length,
    enrichments: kept.length,
    skippedLeads: new Set(rows.filter(r => !targetLeads.has(String(r.place_id))).map(r => String(r.place_id))).size,
    consolidated: await consolidate(target),
  };
}
