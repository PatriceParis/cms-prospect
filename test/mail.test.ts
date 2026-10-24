import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createClient, type Client } from '@libsql/client';
import { getLead } from '../src/crm.ts';
import { inContactWindow, sendProspectEmail, unsubscribe, unsubscribeInfo, type OutgoingEmail } from '../src/mail.ts';
import { migrate } from '../src/schema.ts';

// Prospect, adresses et clé fictifs : aucune donnée réelle dans le dépôt (public).
const MONDAY_10H = new Date('2026-10-26T09:00:00Z'); // lundi 10 h à Paris
const draft = { subject: 'Le site d’Atelier Zéphyr', body: 'Bonjour Claire,\n\nUn aperçu de votre site.\n\nCamille', fromName: 'Camille de Marque test' };

async function db(over: Record<string, unknown> = {}): Promise<Client> {
  const c = createClient({ url: ':memory:' });
  await migrate(c);
  const lead = { email: 'claire@zephyr.example', email_check: 'ok', crm_status: 'A_CONTACTER', ...over };
  await c.execute({
    sql: `INSERT INTO leads (place_id, name, reviews_count, photos_count, claimed, status, source_file, first_seen_at, updated_at, email, email_check, crm_status)
          VALUES ('ChIJ_mail', 'Atelier Zéphyr - Salon de coiffure', 10, 0, 0, 'nouveau', 'test', 'x', 'x', ?, ?, ?)`,
    args: [lead.email as string | null, lead.email_check as string | null, lead.crm_status as string],
  });
  return c;
}

function fakeSender() {
  const sent: OutgoingEmail[] = [];
  return { sent, send: async (m: OutgoingEmail) => (sent.push(m), { id: `re_${sent.length}` }) };
}

beforeEach(() => {
  process.env.RESEND_API = 're_test_cle_fictive';
  process.env.MAIL_FROM = 'camille@envoi.example';
  process.env.MAIL_REPLY_TO = 'contact@marque.example';
  process.env.APP_URL = 'https://crm.example';
});

describe('créneau de contact', () => {
  it('du lundi au vendredi, de 9 h à 18 h, heure de Paris', () => {
    assert.equal(inContactWindow(MONDAY_10H), true);
    assert.equal(inContactWindow(new Date('2026-10-26T06:30:00Z')), false); // 7 h 30
    assert.equal(inContactWindow(new Date('2026-10-26T17:00:00Z')), false); // 18 h
    assert.equal(inContactWindow(new Date('2026-10-25T09:00:00Z')), false); // dimanche
  });
});

describe('envoi d’un e-mail de prospection', () => {
  it('envoie en texte brut avec désinscription, note le contact et la relance à J+3', async () => {
    const c = await db();
    const { sent, send } = fakeSender();
    const lead = await sendProspectEmail(c, 'ChIJ_mail', draft, { now: MONDAY_10H, send });
    const m = sent[0];
    assert.equal(m.to, 'claire@zephyr.example');
    assert.equal(m.from, 'Camille de Marque test <camille@envoi.example>');
    assert.equal(m.replyTo, 'contact@marque.example');
    assert.match(m.text, /^Bonjour Claire,[\s\S]*Camille\n\n—\nVous recevez ce message parce qu’Atelier Zéphyr est référencé sur Google Maps\. Pour ne plus recevoir de message de notre part : https:\/\/crm\.example\/api\/desinscription\?t=[\w-]+$/);
    assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/crm\.example\/api\/desinscription\?t=[\w-]+>$/);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.deepEqual([lead.crm_status, lead.crm_channel, lead.next_action_at], ['CONTACTE', 'email', '2026-10-29']);
    const kinds = (lead.activities as { kind: string }[]).map(a => a.kind).sort();
    assert.deepEqual(kinds, ['relance', 'statut']);
    // Un seul contact par jour.
    await assert.rejects(sendProspectEmail(c, 'ChIJ_mail', draft, { now: MONDAY_10H, send }), { status: 409 });
    assert.equal(sent.length, 1);
  });

  it('refuse hors créneau, opposition, adresse qui rebondit, sans configuration', async () => {
    const { sent, send } = fakeSender();
    await assert.rejects(sendProspectEmail(await db(), 'ChIJ_mail', draft, { now: new Date('2026-10-25T09:00:00Z'), send }), /Hors créneau/);
    await assert.rejects(sendProspectEmail(await db({ crm_status: 'NE_PAS_CONTACTER' }), 'ChIJ_mail', draft, { now: MONDAY_10H, send }), { status: 409 });
    await assert.rejects(sendProspectEmail(await db({ email_check: 'inexistant' }), 'ChIJ_mail', draft, { now: MONDAY_10H, send }), /rebondira/);
    await assert.rejects(sendProspectEmail(await db({ email: null }), 'ChIJ_mail', draft, { now: MONDAY_10H, send }), /Aucune adresse/);
    await assert.rejects(sendProspectEmail(await db(), 'ChIJ_mail', { ...draft, subject: '' }, { now: MONDAY_10H, send }), /Objet/);
    delete process.env.MAIL_FROM;
    await assert.rejects(sendProspectEmail(await db(), 'ChIJ_mail', draft, { now: MONDAY_10H, send }), /MAIL_FROM/);
    assert.equal(sent.length, 0);
  });

  it('la désinscription bloque tout nouveau contact, définitivement', async () => {
    const c = await db();
    const { sent, send } = fakeSender();
    await sendProspectEmail(c, 'ChIJ_mail', draft, { now: MONDAY_10H, send });
    const token = /t=([\w-]+)/.exec(sent[0].text)![1];
    assert.deepEqual(await unsubscribeInfo(c, token), { email: 'claire@zephyr.example', name: 'Atelier Zéphyr - Salon de coiffure' });
    assert.equal(await unsubscribe(c, 'jeton-inconnu-1234567890'), false);
    assert.equal(await unsubscribe(c, token), true);
    assert.equal(await unsubscribe(c, token), true); // deux clics : sans effet de plus
    const lead = await getLead(c, 'ChIJ_mail');
    assert.deepEqual([lead.crm_status, lead.next_action_at], ['NE_PAS_CONTACTER', null]);
    // Même remis à contacter par erreur, l'adresse reste bloquée.
    await c.execute(`UPDATE leads SET crm_status = 'A_CONTACTER'`);
    await assert.rejects(sendProspectEmail(c, 'ChIJ_mail', draft, { now: new Date('2026-10-27T09:00:00Z'), send }), /désinscrite/);
  });
});
