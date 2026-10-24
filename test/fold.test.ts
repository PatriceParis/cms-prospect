import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createClient, type Client } from '@libsql/client';
import {
  generateMaquettes, handleFoldEvent, openingHoursOf, recordMaquette, signatureHeader, syncMaquettes, toApifyItem, verifySignature,
} from '../src/fold.ts';
import { migrate } from '../src/schema.ts';

// Prospects et clés fictifs : aucune donnée réelle ni aucun secret dans le dépôt (public).
const AT = '2026-10-24T10:00:00.000Z';
const lead = {
  place_id: 'ChIJ_test_1', name: 'Atelier Zéphyr', google_category: 'Salon de coiffure', phone: '+33556000000',
  address: '12 Rue des Lilas', postal_code: '33000', city: 'Bordeaux', neighborhood: null, rating: 4.8, reviews_count: 48,
  photos_count: 12, maps_url: 'https://maps.example/zephyr', claimed: 0, opening_hours: 'lun Fermé; mar 09:00 to 18:00',
  email: 'contact@zephyr.example', email_check: 'ok', instagram: 'atelier.zephyr', facebook: null,
};

async function db(): Promise<Client> {
  const c = createClient({ url: ':memory:' });
  await migrate(c);
  for (const id of ['ChIJ_test_1', 'ChIJ_test_2']) {
    await c.execute({
      sql: `INSERT INTO leads (place_id, name, reviews_count, photos_count, claimed, status, source_file, first_seen_at, updated_at)
            VALUES (?, 'Salon', 10, 0, 0, 'nouveau', 'test', ?, ?)`,
      args: [id, AT, AT],
    });
  }
  return c;
}

