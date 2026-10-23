import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildScripts, missingSettings, ofCity, previewUrl, salonName } from '../public/scripts.js';

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
    assert.match(s.call.steps[0].text, /parler à Claire/);
    assert.match(s.call.steps[1].text, /vos 48 avis à 4,8\/5/);
    assert.match(s.call.steps[2].text, /pas encore revendiquée/);
    assert.match(s.call.steps[3].text, /mardi/); // rappel à J+2 ouvrés depuis un vendredi
    assert.match(s.instagram, /^Bonjour Claire,/);
    assert.ok(s.instagram.includes(previewUrl(lead)!));
    assert.match(s.whatsapp, /numéro figure sur votre fiche Google/);
  });

  it('chaque message prospect laisse une porte de sortie', () => {
    const s = buildScripts(lead, settings);
    assert.match(s.instagram, /je ne vous relancerai pas/);
    assert.match(s.whatsapp, /je ne vous relancerai pas/);
    assert.match(s.email.body, /répondez simplement « STOP »/);
  });

  it('sans prénom ni fiche à récupérer ni exemple de site : textes adaptés, sans trou', () => {
    const s = buildScripts({ ...lead, search_sector: 'Institut de beauté', contact_first_name: null, claimed: 1 }, settings);
    assert.match(s.call.steps[0].text, /la personne qui gère l’institut/);
    assert.equal(s.link, null);
    assert.doesNotMatch(s.instagram, /https?:\/\//);
    assert.doesNotMatch(s.instagram, /revendiquée/);
    assert.doesNotMatch(allTexts(s), /undefined|null|\{|\}|\[|\]/);
  });

  it('un lead déjà contacté reçoit les relances', () => {
    const s = buildScripts({ ...lead, crm_status: 'PAS_DE_REP' }, settings);
    assert.equal(s.followUp, true);
    assert.match(s.instagram, /Je reviens vers vous/);
    assert.match(s.email.subject, /^Re :/);
  });

  it('expéditeur et marque obligatoires', () => {
    assert.deepEqual(missingSettings({}), ['sender', 'brand']);
    assert.deepEqual(missingSettings({ sender: 'Camille', brand: ' ' }), ['brand']);
    assert.deepEqual(buildScripts(lead, settings).missing, []);
  });
});
