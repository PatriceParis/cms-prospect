import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createClient } from '@libsql/client';
import { ingestFile, isTargetCategory, normalizePhone } from '../src/ingest.ts';
import { migrate } from '../src/schema.ts';

describe('normalizePhone', () => {
  it('met au format E.164 et classe fixe / mobile / box', () => {
    assert.deepEqual(normalizePhone('+33 5 56 72 79 35'), { phone: '+33556727935', kind: 'fixe' });
    assert.deepEqual(normalizePhone('06 52 33 34 89'), { phone: '+33652333489', kind: 'mobile' });
    assert.deepEqual(normalizePhone('+33 9 81 21 06 04'), { phone: '+33981210604', kind: 'voip' });
    assert.deepEqual(normalizePhone(null), { phone: null, kind: null });
  });
});

describe('isTargetCategory', () => {
  it('ignore la casse et le type d’apostrophe', () => {
    assert.equal(isTargetCategory('Centre d’épilation laser'), true);
    assert.equal(isTargetCategory('salon de coiffure'), true);
    assert.equal(isTargetCategory('Cabinet infirmier'), false);
    assert.equal(isTargetCategory(null), false);
  });
});

// Test d'intégration sur les vrais exports Apify déposés dans data/imports/
// (non versionnés : données personnelles). Sauté si le dossier est vide.
const IMPORTS = 'data/imports';
const exportsFound = existsSync(IMPORTS) ? readdirSync(IMPORTS).filter(f => /\.(xlsx|json)$/i.test(f)) : [];

describe('ingest sur les exports réels', { skip: exportsFound.length ? false : 'aucun export dans data/imports' }, () => {
  for (const file of exportsFound) {
    it(`${file} : relancer le même fichier ne crée ni doublon ni modification`, async () => {
      const db = createClient({ url: ':memory:' });
      await migrate(db);
      const first = await ingestFile(db, join(IMPORTS, file));
      assert.equal(first.inserted + first.duplicates, first.rowsRead);

      const second = await ingestFile(db, join(IMPORTS, file));
      assert.equal(second.inserted, 0);
      assert.equal(second.updated, 0);
      assert.equal(second.unchanged, first.inserted);

      const { rows } = await db.execute('SELECT count(*) AS n FROM leads');
      assert.equal(Number(rows[0].n), first.inserted);
      db.close();
    });
  }
});
