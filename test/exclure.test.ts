import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient } from '@libsql/client';
import { excludeLeads, getLead, listLeads } from '../src/crm.ts';
import { storeLeads, type LeadRecord } from '../src/ingest.ts';
import { migrate } from '../src/schema.ts';

// Lead fictif : aucune donnée réelle dans le dépôt (public).
const record: LeadRecord = {
  placeId: 'ChIJ_test_exclu', name: 'Atelier Zéphyr', searchSector: 'Coiffeur', googleCategory: 'Salon de coiffure',
  rating: 4.8, reviewsCount: 48, phone: '+33556000000', phoneKind: 'fixe', address: '12 Rue des Lilas', postalCode: '33000',
  city: 'Bordeaux', neighborhood: null, photosCount: 12, openingHours: null, claimed: false, mapsUrl: null, closed: false,
};

describe('exclusion manuelle', () => {
  it('retire le lead du CRM, survit à un nouvel import, et s’annule', async () => {
    const db = createClient({ url: ':memory:' });
    await migrate(db);
    await storeLeads(db, 'export.xlsx', [record], 'a');
    assert.equal((await listLeads(db)).length, 1);

    assert.deepEqual(await excludeLeads(db, ['ChIJ_test_exclu'], { reason: 'pas une TPE' }), ['Atelier Zéphyr']);
    assert.equal((await listLeads(db)).length, 0);
    await assert.rejects(getLead(db, 'ChIJ_test_exclu'), { status: 404 });

    await storeLeads(db, 'export.xlsx', [{ ...record, reviewsCount: 50 }], 'b');
    const row = (await db.execute(`SELECT status, status_reason, reviews_count FROM leads`)).rows[0];
    assert.deepEqual({ ...row }, { status: 'exclu', status_reason: 'pas une TPE', reviews_count: 50 });
    assert.deepEqual(await excludeLeads(db, ['ChIJ_test_exclu']), []); // déjà exclu

    await excludeLeads(db, ['ChIJ_test_exclu'], { annuler: true });
    assert.equal((await listLeads(db)).length, 1);
    const notes = (await db.execute(`SELECT body FROM activities ORDER BY id`)).rows.map(r => r.body);
    assert.deepEqual(notes, ['Retiré de la liste de prospection : pas une TPE.', 'Remis dans la liste de prospection.']);
  });
});
