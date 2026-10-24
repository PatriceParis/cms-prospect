import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emailIn, facebookCandidates, facebookEmail, facebookPage, instagramCandidates, instagramEmail, instagramHandle, instagramShortcode,
  judgeFacebook, judgeInstagram, judgeLinkedIn, nameRelated, phoneKey, phonesIn, type LeadContact,
} from '../src/enrich/channels.ts';

// Lead et résultats génériques : aucune donnée réelle dans le dépôt (public).
const lead: LeadContact = { placeId: 'x', name: 'Atelier Zéphyr - Institut de beauté', city: 'Bordeaux', address: '12 Rue des Lilas', phone: '+33556000000' };

describe('téléphones et e-mails', () => {
  it('phoneKey identifie un numéro quel que soit son format', () => {
    assert.equal(phoneKey('+33 5 56 00 00 00'), phoneKey('05.56.00.00.00'));
    assert.equal(phoneKey('12'), null);
  });
  it('phonesIn et emailIn lisent un texte libre', () => {
    assert.deepEqual(phonesIn('Tél : 05 56 00 00 00 ou 06.12.34.56.78'), ['556000000', '612345678']);
    assert.equal(emailIn('Contact 📧 Atelier.Zephyr@Exemple.fr'), 'atelier.zephyr@exemple.fr');
  });
});

describe('Instagram', () => {
  it('reconnaît un profil, ignore les pages techniques', () => {
    assert.equal(instagramHandle('https://www.instagram.com/atelier.zephyr/'), 'atelier.zephyr');
    assert.equal(instagramHandle('https://www.instagram.com/atelier.zephyr/reels/'), 'atelier.zephyr');
    assert.equal(instagramHandle('https://www.instagram.com/p/AbC123/'), null);
    assert.equal(instagramShortcode('https://www.instagram.com/reel/AbC123/'), 'AbC123');
  });

  it('nameRelated retrouve le nom dans un pseudo collé', () => {
    assert.equal(nameRelated('Atelier Zéphyr', 'atelierzephyr_bdx'), true);
    assert.equal(nameRelated('Atelier Zéphyr', 'studio_lune'), false);
  });

  it('candidats : profils au nom du salon, publications seulement si elles citent le téléphone', () => {
    const c = instagramCandidates(lead, [
      { url: 'https://www.instagram.com/zephyr_bdx/', title: 'Zéphyr (@zephyr_bdx)' },
      { url: 'https://www.instagram.com/autre_salon/', title: 'Autre salon' },
      { url: 'https://www.instagram.com/p/AbC123/', description: 'RDV au 05 56 00 00 00' },
      { url: 'https://www.instagram.com/p/DeF456/', description: 'Sans rapport' },
    ]);
    assert.deepEqual(c.map(x => x.handle ?? x.url), ['zephyr_bdx', 'https://www.instagram.com/p/AbC123/']);
  });

  it('confiance haute sur le téléphone ou l’adresse, moyenne sur le nom et la ville', () => {
    const cand = { handle: 'zephyr_bdx', url: '', title: 'Zéphyr', snippet: '' };
    assert.equal(judgeInstagram(lead, cand, { business_phone_number: '+33 5 56 00 00 00' }).confidence, 'haute');
    assert.equal(judgeInstagram(lead, cand, { biography: '📍 12 rue des Lilas, Bordeaux' }).confidence, 'haute');
    assert.equal(judgeInstagram(lead, cand, { full_name: 'Atelier Zéphyr · Bordeaux' }).confidence, 'moyenne');
    assert.equal(judgeInstagram(lead, cand, { full_name: 'Atelier Zéphyr · Lyon' }).confidence, null);
  });

  it('sans preuve, un mot commun ne suffit pas : il faut le nom complet du salon', () => {
    const sophie: LeadContact = { ...lead, name: 'Le Salon de Lune', phone: null, address: null };
    const c = (handle: string, title: string) => ({ handle, url: '', title, snippet: 'Bordeaux' });
    assert.equal(judgeInstagram(sophie, c('leboudoirdelune', 'Le Boudoir de Lune'), null).confidence, null);
    assert.equal(judgeInstagram(sophie, c('lesalondelune_bdx', 'Le Salon de Lune'), null).confidence, 'moyenne');
  });

  it('e-mail : bouton Contact, puis bio, puis extrait Google', () => {
    assert.deepEqual(instagramEmail({ business_email: 'a@b.fr', emailSource: 'contact_button' }, ''), { email: 'a@b.fr', source: 'instagram_contact' });
    assert.deepEqual(instagramEmail({ biography: 'écrire à c@d.fr' }, ''), { email: 'c@d.fr', source: 'instagram_bio' });
    assert.deepEqual(instagramEmail(null, 'bio : e@f.fr'), { email: 'e@f.fr', source: 'google_extrait' });
    assert.equal(instagramEmail({ business_email: 'géraldine@exemple.fr' }, ''), null);
  });
});

