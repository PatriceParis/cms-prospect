import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareAddress, compareName, coreName, decide, evaluate, fold, parseAddress, type UniteLegale } from '../src/enrich/match.ts';

// Structures minimales au format de l'API Recherche d'entreprises. Noms génériques :
// aucune donnée de lead ni de dirigeant réel dans le dépôt (public).
function ul(siren: string, opts: { nom: string; nj?: string; adresse: string; enseignes?: string[]; dirigeant?: [string, string] }): UniteLegale {
  return {
    siren,
    nom_complet: opts.nom,
    nature_juridique: opts.nj ?? '1000',
    statut_diffusion: 'O',
    dirigeants: opts.dirigeant ? [{ type_dirigeant: 'personne physique', nom: opts.dirigeant[1], prenoms: opts.dirigeant[0], qualite: null }] : [],
    matching_etablissements: [{ siret: `${siren}00011`, adresse: opts.adresse, code_postal: '33000', etat_administratif: 'A', liste_enseignes: opts.enseignes ?? null }],
  };
}
const lead = (name: string, address = '12 Av. de la Gare') => ({ name, address, postalCode: '33000' });
const ADDR = '12 AVENUE DE LA GARE 33000 BORDEAUX';

describe('normalisation', () => {
  it('fold gère accents, apostrophes typographiques et ligatures', () => {
    assert.equal(fold('Les mæssages d’Ô fée'), 'les maessages d o fee');
    assert.equal(fold('Cœur'), 'coeur');
  });

  it('parseAddress développe les abréviations et isole le numéro', () => {
    assert.deepEqual(parseAddress('11bis Pl. du Marché'), { number: '11', street: ['marche'], query: '11 place du marche' });
    assert.equal(parseAddress('8 Cr de la Somme').query, '8 cours de la somme');
  });

  it('compareAddress : exacte, même rue, ou rien', () => {
    assert.equal(compareAddress('12 Av. de la Gare', ADDR), 'exacte');
    assert.equal(compareAddress('14 Av. de la Gare', ADDR), 'rue');
    assert.equal(compareAddress('12 Rue du Port', ADDR), null);
  });

  it('coreName retire la description ajoutée au nom', () => {
    assert.equal(coreName('Atelier Zéphyr - Salon de coiffure'), 'Atelier Zéphyr');
    assert.equal(coreName('Studio Lune | Bien-être, soins'), 'Studio Lune');
    assert.equal(coreName('Salon de coiffure'), 'Salon de coiffure');
  });
});

describe('compareName', () => {
  it('reconnaît un nom collé et un mot distinctif commun', () => {
    assert.deepEqual(compareName('ABC HAIR', ['ABCHAIR'], []), { relation: 'concorde', full: true });
    assert.equal(compareName('Salon Zéphyr', ['ZEPHYR COIFFURE'], []).relation, 'concorde');
  });

  it('un seul mot commun ne suffit pas à accepter sans adresse', () => {
    assert.equal(compareName('Zéphyr', ['ZEPHYR DESIGN'], []).full, false);
    assert.equal(compareName('Zéphyr Lune', ['ZEPHYR LUNE'], []).full, true);
  });

  it('un nom de famille entre parenthèses n’est pas une enseigne', () => {
    assert.equal(compareName('Escale Zéphyr', ['DUPONT'], ['claire', 'martin', 'dupont']).relation, 'neutre');
    assert.equal(compareName('Escale Zéphyr', ['LUNE BEAUTE'], []).relation, 'diverge');
  });
});

describe('decide', () => {
  it('seule entreprise à l’adresse, sans enseigne : confiance haute', () => {
    const d = decide(evaluate(lead('Escale Zéphyr'), ul('100000001', { nom: 'CLAIRE MARTIN', adresse: ADDR, dirigeant: ['CLAIRE', 'MARTIN'] }), 'adresse'));
    assert.equal(d.outcome, 'trouve');
    assert.equal(d.best?.confidence, 'haute');
    assert.equal(d.best?.person?.firstName, 'Claire');
  });

  it('adresse exacte mais enseigne différente : file manuelle', () => {
    const d = decide(evaluate(lead('Escale Zéphyr'), ul('100000002', { nom: 'LUNE BEAUTE', nj: '5499', adresse: ADDR, dirigeant: ['ANNE', 'DURAND'] }), 'adresse'));
    assert.equal(d.outcome, 'ambigu');
  });

  it('« by Prénom » contredit une autre personne à l’adresse', () => {
    const d = decide(evaluate(lead('Studio Lune by Alice'), ul('100000003', { nom: 'BEA MARTIN', adresse: ADDR, dirigeant: ['BEA', 'MARTIN'] }), 'adresse'));
    assert.equal(d.outcome, 'ambigu');
  });

  it('deux entreprises concordantes : ambigu si personnes différentes, trouvé si même personne', () => {
    const a = ul('100000004', { nom: 'ZEPHYR', nj: '5710', adresse: ADDR, dirigeant: ['ANNE', 'DURAND'] });
    const b = ul('100000005', { nom: 'ANNE DURAND (ZEPHYR)', adresse: ADDR, dirigeant: ['ANNE', 'DURAND'] });
    const c = ul('100000006', { nom: 'PAUL ROUX (ZEPHYR)', adresse: ADDR, dirigeant: ['PAUL', 'ROUX'] });
    const l = lead('Zéphyr');
    assert.equal(decide([...evaluate(l, a, 'adresse'), ...evaluate(l, b, 'adresse')]).outcome, 'trouve');
    assert.equal(decide([...evaluate(l, a, 'adresse'), ...evaluate(l, c, 'adresse')]).outcome, 'ambigu');
  });

  it('diffusion partielle : entreprise trouvée, personne masquée', () => {
    const u = { ...ul('100000007', { nom: 'ZEPHYR', nj: '5499', adresse: ADDR, dirigeant: ['ANNE', 'DURAND'] }), statut_diffusion: 'P' };
    const d = decide(evaluate(lead('Zéphyr'), u, 'adresse'));
    assert.equal(d.outcome, 'trouve');
    assert.equal(d.best?.person, null);
    assert.equal(d.best?.personMissingReason, 'diffusion partielle');
  });
});