const maquette = (over: object = {}) => ({
  place_id: 'ChIJ_test_1', status: 'active', link: 'https://apercu.example/abc123', expires_at: '2026-11-23T10:00:00Z',
  views: 0, requests: 0, created_at: AT, ...over,
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFold(route: (url: URL, init: RequestInit) => Reply) {
  const calls: { url: URL; init: RequestInit }[] = [];
  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const r = route(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  });
  return calls;
}

beforeEach(() => {
  process.env.FOLD_API_KEY = 'fold_test_cle_fictive';
  process.env.FOLD_API_URL = 'https://fold.example/api/v1';
});
afterEach(() => mock.restoreAll());

describe('élément envoyé à l’outil (format Apify)', () => {
  it('reconstitue les horaires', () => {
    assert.deepEqual(openingHoursOf('lun Fermé; mar 09:00 to 18:00'), [{ day: 'lundi', hours: 'Fermé' }, { day: 'mardi', hours: '09:00 to 18:00' }]);
    assert.equal(openingHoursOf(null), null);
  });
  it('transmet Place ID, nom et contacts ; jamais de site, jamais un e-mail qui rebondira', () => {
    const item = toApifyItem(lead);
    assert.equal(item.placeId, 'ChIJ_test_1');
    assert.equal(item.title, 'Atelier Zéphyr');
    assert.equal(item.street, '12 Rue des Lilas');
    assert.equal(item.claimThisBusiness, true);
    assert.deepEqual(item.emails, ['contact@zephyr.example']);
    assert.equal('website' in item, false);
    assert.deepEqual(toApifyItem({ ...lead, email_check: 'inexistant' }).emails, []);
  });
});

describe('signature des notifications', () => {
  const secret = 'whsec_secret_fictif';
  const body = '{"event":"test"}';
  const sign = (b: string) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;
  it('accepte la bonne signature, refuse les autres', () => {
    assert.equal(verifySignature(body, sign(body), secret), true);
    assert.equal(verifySignature(`${body} `, sign(body), secret), false);
    assert.equal(verifySignature(body, 'sha256=00', secret), false);
    assert.equal(verifySignature(body, null, secret), false);
  });
  it('trouve l’en-tête de signature', () => {
    assert.equal(signatureHeader({ 'x-fold-signature': 'sha256=ab' }), 'sha256=ab');
    assert.equal(signatureHeader({ 'x-fold-sig': 'sha256=cd', 'x-other': 'sha256=ef' }), 'sha256=cd');
    assert.equal(signatureHeader({ 'content-type': 'application/json' }), null);
  });
});

describe('enregistrement des maquettes', () => {
  it('une nouvelle demande est notée et passe le lead en RÉP POSITIVE à rappeler le jour même', async () => {
    const c = await db();
    assert.equal(await recordMaquette(c, maquette()), true);
    assert.equal((await c.execute(`SELECT count(*) n FROM activities`)).rows[0].n, 0);
    await recordMaquette(c, maquette({ views: 2, requests: 1, last_request_at: AT }), { now: new Date(AT) });
    const lead1 = (await c.execute(`SELECT crm_status, next_action_at FROM leads WHERE place_id = 'ChIJ_test_1'`)).rows[0];
    assert.deepEqual({ ...lead1 }, { crm_status: 'REP_POSITIVE', next_action_at: '2026-10-24' });
    const kinds = (await c.execute(`SELECT kind FROM activities ORDER BY id`)).rows.map(r => r.kind);
    assert.deepEqual(kinds, ['demande', 'statut']);
    // Même état relu plus tard : rien de plus.
    await recordMaquette(c, maquette({ views: 3, requests: 1 }));
    assert.equal((await c.execute(`SELECT count(*) n FROM activities`)).rows[0].n, 2);
    assert.equal((await c.execute(`SELECT views FROM maquettes`)).rows[0].views, 3);
  });
  it('une ouverture n’est qu’un repère : ni statut ni historique', async () => {
    const c = await db();
    await recordMaquette(c, maquette());
    fakeFold(() => ({ status: 200, body: maquette({ views: 1, first_view_at: AT, last_view_at: AT }) }));
    assert.equal(await handleFoldEvent(c, { event: 'maquette.premiere_vue', place_id: 'ChIJ_test_1' }), 'maquette.premiere_vue');
    const row = (await c.execute(`SELECT l.crm_status, m.views FROM leads l JOIN maquettes m USING (place_id) WHERE place_id = 'ChIJ_test_1'`)).rows[0];
    assert.deepEqual({ ...row }, { crm_status: 'A_CONTACTER', views: 1 });
    assert.equal((await c.execute(`SELECT count(*) n FROM activities`)).rows[0].n, 0);
  });

  it('une opposition reste une opposition', async () => {
    const c = await db();
    await c.execute(`UPDATE leads SET crm_status = 'NE_PAS_CONTACTER' WHERE place_id = 'ChIJ_test_1'`);
    await recordMaquette(c, maquette({ requests: 1 }));
    assert.equal((await c.execute(`SELECT crm_status FROM leads WHERE place_id = 'ChIJ_test_1'`)).rows[0].crm_status, 'NE_PAS_CONTACTER');
  });
  it('ignore une maquette sans lead dans le CRM', async () => {
    assert.equal(await recordMaquette(await db(), maquette({ place_id: 'inconnu' })), false);
  });
  it('une notification de demande apporte le détail', async () => {
    const c = await db();
    await recordMaquette(c, maquette());
    fakeFold(() => ({ status: 200, body: maquette({ requests: 1 }) }));
    const handled = await handleFoldEvent(c, { event: 'maquette.demande', place_id: 'ChIJ_test_1', demande: { name: 'Claire', email: 'claire@exemple.fr' } });
    assert.equal(handled, 'maquette.demande');
    const body = String((await c.execute(`SELECT body FROM activities WHERE kind = 'demande'`)).rows[0].body);
    assert.match(body, /name : Claire · email : claire@exemple\.fr/);
  });
});

describe('API de l’outil', () => {
  it('synchronise depuis la dernière date, avec une minute de marge', async () => {
    const c = await db();
    const calls = fakeFold(() => ({ status: 200, body: { items: [maquette({ views: 1 }), maquette({ place_id: 'autre-agence' })] } }));
    assert.deepEqual(await syncMaquettes(c, { now: new Date(AT) }), { items: 2, recorded: 1 });
    await syncMaquettes(c, { now: new Date('2026-10-24T11:00:00.000Z') });
    assert.equal(calls[0].url.searchParams.get('since'), null);
    assert.equal(calls[1].url.searchParams.get('since'), '2026-10-24T09:59:00.000Z');
    assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, 'Bearer fold_test_cle_fictive');
  });

  it('génère une maquette par lead : créée, existante, ou erreur notée', async () => {
    const c = await db();
    await c.execute(`UPDATE leads SET score = 8 WHERE place_id = 'ChIJ_test_1'`);
    fakeFold((url, init) => {
      const item = JSON.parse(String(init.body));
      assert.equal(url.searchParams.get('attendre'), '1');
      return item.placeId === 'ChIJ_test_1'
        ? { status: 201, body: maquette() }
        : { status: 422, body: { error: 'invalide', message: 'Place ID ou nom manquant' } };
    });
    const r = await generateMaquettes(c);
    assert.equal(r.created, 1);
    assert.equal(r.errors.length, 1);
    const rows = (await c.execute(`SELECT place_id, status, link FROM maquettes ORDER BY place_id`)).rows.map(x => ({ ...x }));
    assert.deepEqual(rows, [
      { place_id: 'ChIJ_test_1', status: 'active', link: 'https://apercu.example/abc123' },
      { place_id: 'ChIJ_test_2', status: 'erreur', link: null },
    ]);
    // Relancer ne retente que le lead sans lien.
    const calls = fakeFold(() => ({ status: 200, body: { ...maquette({ place_id: 'ChIJ_test_2', link: 'https://apercu.example/def456' }), created: false } }));
    const again = await generateMaquettes(c);
    assert.equal(calls.length, 1);
    assert.equal(again.existing, 1);
  });

  it('s’arrête à la limite quotidienne de l’outil', async () => {
    const c = await db();
    fakeFold(() => ({ status: 429, body: { error: 'limite', message: 'limite quotidienne atteinte' } }));
    await assert.rejects(generateMaquettes(c), (err: Error & { report?: { created: number } }) => /limite quotidienne/.test(err.message) && err.report?.created === 0);
  });
});
