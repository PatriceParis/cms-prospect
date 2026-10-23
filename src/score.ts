import type { Client, InStatement } from '@libsql/client';

// Règle de score sur 8 points. Codée en dur volontairement : la changer est une
// décision commerciale, elle passe par un commit, pas par un fichier de config.
//   nb avis       ≥ 30 → 3 · ≥ 10 → 2 · sinon 1
//   note          ≥ 4,5 → 1
//   fiche         non revendiquée → 2
//   téléphone     présent → 1
//   photos        ≥ 10 → 1
// Priorité : A ≥ 7, B ≥ 5, C en dessous.
const REVIEWS_HIGH = 30;
const REVIEWS_MID = 10;
const RATING_MIN = 4.5;
const PHOTOS_MIN = 10;
const PRIORITY_A = 7;
const PRIORITY_B = 5;

export type Priority = 'A' | 'B' | 'C';

export type ScoreInput = {
  reviewsCount: number;
  rating: number | null;
  claimed: boolean;
  hasPhone: boolean;
  photosCount: number;
};

export type ScoreResult = {
  score: number;
  priority: Priority;
  points: { reviews: number; rating: number; unclaimed: number; phone: number; photos: number };
};

export function computeScore(input: ScoreInput): ScoreResult {
  const points = {
    reviews: input.reviewsCount >= REVIEWS_HIGH ? 3 : input.reviewsCount >= REVIEWS_MID ? 2 : 1,
    rating: input.rating !== null && input.rating >= RATING_MIN ? 1 : 0,
    unclaimed: input.claimed ? 0 : 2,
    phone: input.hasPhone ? 1 : 0,
    photos: input.photosCount >= PHOTOS_MIN ? 1 : 0,
  };
  const score = points.reviews + points.rating + points.unclaimed + points.phone + points.photos;
  return { score, priority: priorityOf(score), points };
}

export function priorityOf(score: number): Priority {
  return score >= PRIORITY_A ? 'A' : score >= PRIORITY_B ? 'B' : 'C';
}

export type ScoreReport = {
  scored: number;
  bySector: Record<string, Record<Priority, number>>;
};

export async function scoreLeads(db: Client): Promise<ScoreReport> {
  const now = new Date().toISOString();
  const { rows } = await db.execute(
    `SELECT place_id, search_sector, reviews_count, rating, claimed, phone, photos_count FROM leads WHERE status <> 'hors_cible'`,
  );
  // Un lead hors cible ne garde pas de score : il ne doit jamais remonter dans une file.
  const writes: InStatement[] = [`UPDATE leads SET score = NULL, priority = NULL, scored_at = NULL WHERE status = 'hors_cible'`];
  const report: ScoreReport = { scored: 0, bySector: {} };

  for (const r of rows) {
    const { score, priority } = computeScore({
      reviewsCount: Number(r.reviews_count),
      rating: r.rating === null ? null : Number(r.rating),
      claimed: Number(r.claimed) === 1,
      hasPhone: r.phone !== null,
      photosCount: Number(r.photos_count),
    });
    writes.push({ sql: 'UPDATE leads SET score = ?, priority = ?, scored_at = ? WHERE place_id = ?', args: [score, priority, now, String(r.place_id)] });
    const sector = r.search_sector === null ? 'Non renseigné' : String(r.search_sector);
    report.bySector[sector] ??= { A: 0, B: 0, C: 0 };
    report.bySector[sector][priority]++;
    report.scored++;
  }
  await db.batch(writes, 'write');
  return report;
}
