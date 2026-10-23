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

export async function migrate(db: Client): Promise<void> {
  await db.batch(STATEMENTS, 'write');
}
