import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Client, InStatement } from '@libsql/client';
import ExcelJS from 'exceljs';

export type PhoneKind = 'fixe' | 'mobile' | 'voip' | 'autre';

export type LeadRecord = {
  placeId: string;
  name: string;
  searchSector: string | null;
  googleCategory: string | null;
  rating: number | null;
  reviewsCount: number;
  phone: string | null;
  phoneKind: PhoneKind | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  neighborhood: string | null;
  photosCount: number;
  openingHours: string | null;
  claimed: boolean;
  mapsUrl: string | null;
  closed: boolean;
};

export type IngestReport = {
  file: string;
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  outOfTarget: { name: string; reason: string }[];
};

// Catégories Google prospectées. Toute autre catégorie est stockée en « hors_cible »
// et ne sort jamais vers l'enrichissement, l'envoi ni le CRM.
const TARGET_CATEGORIES = [
  'Salon de coiffure',
  'Barbier',
  'Institut de beauté',
  'Institut de soins du visage',
  'Centre de bien-être',
  'Salon de manucure',
  'Institut de massages',
  "Centre d'épilation laser",
  'Ramoneur',
];

const normalizeLabel = (s: string) => s.replace(/[’`]/g, "'").trim().toLowerCase();
const TARGET_SET = new Set(TARGET_CATEGORIES.map(normalizeLabel));

export function isTargetCategory(category: string | null): boolean {
  return category !== null && TARGET_SET.has(normalizeLabel(category));
}

export function normalizePhone(raw: string | null): { phone: string | null; kind: PhoneKind | null } {
  if (!raw) return { phone: null, kind: null };
  const compact = raw.replace(/[^\d+]/g, '');
  let e164: string | null = null;
  if (/^\+\d{8,15}$/.test(compact)) e164 = compact;
  else if (/^0033\d{9}$/.test(compact)) e164 = `+${compact.slice(2)}`;
  else if (/^0\d{9}$/.test(compact)) e164 = `+33${compact.slice(1)}`;
  if (!e164) return { phone: raw.trim(), kind: 'autre' };
  if (!e164.startsWith('+33')) return { phone: e164, kind: 'autre' };
  const first = e164[3];
  const kind: PhoneKind = '12345'.includes(first) ? 'fixe' : '67'.includes(first) ? 'mobile' : first === '9' ? 'voip' : 'autre';
  return { phone: e164, kind };
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function toCount(v: unknown, field: string, placeId: string): number {
  const n = toNumber(v);
  if (n === null) return 0;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} invalide (${String(v)}) pour ${placeId}`);
  return n;
}

// --- XLSX -------------------------------------------------------------------

const XLSX_COLUMNS = {
  placeId: 'Place ID',
  name: 'Établissement',
  searchSector: 'Secteur recherché',
  googleCategory: 'Catégorie Google',
  rating: 'Note',
  reviewsCount: 'Nb avis',
  phone: 'Téléphone',
  address: 'Adresse',
  postalCode: 'CP',
  city: 'Ville',
  neighborhood: 'Quartier',
  claimed: 'Fiche revendiquée par le pro',
  photosCount: 'Nb photos',
  mapsUrl: 'Lien Google Maps',
  openingHours: 'Horaires',
} as const;

const XLSX_REQUIRED = ['placeId', 'name', 'rating', 'reviewsCount', 'claimed', 'photosCount'] as const;

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) s = v.richText.map(r => r.text).join('');
    else if ('text' in v) s = String(v.text);
    else s = String(v);
  } else s = String(v);
  s = s.trim();
  return s === '' ? null : s;
}

function parseClaimed(v: string | null, placeId: string): boolean {
  const s = v?.toLowerCase();
  if (s === 'oui') return true;
  if (s === 'non') return false;
  throw new Error(`« Fiche revendiquée par le pro » doit valoir Oui ou Non (reçu ${v}) pour ${placeId}`);
}

