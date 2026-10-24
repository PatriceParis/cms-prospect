import { existsSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { LOCAL_DB_URL, openDb } from './db.ts';
import { dbFingerprint } from './fingerprint.ts';
import { createClient } from '@libsql/client';
import { runCascade } from './enrich/cascade.ts';
import { copyEnrichments } from './enrich/sync.ts';
import { migrate } from './schema.ts';
import { runStage1, selectEnriched, selectSample, type LeadResult } from './enrich/stage1.ts';
import { ingestFile } from './ingest.ts';
import { scoreLeads } from './score.ts';
import { generateMaquettes, syncMaquettes, type GenerateReport } from './fold.ts';

const USAGE = `Usage :
  npm run ingest -- <export Apify .xlsx|.json> [...]
  npm run score
  npm run enrich -- --sample 20 [--nouveaux]
  npm run enrich -- --rejouer
  npm run enrich -- --cascade [--limit N] [--sans-fullenrich]
  npm run sync -- <base source, ex. file:data/prospection.db>
  npm run maquettes -- [--limit N]          crée la maquette des leads qui n'en ont pas
  npm run maquettes -- --sync [--complet]   relit liens, vues et demandes depuis l'outil
Ajouter --local pour viser data/prospection.db même si TURSO_DATABASE_URL est défini.`;

// Maquettes de site (API Fold) : création des manquantes, ou simple synchronisation.
async function maquettes(db: Client, args: string[]) {
  if (args.includes('--sync')) {
    const r = await syncMaquettes(db, { full: args.includes('--complet') });
    console.log(`Synchronisation : ${r.items} maquettes reçues, ${r.recorded} rattachées à un lead.`);
  } else {
    const i = args.indexOf('--limit');
    const limit = i >= 0 ? Number(args[i + 1]) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error(USAGE);
    let done = 0;
    const show = (r: GenerateReport) => {
      console.log(`\n${r.created} créées, ${r.existing} existaient déjà, ${r.errors.length} erreurs${r.notTried ? `, ${r.notTried} non tentées` : ''}.`);
      for (const e of r.errors) console.log(`  ✗ ${e.name} — ${e.error}`);
    };
    try {
      show(await generateMaquettes(db, { limit, onDone: (name, outcome) => console.log(`  ${String(++done).padStart(3)}. ${name} : ${outcome}`) }));
    } catch (err) {
      const report = (err as { report?: GenerateReport }).report;
      if (report) show(report);
      throw err;
    }
  }
  const { rows } = await db.execute(`SELECT count(*) AS n, count(m.link) AS links, coalesce(sum(m.views > 0), 0) AS seen, coalesce(sum(m.requests > 0), 0) AS asked
    FROM leads l LEFT JOIN maquettes m ON m.place_id = l.place_id WHERE l.status = 'nouveau'`);
  const t = rows[0];
  console.log(`Leads : ${t.n} · avec lien de maquette ${t.links} · maquettes vues ${t.seen} · demandes ${t.asked}.`);
}

// Copie les enrichissements d'une base source vers la base courante (Turso si configurée).
async function sync(db: Client, args: string[]) {
  const [sourceUrl] = args;
  if (!sourceUrl) throw new Error(USAGE);
  const target = process.env.TURSO_DATABASE_URL ?? 'base locale';
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL absente : la copie vise la base de production.');
  const source = createClient({ url: sourceUrl });
  await migrate(source);
  console.log(`Copie des enrichissements : ${sourceUrl} → ${target.split('://')[0]}://…${target.slice(-20)}`);
  const r = await copyEnrichments(source, db);
  console.log(`  ${r.runs} runs, ${r.enrichments} résultats copiés, ${r.skippedLeads} leads absents de la cible ignorés, ${r.consolidated} leads consolidés.`);
  source.close();
}

const STAGE_NAMES: Record<number, string> = { 2: 'Instagram', 3: 'LinkedIn', 4: 'FullEnrich', 5: 'Facebook' };

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
  console.log(`  Vérifiés   : ${r.verified.mx} domaines d'e-mail, ${r.verified.sites} sites`);
  const { rows } = await db.execute({
    sql: `SELECT count(*) AS n, count(email) AS email, sum(email_check IN ('sans_mx', 'inexistant')) AS bounce, count(instagram) AS ig,
            count(facebook) AS fb, sum(site_status = 'mort') AS dead, count(linkedin_url) AS li, count(contact_first_name) AS person, count(phone) AS phone
          FROM leads WHERE place_id IN (${leads.map(() => '?').join(',')})`,
    args: leads,
  });
  const t = rows[0];
  console.log(`\nSur ces ${t.n} leads : téléphone ${t.phone}, dirigeant nommé ${t.person}, Instagram ${t.ig}, Facebook ${t.fb}, ` +
    `e-mail ${t.email} (dont ${t.bounce ?? 0} qui rebondiront), LinkedIn ${t.li}, ancien site mort ${t.dead ?? 0}.`);
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
const local = args.includes('--local');
if (local && command === 'sync') throw new Error('sync vise la production : pas de --local.');
const db = await openDb(local ? LOCAL_DB_URL : undefined);
console.log(`Base : ${local || !process.env.TURSO_DATABASE_URL ? 'locale (data/prospection.db)' : `production (Turso, empreinte ${dbFingerprint(process.env.TURSO_DATABASE_URL)})`}`);
try {
  if (command === 'ingest') await ingest(db, args);
  else if (command === 'score') await score(db);
  else if (command === 'sync') await sync(db, args);
  else if (command === 'maquettes') await maquettes(db, args);
  else if (command === 'enrich' && args.includes('--cascade')) await cascade(db, args);
  else if (command === 'enrich') await enrich(db, args);
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
