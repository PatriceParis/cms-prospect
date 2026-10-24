import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient } from '@libsql/client';
import { consolidate, STAGE } from '../src/enrich/cascade.ts';
import { classifyHttp, classifyMx, emailDomain, siteHost } from '../src/enrich/verify.ts';
import { migrate } from '../src/schema.ts';

// Domaines génériques (exemple.fr…) : aucune donnée réelle dans le dépôt (public).
describe('vérification des e-mails', () => {
  it('lit la réponse DNS : domaine inexistant, sans serveur de messagerie, valide', () => {
    assert.equal(classifyMx({ Status: 3 })?.status, 'inexistant');
    assert.equal(classifyMx({ Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] })?.status, 'sans_mx');
    assert.equal(classifyMx({ Status: 0, Answer: [{ type: 15, data: '0 .' }] })?.status, 'sans_mx');
    assert.deepEqual(classifyMx({ Status: 0, Answer: [{ type: 15, data: '10 mx1.exemple.fr.' }] }), { status: 'ok', detail: 'mx1.exemple.fr' });
    assert.equal(classifyMx({ Status: 2 }), null); // erreur du serveur DNS : à refaire
  });
  it('emailDomain', () => assert.equal(emailDomain('Contact@Exemple.FR'), 'exemple.fr'));
});

describe('vérification des sites', () => {
  it('siteHost garde le site propre, écarte réseaux et réservation', () => {
    assert.equal(siteHost('http://www.atelier-zephyr.fr/'), 'atelier-zephyr.fr');
    assert.equal(siteHost('atelier-zephyr.fr'), 'atelier-zephyr.fr');
    assert.equal(siteHost('https://www.planity.com/atelier-zephyr-33000-bordeaux'), null);
    assert.equal(siteHost('https://instagram.com/atelier.zephyr'), null);
    assert.equal(siteHost('http://atelierzephyr.booksy.com/'), null);
    assert.equal(siteHost(''), null);
  });
  it('classifyHttp : 404, 410, 5xx et absence de réponse = site mort ; 403 = protégé', () => {
    assert.equal(classifyHttp(null).status, 'mort');
    assert.equal(classifyHttp(404).status, 'mort');
    assert.equal(classifyHttp(503).status, 'mort');
    assert.equal(classifyHttp(403).status, 'repond');
    assert.equal(classifyHttp(200).status, 'repond');
  });
});

describe('consolidation', () => {
  it('préfère un e-mail délivrable, marque celui qui rebondira, reporte le site mort', async () => {
    const db = createClient({ url: ':memory:' });
    await migrate(db);
    const at = '2026-10-24T10:00:00.000Z';
    const lead = (id: string) => ({
      sql: `INSERT INTO leads (place_id, name, reviews_count, photos_count, claimed, status, source_file, first_seen_at, updated_at)
            VALUES (?, 'Salon', 0, 0, 0, 'nouveau', 'test', ?, ?)`,
      args: [id, at, at],
    });
    const enr = (id: string, stage: number, f: Record<string, string>) => ({
      sql: `INSERT INTO enrichments (place_id, stage, source, outcome, email, email_source, facebook_url, website, run_id, enriched_at)
            VALUES (?, ?, 'test', 'trouve', ?, ?, ?, ?, 1, ?)`,
      args: [id, stage, f.email ?? null, f.source ?? null, f.facebook ?? null, f.website ?? null, at],
    });
    const check = (kind: string, target: string, status: string) => ({
      sql: `INSERT INTO contact_checks (kind, target, status, checked_at) VALUES (?, ?, ?, ?)`, args: [kind, target, status, at],
    });
    await db.batch([
      lead('a'), lead('b'),
      enr('a', STAGE.INSTAGRAM, { email: 'contact@mort.fr', source: 'instagram_contact' }),
      enr('a', STAGE.FACEBOOK, { email: 'salon@exemple.fr', source: 'facebook', facebook: 'https://www.facebook.com/salon/', website: 'http://www.ancien-salon.fr/' }),
      enr('b', STAGE.INSTAGRAM, { email: 'contact@mort.fr', source: 'instagram_contact' }),
      check('mx', 'mort.fr', 'inexistant'), check('mx', 'exemple.fr', 'ok'), check('site', 'ancien-salon.fr', 'mort'),
    ], 'write');
    await consolidate(db);
    const { rows } = await db.execute(`SELECT place_id, email, email_source, email_check, facebook, site_declared, site_status FROM leads ORDER BY place_id`);
    assert.deepEqual({ ...rows[0] }, {
      place_id: 'a', email: 'salon@exemple.fr', email_source: 'facebook', email_check: 'ok',
      facebook: 'https://www.facebook.com/salon/', site_declared: 'ancien-salon.fr', site_status: 'mort',
    });
    assert.deepEqual({ ...rows[1] }, {
      place_id: 'b', email: 'contact@mort.fr', email_source: 'instagram_contact', email_check: 'inexistant',
      facebook: null, site_declared: null, site_status: null,
    });
  });
});