async function readXlsx(name: string, data: Buffer): Promise<LeadRecord[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).map(cellText);
    if (!header.includes(XLSX_COLUMNS.placeId)) continue;

    const col = {} as Record<keyof typeof XLSX_COLUMNS, number>;
    for (const [key, label] of Object.entries(XLSX_COLUMNS)) col[key as keyof typeof XLSX_COLUMNS] = header.indexOf(label);
    const missing = XLSX_REQUIRED.filter(k => col[k] < 0).map(k => XLSX_COLUMNS[k]);
    if (missing.length) throw new Error(`Colonnes manquantes dans « ${ws.name} » : ${missing.join(', ')}`);

    const records: LeadRecord[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = row.values as ExcelJS.CellValue[];
      const get = (k: keyof typeof XLSX_COLUMNS) => (col[k] < 0 ? null : cellText(values[col[k]]));
      const placeId = get('placeId');
      if (!placeId) return;
      const { phone, kind } = normalizePhone(get('phone'));
      records.push({
        placeId,
        name: get('name') ?? placeId,
        searchSector: get('searchSector'),
        googleCategory: get('googleCategory'),
        rating: toNumber(get('rating')),
        reviewsCount: toCount(get('reviewsCount'), 'Nb avis', placeId),
        phone,
        phoneKind: kind,
        address: get('address'),
        postalCode: get('postalCode'),
        city: get('city'),
        neighborhood: get('neighborhood'),
        photosCount: toCount(get('photosCount'), 'Nb photos', placeId),
        openingHours: get('openingHours'),
        claimed: parseClaimed(get('claimed'), placeId),
        mapsUrl: get('mapsUrl'),
        closed: false, // le run Apify ne garde que les établissements ouverts
      });
    });
    return records;
  }
  throw new Error(`Aucune feuille avec une colonne « ${XLSX_COLUMNS.placeId} » dans ${name}`);
}

// --- JSON (dataset brut de compass/crawler-google-places) ------------------

type ApifyPlace = {
  placeId?: string;
  title?: string;
  searchString?: string;
  categoryName?: string;
  totalScore?: number | null;
  reviewsCount?: number | null;
  phone?: string | null;
  phoneUnformatted?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  imagesCount?: number | null;
  openingHours?: { day: string; hours: string }[] | null;
  claimThisBusiness?: boolean;
  url?: string | null;
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
};

function readJson(name: string, data: Buffer): LeadRecord[] {
  const items = JSON.parse(data.toString('utf8')) as unknown;
  if (!Array.isArray(items)) throw new Error(`${name} : un tableau JSON d'établissements est attendu`);
  return (items as ApifyPlace[]).map((p, i) => {
    if (!p.placeId) throw new Error(`${name} : élément ${i} sans placeId`);
    if (typeof p.claimThisBusiness !== 'boolean') throw new Error(`${name} : claimThisBusiness absent pour ${p.placeId}`);
    const { phone, kind } = normalizePhone(p.phoneUnformatted ?? p.phone ?? null);
    return {
      placeId: p.placeId,
      name: p.title ?? p.placeId,
      searchSector: p.searchString ?? null,
      googleCategory: p.categoryName ?? null,
      rating: toNumber(p.totalScore),
      reviewsCount: toCount(p.reviewsCount, 'reviewsCount', p.placeId),
      phone,
      phoneKind: kind,
      address: p.street ?? null,
      postalCode: p.postalCode ?? null,
      city: p.city ?? null,
      neighborhood: p.neighborhood ?? null,
      photosCount: toCount(p.imagesCount, 'imagesCount', p.placeId),
      openingHours: p.openingHours?.map(h => `${h.day} ${h.hours}`).join('; ') || null,
      // claimThisBusiness = Google affiche « Vous êtes propriétaire ? », donc fiche NON revendiquée
      claimed: !p.claimThisBusiness,
      mapsUrl: p.url ?? null,
      closed: Boolean(p.permanentlyClosed || p.temporarilyClosed),
    };
  });
}

export async function parseLeads(name: string, data: Buffer): Promise<LeadRecord[]> {
  const ext = extname(name).toLowerCase();
  if (ext === '.xlsx') return readXlsx(name, data);
  if (ext === '.json') return readJson(name, data);
  throw new Error(`Format non pris en charge : ${ext || 'aucune extension'} (attendu .xlsx ou .json)`);
}

// --- Stockage ----------------------------------------------------------------

function triage(r: LeadRecord): { status: 'nouveau' | 'hors_cible'; reason: string | null } {
  if (r.closed) return { status: 'hors_cible', reason: 'établissement fermé' };
  if (!isTargetCategory(r.googleCategory)) return { status: 'hors_cible', reason: `catégorie hors cible : ${r.googleCategory ?? 'aucune'}` };
  return { status: 'nouveau', reason: null };
}

