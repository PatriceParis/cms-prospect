import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { createClient, type Client } from '@libsql/client';
import { getLead, listLeads, updateLead } from '../src/crm.ts';
import { ingestFile } from '../src/ingest.ts';
import { migrate } from '../src/schema.ts';
import { scoreLeads } from '../src/score.ts';

// Règles du CRM vérifiées sur le vrai export (data/imports, non versionné).
const IMPORTS = 'data/imports';
const file = existsSync(IMPORTS) ? readdirSync(IMPORTS).find(f => /\.(xlsx|json)$/i.test(f)) : undefined;

describe('CRM', { skip: file ? false : 'aucun export dans data/imports' }, () => {
  let db: Client;
  let ids: string[];

  before(async () => {
    db = createClient({ url: ':memory:' });
    await migrate(db);
    await ingestFile(db, join(IMPORTS, file!));
    await scoreLeads(db);
    ids = (await listLeads(db)).map(l => String(l.place_id));
  });

  it('liste uniquement les leads cibles, tous « À contacter » au départ', async () => {
    const leads = await listLeads(db);
    const { rows } = await db.execute(`SELECT count(*) AS n FROM leads WHERE status <> 'hors_cible'`);
    assert.equal(leads.length, Number(rows[0].n));
    assert.ok(leads.every(l => l.crm_status === 'A_CONTACTER'));
  });

  it('un lead hors cible est introuvable dans le CRM', async () => {
    const { rows } = await db.execute(`SELECT place_id FROM leads WHERE status = 'hors_cible' LIMIT 1`);
    if (!rows.length) return;
    await assert.rejects(getLead(db, String(rows[0].place_id)), { status: 404 });
  });

  it('changer de statut journalise l’auteur, le canal et la note', async () => {
    const lead = await updateLead(db, ids[0], 'Patrice', { status: 'CONTACTE', channel: 'telephone', note: 'Messagerie', nextActionAt: '2026-10-28' });
    assert.equal(lead.crm_status, 'CONTACTE');
    assert.equal(lead.next_action_at, '2026-10-28');
    const statut = lead.activities.find(a => a.kind === 'statut');
    assert.deepEqual(
      { author: statut?.author, from: statut?.from_status, to: statut?.to_status, channel: statut?.channel, body: statut?.body },
      { author: 'Patrice', from: 'A_CONTACTER', to: 'CONTACTE', channel: 'telephone', body: 'Messagerie' },
    );
    assert.ok(lead.activities.some(a => a.kind === 'relance' && a.body === '2026-10-28'));
  });

  it('refuse un statut, un canal ou une date inconnus', async () => {
    await assert.rejects(updateLead(db, ids[1], 'Patrice', { status: 'CLIENT' }), { status: 400 });
    await assert.rejects(updateLead(db, ids[1], 'Patrice', { status: 'CONTACTE', channel: 'pigeon' }), { status: 400 });
    await assert.rejects(updateLead(db, ids[1], 'Patrice', { nextActionAt: '2026-02-30' }), { status: 400 });
    await assert.rejects(updateLead(db, ids[1], 'Patrice', {}), { status: 400 });
  });

  it('l’opposition est définitive : plus de changement de statut ni de relance', async () => {
    const id = ids[2];
    await updateLead(db, id, 'Mariem', { status: 'CONTACTE', nextActionAt: '2026-10-30' });
    const opposed = await updateLead(db, id, 'Mariem', { status: 'NE_PAS_CONTACTER', note: 'Ne veut plus être appelée' });
    assert.equal(opposed.crm_status, 'NE_PAS_CONTACTER');
    assert.equal(opposed.next_action_at, null);

    for (const status of ['A_CONTACTER', 'CONTACTE', 'REP_POSITIVE']) {
      await assert.rejects(updateLead(db, id, 'Patrice', { status }), { status: 409 });
    }
    await assert.rejects(updateLead(db, id, 'Patrice', { nextActionAt: '2026-11-02' }), { status: 409 });

    // Une note reste possible (traçabilité), sans rouvrir le lead.
    const noted = await updateLead(db, id, 'Patrice', { note: 'Confirmé par écrit' });
    assert.equal(noted.crm_status, 'NE_PAS_CONTACTER');
  });

  it('une ré-ingestion du même fichier ne touche pas aux statuts CRM', async () => {
    await ingestFile(db, join(IMPORTS, file!));
    assert.equal((await getLead(db, ids[0])).crm_status, 'CONTACTE');
    assert.equal((await getLead(db, ids[2])).crm_status, 'NE_PAS_CONTACTER');
  });
});
