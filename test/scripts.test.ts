import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScripts, emailUsable, missingSettings, ofCity, previewUrl, salonName } from '../public/scripts.js';

// Lead générique : aucune donnée réelle dans le dépôt (public).
const settings = { sender: 'Camille', brand: 'Vitrine Locale' };
const lead = {
  name: 'Atelier Zéphyr - Salon de coiffure',
  search_sector: 'Coiffeur',
  city: 'Bordeaux',
  reviews_count: 48,
  rating: 4.8,
  claimed: 0,
  contact_first_name: 'Claire',
  contact_last_name: 'Martin',
  phone_kind: 'mobile',
  crm_status: 'A_CONTACTER',
};
const friday = new Date('2026-10-23T10:00:00');
const allTexts = (s: ReturnType<typeof buildScripts>) =>
  [...s.call.steps.map(x => x.text), ...s.call.objections.flatMap(o => [o.q, o.a]), s.call.voicemail, s.instagram, s.whatsapp, s.email.subject, s.email.body].join('\n');

describe('scripts', () => {
  it('nom du salon sans la description Google', () => {
    assert.equal(salonName('Atelier Zéphyr - Salon de coiffure'), 'Atelier Zéphyr');
    assert.equal(salonName('Salon de beauté, coiffeur afro , ZÉPHYR HAIR'), 'ZÉPHYR HAIR');
    assert.equal(salonName('Le Petit Salon'), 'Le Petit Salon');
  });

  it('accorde « de » avec la ville', () => {
    assert.deepEqual(['Bordeaux', 'Le Bouscat', 'Les Mureaux', 'Eysines', 'La Teste-de-Buch'].map(ofCity), [
      'de Bordeaux', 'du Bouscat', 'des Mureaux', 'd’Eysines', 'de La Teste-de-Buch',
    ]);
  });

  it('personnalise prénom, salon, avis, fiche non revendiquée et lien de preview', () => {
    const s = buildScripts(lead, settings, { now: friday });
    assert.match(s.call.steps[0].text, /parler à Claire Martin ou à la personne qui gère le salon/);
    assert.match(s.call.steps[1].text, /^Je suis Camille de Vitrine Locale\. .*vos 48 avis à 4,8\/5/);
    assert.match(s.call.steps[2].text, /pas encore revendiquée/);
    assert.match(s.call.steps[3].text, /mardi/); // rappel à J+2 ouvrés depuis un vendredi
    assert.match(s.instagram, /^Bonjour Claire,/);
    assert.ok(s.instagram.includes(previewUrl(lead)!));
    assert.match(s.whatsapp, /numéro figure sur votre fiche Google/);
  });

  it('propose un canal d’envoi réel : jamais de SMS ni de WhatsApp vers un fixe', () => {
    const proposal = (over: object) => buildScripts({ ...lead, ...over }, settings).call.steps[3].text;
    assert.match(proposal({}), /par SMS ou WhatsApp/);
    assert.match(proposal({ phone_kind: 'fixe', instagram: 'zephyr' }), /en message sur Instagram/);
    assert.match(proposal({ phone_kind: 'fixe', email: 'a@b.fr' }), /par e-mail un exemple|envoie par e-mail/);
    assert.match(proposal({ phone_kind: 'fixe' }), /à quelle adresse/);
    // Adresse dont le domaine ne reçoit pas de courrier : on redemande l'adresse.
    assert.match(proposal({ phone_kind: 'fixe', email: 'a@b.fr', email_check: 'inexistant' }), /à quelle adresse/);
    assert.equal(emailUsable({ email: 'a@b.fr', email_check: 'sans_mx' }), false);
    assert.equal(emailUsable({ email: 'a@b.fr', email_check: null }), true);
    const voicemail = buildScripts({ ...lead, phone_kind: 'fixe' }, settings).call.voicemail;
    assert.match(voicemail, /^Bonjour, Camille de Vitrine Locale\./);
    assert.doesNotMatch(voicemail, /par message|SMS|WhatsApp/);
  });

  it('fiche revendiquée : le constat ne promet pas la réservation (souvent déjà sur Planity)', () => {
    const s = buildScripts({ ...lead, claimed: 1 }, settings);
    assert.match(s.call.steps[2].text, /pas sur un site qui présente vos prestations et vos photos/);
    assert.doesNotMatch(s.call.steps[2].text, /réserver/);
  });

  it('chaque message prospect laisse une porte de sortie', () => {
    const s = buildScripts(lead, settings);
    assert.match(s.instagram, /je ne vous relancerai pas/);
    assert.match(s.whatsapp, /je ne vous relancerai pas/);
    // E-mail : la désinscription est ajoutée par le serveur à l'envoi (src/mail.ts).
    assert.doesNotMatch(s.email.body, /STOP|désinscri/);
  });

  it('sans prénom ni fiche à récupérer ni exemple de site : textes adaptés, sans trou', () => {
    const s = buildScripts({ ...lead, search_sector: 'Institut de beauté', contact_first_name: null, claimed: 1 }, settings);
    assert.match(s.call.steps[0].text, /la personne qui gère l’institut/);
    assert.equal(s.link, null);
    assert.doesNotMatch(s.instagram, /https?:\/\//);
    assert.doesNotMatch(s.instagram, /revendiquée/);
    assert.doesNotMatch(allTexts(s), /undefined|null|\{|\}|\[|\]/);
  });

  it('maquette du prospect : présentée comme son site, jamais comme un exemple ; exemple du secteur si expirée', () => {
    const own = { ...lead, maquette_link: 'https://apercu.example/abc123', maquette_expires_at: '2026-11-20T00:00:00Z' };
    const s = buildScripts(own, settings, { now: friday });
    assert.equal(s.link, 'https://apercu.example/abc123');
    assert.match(s.instagram, /J’ai préparé un aperçu de votre site à partir de votre fiche Google : https:\/\/apercu\.example\/abc123/);
    assert.match(s.call.steps[3].text, /J’ai déjà préparé un aperçu de votre site/);
    assert.doesNotMatch(allTexts(s), /exemple de site/);
    const expired = buildScripts({ ...own, maquette_expires_at: '2026-10-01T00:00:00Z' }, settings, { now: friday });
    assert.equal(expired.link, previewUrl(lead));
    assert.match(expired.instagram, /Voici un exemple de site/);
  });

  it('e-mail : court, signal du salon, maquette, une seule question', () => {
    const own = { ...lead, maquette_link: 'https://apercu.example/abc123', maquette_expires_at: '2026-11-20T00:00:00Z' };
    const { email } = buildScripts(own, settings, { now: friday });
    assert.equal(email.subject, 'Le site d’Atelier Zéphyr');
    const words = email.body.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 110, `${words} mots`);
    assert.match(email.body, /^Bonjour Claire,\n\nVos 48 avis à 4,8\/5 sur Google le montrent : vos clients vous recommandent\./);
    assert.match(email.body, /J’ai donc préparé un aperçu de votre site, à partir de votre fiche Google : https:\/\/apercu\.example\/abc123/);
    assert.equal((email.body.match(/\?/g) ?? []).length, 1);
    assert.match(email.body, /P\.S\. Votre fiche Google n’est pas encore revendiquée/);
    // Note faible : pas de « vos clients vous recommandent ».
    assert.doesNotMatch(buildScripts({ ...own, rating: 3.9 }, settings).email.body, /recommandent/);
  });

  it('un lead déjà contacté reçoit les relances', () => {
    const s = buildScripts({ ...lead, crm_status: 'PAS_DE_REP' }, settings);
    assert.equal(s.followUp, true);
    assert.match(s.instagram, /Je reviens vers vous/);
    assert.equal(s.email.subject, 'Le site d’Atelier Zéphyr'); // même objet, sans faux « Re : »
    assert.match(s.email.body, /Est-ce que ce serait utile pour vous, ou ce n’est pas le moment \?/);
  });

  it('expéditeur et marque obligatoires', () => {
    assert.deepEqual(missingSettings({}), ['sender', 'brand']);
    assert.deepEqual(missingSettings({ sender: 'Camille', brand: ' ' }), ['brand']);
    assert.deepEqual(buildScripts(lead, settings).missing, []);
  });
});
