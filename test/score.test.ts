import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeScore, priorityOf, type ScoreInput } from '../src/score.ts';

// Entrées minimales : seuls les cinq critères du score comptent ici.
const base: ScoreInput = { reviewsCount: 0, rating: null, claimed: true, hasPhone: false, photosCount: 0 };
const score = (over: Partial<ScoreInput>) => computeScore({ ...base, ...over });

describe('computeScore', () => {
  it('nb avis : 1 point sous 10, 2 de 10 à 29, 3 dès 30', () => {
    assert.equal(score({ reviewsCount: 0 }).points.reviews, 1);
    assert.equal(score({ reviewsCount: 9 }).points.reviews, 1);
    assert.equal(score({ reviewsCount: 10 }).points.reviews, 2);
    assert.equal(score({ reviewsCount: 29 }).points.reviews, 2);
    assert.equal(score({ reviewsCount: 30 }).points.reviews, 3);
  });

  it('note : 1 point à partir de 4,5 inclus, rien sans note', () => {
    assert.equal(score({ rating: 4.4 }).points.rating, 0);
    assert.equal(score({ rating: 4.5 }).points.rating, 1);
    assert.equal(score({ rating: null }).points.rating, 0);
  });

  it('fiche NON revendiquée : 2 points ; revendiquée : 0', () => {
    assert.equal(score({ claimed: false }).points.unclaimed, 2);
    assert.equal(score({ claimed: true }).points.unclaimed, 0);
  });

  it('téléphone : 1 point ; photos : 1 point à partir de 10', () => {
    assert.equal(score({ hasPhone: true }).points.phone, 1);
    assert.equal(score({ photosCount: 9 }).points.photos, 0);
    assert.equal(score({ photosCount: 10 }).points.photos, 1);
  });

  it('bornes : 1 au minimum, 8 au maximum', () => {
    assert.equal(score({}).score, 1);
    assert.equal(score({ reviewsCount: 30, rating: 5, claimed: false, hasPhone: true, photosCount: 10 }).score, 8);
  });

  it('une fiche revendiquée plafonne à 6, donc jamais en priorité A', () => {
    const best = score({ reviewsCount: 1000, rating: 5, claimed: true, hasPhone: true, photosCount: 1000 });
    assert.equal(best.score, 6);
    assert.equal(best.priority, 'B');
  });
});

describe('priorityOf', () => {
  it('A dès 7, B dès 5, C en dessous', () => {
    assert.deepEqual([1, 4, 5, 6, 7, 8].map(priorityOf), ['C', 'C', 'B', 'B', 'A', 'A']);
  });
});