const SOURCE_COLUMNS = [
  'name', 'search_sector', 'google_category', 'rating', 'reviews_count', 'phone', 'phone_kind',
  'address', 'postal_code', 'city', 'neighborhood', 'photos_count', 'opening_hours', 'claimed', 'maps_url',
] as const;

type SourceRow = Record<(typeof SOURCE_COLUMNS)[number], string | number | null>;

function toRow(r: LeadRecord): SourceRow {
  return {
    name: r.name,
    search_sector: r.searchSector,
    google_category: r.googleCategory,
    rating: r.rating,
    reviews_count: r.reviewsCount,
    phone: r.phone,
    phone_kind: r.phoneKind,
    address: r.address,
    postal_code: r.postalCode,
    city: r.city,
    neighborhood: r.neighborhood,
    photos_count: r.photosCount,
    opening_hours: r.openingHours,
    claimed: r.claimed ? 1 : 0,
    maps_url: r.mapsUrl,
  };
}

// Statuts pipeline qu'une ré-ingestion a le droit de recalculer : au-delà, le lead a
// avancé et un nouvel export ne doit pas le remettre à zéro. Le statut CRM n'est
// jamais touché par l'ingestion.
const RETRIAGEABLE = new Set(['nouveau', 'hors_cible']);

const INSERT_SQL = `
  INSERT INTO leads (place_id, ${SOURCE_COLUMNS.join(', ')}, status, status_reason, source_file, first_seen_at, updated_at)
  VALUES (:place_id, ${SOURCE_COLUMNS.map(c => `:${c}`).join(', ')}, :status, :status_reason, :source_file, :now, :now)`;
const UPDATE_SQL = `
  UPDATE leads SET ${SOURCE_COLUMNS.map(c => `${c} = :${c}`).join(', ')},
    status = :status, status_reason = :status_reason, source_file = :source_file, updated_at = :now
  WHERE place_id = :place_id`;

export async function storeLeads(db: Client, name: string, records: LeadRecord[], sha256: string): Promise<IngestReport> {
  const now = new Date().toISOString();
  const source = basename(name);
  const existing = new Map<string, Record<string, unknown>>();
  const current = await db.execute(`SELECT place_id, ${SOURCE_COLUMNS.join(', ')}, status, status_reason FROM leads`);
  for (const row of current.rows) existing.set(String(row.place_id), row as Record<string, unknown>);

  const report: IngestReport = { file: source, rowsRead: records.length, inserted: 0, updated: 0, unchanged: 0, duplicates: 0, outOfTarget: [] };
  const writes: InStatement[] = [];
  const seen = new Set<string>();

  for (const r of records) {
    if (seen.has(r.placeId)) {
      report.duplicates++;
      continue;
    }
    seen.add(r.placeId);

    const row = toRow(r);
    const { status, reason } = triage(r);
    if (status === 'hors_cible') report.outOfTarget.push({ name: r.name, reason: reason ?? '' });

    const before = existing.get(r.placeId);
    if (!before) {
      writes.push({ sql: INSERT_SQL, args: { place_id: r.placeId, ...row, status, status_reason: reason, source_file: source, now } });
      report.inserted++;
      continue;
    }

    const next = RETRIAGEABLE.has(String(before.status))
      ? { status, status_reason: reason }
      : { status: before.status as string, status_reason: before.status_reason as string | null };
    const changed =
      SOURCE_COLUMNS.some(c => before[c] !== row[c]) || before.status !== next.status || before.status_reason !== next.status_reason;
    if (!changed) {
      report.unchanged++;
      continue;
    }
    writes.push({ sql: UPDATE_SQL, args: { place_id: r.placeId, ...row, ...next, source_file: source, now } });
    report.updated++;
  }

  writes.push({
    sql: `INSERT INTO ingest_runs (file, sha256, rows_read, inserted, updated, unchanged, duplicates, out_of_target, ran_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [source, sha256, report.rowsRead, report.inserted, report.updated, report.unchanged, report.duplicates, report.outOfTarget.length, now],
  });
  await db.batch(writes, 'write'); // tout ou rien
  return report;
}

export async function ingestBuffer(db: Client, name: string, data: Buffer): Promise<IngestReport> {
  const sha256 = createHash('sha256').update(data).digest('hex');
  return storeLeads(db, name, await parseLeads(name, data), sha256);
}

export async function ingestFile(db: Client, file: string): Promise<IngestReport> {
  return ingestBuffer(db, file, await readFile(file));
}