describe('LinkedIn', () => {
  const person = { firstName: 'Claire', lastName: 'Martin' };
  it('exige le nom complet dans le titre, puis le salon ou la ville et le métier', () => {
    const url = 'https://fr.linkedin.com/in/claire-martin-1';
    assert.equal(judgeLinkedIn(lead, person, { url, title: 'Claire Martin - Atelier Zéphyr' }), 'haute');
    assert.equal(judgeLinkedIn(lead, person, { url, title: 'Claire Martin - Esthéticienne', personalInfo: { location: 'Bordeaux et périphérie' } }), 'moyenne');
    assert.equal(judgeLinkedIn(lead, person, { url, title: 'Claire Martin - Data scientist', personalInfo: { location: 'Bordeaux' } }), null);
    assert.equal(judgeLinkedIn(lead, person, { url, title: 'Claire Durand - Atelier Zéphyr' }), null);
  });

  it('le nom de la gérante ne compte pas comme nom du salon', () => {
    const named: LeadContact = { ...lead, name: 'Claire Martin' };
    assert.equal(judgeLinkedIn(named, person, { url: 'https://fr.linkedin.com/in/x', title: 'Claire Martin - Coach' }), null);
  });
});

describe('Facebook', () => {
  it('ramène une page ou une publication à l’URL de la page', () => {
    assert.equal(facebookPage('https://fr-fr.facebook.com/AtelierZephyr/posts/123'), 'https://www.facebook.com/AtelierZephyr/');
    assert.equal(facebookPage('https://www.facebook.com/profile.php?id=100064000000000&sk=about'), 'https://www.facebook.com/profile.php?id=100064000000000');
    assert.equal(facebookPage('https://www.facebook.com/groups/bordeaux-beaute/'), null);
    assert.equal(facebookPage('https://www.instagram.com/atelier.zephyr/'), null);
  });

  it('retient les pages qui rappellent le salon ou citent son numéro', () => {
    const found = facebookCandidates(lead, [
      { url: 'https://www.facebook.com/AtelierZephyrBordeaux/', title: 'Atelier Zéphyr | Bordeaux' },
      { url: 'https://www.facebook.com/AtelierZephyrBordeaux/photos/1', title: 'Atelier Zéphyr' },
      { url: 'https://www.facebook.com/mairie.bordeaux/', title: 'Mairie de Bordeaux' },
      { url: 'https://www.facebook.com/quartier.lilas/', title: 'Quartier des Lilas', description: 'Nos commerces : institut au 05 56 00 00 00' },
    ]);
    assert.deepEqual(found.map(c => c.url), ['https://www.facebook.com/AtelierZephyrBordeaux/', 'https://www.facebook.com/quartier.lilas/']);
  });

  it('seul le téléphone affiché par la page elle-même valide la page', () => {
    assert.equal(judgeFacebook(lead, { phone: '+33 5 56 00 00 00' }), true);
    assert.equal(judgeFacebook(lead, { phone: '+33 5 61 00 00 00', title: 'Atelier Zéphyr' }), false);
    assert.equal(judgeFacebook(lead, null), false);
    assert.equal(judgeFacebook({ ...lead, phone: null }, { phone: null }), false);
  });

  it('écarte les e-mails mal formés', () => {
    assert.equal(facebookEmail({ email: ' Contact@Atelier-Zephyr.fr ' }), 'contact@atelier-zephyr.fr');
    assert.equal(facebookEmail({ email: 'contact@atelier zephyr.fr' }), null);
  });
});
