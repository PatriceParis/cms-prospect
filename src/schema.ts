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
    kind        TEXT NOT NULL,        -- statut | note | relance | demande (maquette)
    from_status TEXT,
    to_status   TEXT,
    channel     TEXT,
    body        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS activities_by_lead ON activities (place_id, at)`,
  `CREATE TABLE IF NOT EXISTS enrichments (
    place_id               TEXT NOT NULL REFERENCES leads(place_id),
    stage                  INTEGER NOT NULL,   -- cascade : 1 registre, 2 Instagram, 3 LinkedIn, 4 FullEnrich, 5 Facebook
    source                 TEXT NOT NULL,
    outcome                TEXT NOT NULL,      -- trouve | ambigu | introuvable | erreur
    confidence             TEXT,               -- haute | moyenne
    method                 TEXT,               -- adresse | nom
    siren                  TEXT,
    siret                  TEXT,
    legal_name             TEXT,
    legal_form             TEXT,
    naf                    TEXT,
    person_first_name      TEXT,
    person_last_name       TEXT,
    person_other_last_name TEXT,
    person_role            TEXT,
    person_missing_reason  TEXT,
    candidates             TEXT,               -- JSON des candidats, pour la file manuelle
    run_id                 INTEGER NOT NULL,
    enriched_at            TEXT NOT NULL,
    PRIMARY KEY (place_id, stage)
  )`,
  `CREATE TABLE IF NOT EXISTS enrich_runs (
    id                INTEGER PRIMARY KEY,
    stage             INTEGER NOT NULL,
    source            TEXT NOT NULL,
    mode              TEXT NOT NULL,
    leads             INTEGER NOT NULL,
    found             INTEGER,
    found_high        INTEGER,
    found_with_person INTEGER,
    ambiguous         INTEGER,
    not_found         INTEGER,
    errors            INTEGER,
    started_at        TEXT NOT NULL,
    finished_at       TEXT
  )`,
  // Vérifications DNS et HTTP (src/enrich/verify.ts), par domaine d'e-mail ou par site.
  `CREATE TABLE IF NOT EXISTS contact_checks (
    kind       TEXT NOT NULL,                  -- mx | site
    target     TEXT NOT NULL,                  -- domaine de l'e-mail ou hôte du site
    status     TEXT NOT NULL,                  -- mx : ok | sans_mx | inexistant ; site : repond | mort
    detail     TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (kind, target)
  )`,
  // Maquette de site par prospect, créée et suivie par l'API Fold (src/fold.ts).
  `CREATE TABLE IF NOT EXISTS maquettes (
    place_id        TEXT PRIMARY KEY REFERENCES leads(place_id),
    status          TEXT NOT NULL,                -- creating | active | … (outil) ; erreur côté CRM
    link            TEXT,                         -- toujours lu dans la réponse, jamais construit
    expires_at      TEXT,
    views           INTEGER,
    first_view_at   TEXT,
    last_view_at    TEXT,
    requests        INTEGER,                      -- demandes « Je veux ce site »
    last_request_at TEXT,
    created_at      TEXT,
    error           TEXT,
    synced_at       TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

// Colonnes ajoutées après la création des tables : ajoutées à chaud si absentes.
const ADDED_COLUMNS: Record<string, [name: string, ddl: string][]> = {
  leads: [
    ['crm_status', `TEXT NOT NULL DEFAULT 'A_CONTACTER'`],
    ['crm_channel', 'TEXT'],
    ['next_action_at', 'TEXT'], // AAAA-MM-JJ
    ['crm_updated_at', 'TEXT'],
    // Contacts consolidés depuis la cascade d'enrichissement (src/enrich/contacts.ts)
    ['contact_first_name', 'TEXT'],
    ['contact_last_name', 'TEXT'],
    ['contact_role', 'TEXT'],
    ['email', 'TEXT'],
    ['email_source', 'TEXT'],
    ['instagram', 'TEXT'],
    ['linkedin_url', 'TEXT'],
    ['contacts_updated_at', 'TEXT'],
    ['email_check', 'TEXT'], // ok | sans_mx | inexistant (domaine de l'e-mail)
    ['facebook', 'TEXT'], // page Facebook validée par son propre téléphone
    ['site_declared', 'TEXT'], // site indiqué sur cette page (hôte)
    ['site_status', 'TEXT'], // repond | mort
  ],
  enrichments: [
    ['email', 'TEXT'],
    ['email_source', 'TEXT'],
    ['instagram', 'TEXT'],
    ['linkedin_url', 'TEXT'],
    ['contact_phone', 'TEXT'],
    ['facebook_url', 'TEXT'],
    ['website', 'TEXT'],
  ],
  enrich_runs: [
    ['found_with_email', 'INTEGER'],
    ['cost', 'TEXT'],
  ],
};

export async function migrate(db: Client): Promise<void> {
  await db.batch(STATEMENTS, 'write');
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const { rows } = await db.execute(`PRAGMA table_info(${table})`);
    const present = new Set(rows.map(r => String(r.name)));
    const missing = columns.filter(([name]) => !present.has(name));
    if (missing.length) await db.batch(missing.map(([name, ddl]) => `ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`), 'write');
  }
}
