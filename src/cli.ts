import { existsSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { openDb } from './db.ts';
import { runCascade } from './enrich/cascade.ts';
import { runStage1, selectEnriched, selectSample, type LeadResult } from './enrich/stage1.ts';
import { ingestFile } from './ingest.ts';
import { scoreLeads } from './score.ts';

const USAGE = `Usage :
  npm run ingest -- <export Apify .xlsx|.json> [...]
  npm run score
  npm run enrich -- --sample 20 [--nouveaux]
  npm run enrich -- --rejouer
  npm run enrich -- --cascade [--limit N] [--sans-fullenrich]`;

const STAGE_NAMES: Record<number, string> = { 2: 'Instagram', 3: 'LinkedIn', 4: 'FullEnrich' };

// Cascade complète de collecte des contacts sur les leads cibles (ou les N premiers
// de l'échantillon reproductible). Chaque étape saute les leads qu'elle a déjà traités.
async function cascade(db: Client, args: string[]) {
  const i = args.indexOf('--limit');
  const limit = i >= 0 ? Number(args[i + 1]) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error(USAGE);
  const leads = limit
    ? (await selectSample(db, limit)).map(l => l.place_id)
    : (await db.execute(`SELECT place_id FROM leads WHERE status = 'nouveau'`)).rows.map(r => String(r.place_id));
  const fullEnrich = !args.includes('--sans-fullenrich');
  console.log(`Cascade sur ${leads.length} leads${fullEnrich ? '' : ' (sans FullEnrich)'}…`);
  const r = await runCascade(db, leads, { fullEnrich, mode: `cascade-${leads.length}` });
  console.log(`  Registre   : ${r.registre} leads nouvellement passés`);
  for (const s of r.stages) {
    const name = STAGE_NAMES[s.stage].padEnd(10);
    console.log(`  ${name} : ${s.leads} leads, ${s.found} trouvés, ${s.withEmail} avec e-mail${s.cost ? ` · coût ${s.cost}` : ''}`);
  }
  const { rows } = await db.execute({
    sql: `SELECT count(*) AS n, count(email) AS email, count(instagram) AS ig, count(linkedin_url) AS li, count(contact_first_name) AS person, count(phone) AS phone
          FROM leads WHERE place_id IN (${leads.map(() => '?').join(',')})`,
    args: leads,
  });
  const t = rows[0];
  console.log(`\nSur ces ${t.n} leads : téléphone ${t.phone}, dirigeant nommé ${t.person}, Instagram ${t.ig}, e-mail ${t.email}, LinkedIn ${t.li}.`);
}

async function ingest(db: Client, files: string[]) {
  if (!files.length) throw new Error(USAGE);
  for (const file of files) {
    const r = await ingestFile(db, file);
    console.log(`${r.file} : ${r.rowsRead} lignes lues`);
    console.log(`  ${r.inserted} nouveaux, ${r.updated} mis à jour, ${r.unchanged} inchangés, ${r.duplicates} doublons dans le fichier`);
    if (r.outOfTarget.length) {
      console.log(`  ${r.outOfTarget.length} hors cible (stockés, jamais prospectés) :`);
      for (const o of r.outOfTarget) console.log(`    - ${o.name} — ${o.reason}`);
    }
  }
  const { rows } = await db.execute(`SELECT count(*) AS n FROM leads`);
  console.log(`Base : ${rows[0].n} établissements.`);
}

async function score(db: Client) {
  const r = await scoreLeads(db);
  console.log(`${r.scored} leads scorés.\n`);
  const total = { A: 0, B: 0, C: 0 };
  const cell = (n: number) => String(n).padStart(3);
  console.log(`${'Secteur'.padEnd(22)}   A    B    C`);
  for (const [sector, p] of Object.entries(r.bySector).sort()) {
    console.log(`${sector.padEnd(22)} ${cell(p.A)}  ${cell(p.B)}  ${cell(p.C)}`);
    total.A += p.A;
    total.B += p.B;
    total.C += p.C;
  }
  console.log(`${'Total'.padEnd(22)} ${cell(total.A)}  ${cell(total.B)}  ${cell(total.C)}`);

  const { rows } = await db.execute(`
    SELECT name, google_category, reviews_count, rating, claimed, phone_kind, photos_count, score
    FROM leads WHERE priority = 'A' ORDER BY score DESC, reviews_count DESC`);
  if (rows.length) console.log('\nPriorité A :');
  for (const l of rows) {
    const claim = l.claimed ? 'revendiquée' : 'NON revendiquée';
    console.log(`  ${l.score}/8  ${l.name} (${l.google_category}) — ${l.reviews_count} avis, ${l.rating}★, ${l.photos_count} photos, fiche ${claim}, tél. ${l.phone_kind ?? 'aucun'}`);
  }
}

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)} %` : '—');

function describe(r: LeadResult): string {
  const where = `${r.lead.name} (${r.lead.postal_code ?? 'sans CP'})`;
  if (r.error) return `[erreur]      ${where} — ${r.error}`;
  const d = r.decision!;
  if (d.outcome !== 'trouve') {
    return d.outcome === 'introuvable'
      ? `[introuvable] ${where}`
      : `[ambigu]      ${where} — ${d.candidates.map(c => `${c.legalName} (${c.siren})`).join(' / ')}`;
  }
  const b = d.best;
  const person = b.person ? `${b.person.firstName} ${b.person.lastName}${b.person.role ? `, ${b.person.role}` : ''}` : `pas de personne : ${b.personMissingReason}`;
  return `[${b.confidence}]${' '.repeat(12 - b.confidence!.length)}${where} → ${b.legalName} · ${b.legalForm} · ${person} · par ${b.foundBy}, adresse ${b.addressRelation ?? 'différente'}, nom ${b.nameRelation}`;
}

// Étage 1 uniquement sur échantillon : l'industrialisation attend la mesure.
async function enrich(db: Client, args: string[]) {
  let sample;
  let mode;
  if (args.includes('--rejouer')) {
    sample = await selectEnriched(db);
    mode = 'rejeu';
  } else {
    const i = args.indexOf('--sample');
    const size = i >= 0 ? Number(args[i + 1]) : NaN;
    if (!Number.isInteger(size) || size <= 0) throw new Error(USAGE);
    const onlyNew = args.includes('--nouveaux');
    sample = await selectSample(db, size, { onlyNew });
    mode = `${onlyNew ? 'controle' : 'echantillon'}-${size}`;
  }
  console.log(`Étage 1 (Recherche d'entreprises), ${mode}, ${sample.length} leads :\n`);
  const r = await runStage1(db, sample, mode, res => console.log(describe(res)));
  const c = r.counts;
  console.log(`\nRun #${r.runId} — ${c.leads} leads`);
  console.log(`  Entreprise identifiée : ${c.found} (${pct(c.found, c.leads)}), dont ${c.foundHigh} en confiance haute`);
  console.log(`  Personne nommée       : ${c.foundWithPerson} (${pct(c.foundWithPerson, c.leads)})`);
  console.log(`  File manuelle         : ${c.ambiguous} ambigus, ${c.notFound} introuvables, ${c.errors} erreurs`);
}

if (existsSync('.env')) process.loadEnvFile('.env');
const [command, ...args] = process.argv.slice(2);
const db = await openDb();
try {
  if (command === 'ingest') await ingest(db, args);
  else if (command === 'score') await score(db);
  else if (command === 'enrich' && args.includes('--cascade')) await cascade(db, args);
  else if (command === 'enrich') await enrich(db, args);
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
