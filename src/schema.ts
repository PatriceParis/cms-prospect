import type { Client } from '@libsql/client';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS leads (
    place_id        TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    search_sector   TEXT,
    google_category TEXT,
    rating          REAL,
    reviews_count   INTEGER NOT NULL,
    phone           TEXT,             -- E.164 (+33…)
    phone_kind      TEXT,             -- fixe | mobile | voip | autre
    address         TEXT,
    postal_code     TEXT,
    city            TEXT,
    neighborhood    TEXT,
    photos_count    INTEGER NOT NULL,
    opening_hours   TEXT,
    claimed         INTEGER NOT NULL, -- 1 = fiche revendiquée par le gérant
    maps_url        TEXT,
    status          TEXT NOT NULL,    -- pipeline : nouveau | hors_cible
    status_reason   TEXT,
    score           INTEGER,
    priority        TEXT,             -- A | B | C
    scored_at       TEXT,
    source_file     TEXT NOT NULL,
    first_seen_at   TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id          INTEGER PRIMARY KEY,
    place_id    TEXT NOT NULL REFERENCES leads(place_id),
    at          TEXT NOT NULL,
    author      TEXT NOT NULL,
    kind        TEXT NOT NULL,        -- statut | note | relance
    from_status TEXT,
    to_status   TEXT,
    channel     TEXT,
    body        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS activities_by_lead ON activities (place_id, at)`,
  `CREATE TABLE IF NOT EXISTS ingest_runs (
    id            INTEGER PRIMARY KEY,
    file          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    rows_read     INTEGER NOT NULL,
    inserted      INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    unchanged     INTEGER NOT NULL,
    duplicates    INTEGER NOT NULL,
    out_of_target INTEGER NOT NULL,
    ran_at        TEXT NOT NULL
  )`,
];

// Colonnes ajoutées après la création de la table : ajoutées à chaud si absentes.
const ADDED_LEAD_COLUMNS: [name: string, ddl: string][] = [
  ['crm_status', `TEXT NOT NULL DEFAULT 'A_CONTACTER'`],
  ['crm_channel', 'TEXT'],
  ['next_action_at', 'TEXT'], // AAAA-MM-JJ
  ['crm_updated_at', 'TEXT'],
];

export async function migrate(db: Client): Promise<void> {
  await db.batch(STATEMENTS, 'write');
  const { rows } = await db.execute('PRAGMA table_info(leads)');
  const present = new Set(rows.map(r => String(r.name)));
  const missing = ADDED_LEAD_COLUMNS.filter(([name]) => !present.has(name));
  if (missing.length) await db.batch(missing.map(([name, ddl]) => `ALTER TABLE leads ADD COLUMN ${name} ${ddl}`), 'write');
}
