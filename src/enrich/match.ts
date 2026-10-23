// Rapprochement d'une fiche Google Maps avec une entreprise du registre (API
// Recherche d'entreprises). Fonctions pures, testées sans réseau.

export type Etablissement = {
  siret: string;
  adresse?: string | null;
  code_postal?: string | null;
  etat_administratif?: string | null;
  activite_principale?: string | null;
  liste_enseignes?: string[] | null;
};

export type Dirigeant = {
  type_dirigeant?: string;
  nom?: string | null;
  prenoms?: string | null;
  qualite?: string | null;
};

export type UniteLegale = {
  siren: string;
  nom_complet?: string | null;
  nom_raison_sociale?: string | null;
  nature_juridique?: string | null;
  activite_principale?: string | null;
  etat_administratif?: string | null;
  statut_diffusion?: string | null;
  dirigeants?: Dirigeant[] | null;
  siege?: Etablissement | null;
  matching_etablissements?: Etablissement[] | null;
};

export type Confidence = 'haute' | 'moyenne';
export type AddressRelation = 'exacte' | 'rue' | null;
export type NameRelation = 'concorde' | 'diverge' | 'neutre';

export type Person = { firstName: string; lastName: string; otherLastName: string | null; role: string | null };

export type Candidate = {
  foundBy: 'adresse' | 'nom';
  siren: string;
  siret: string;
  legalName: string;
  legalForm: string;
  naf: string | null;
  address: string;
  addressRelation: AddressRelation;
  nameRelation: NameRelation;
  nameFull: boolean;
  confidence: Confidence | null;
  person: Person | null;
  personMissingReason: string | null;
};

// Codes NAF par catégorie Google. Un salon peut être immatriculé sous un code
// voisin (soins personnels 96.09Z, vente de cosmétiques 47.75Z) : on interroge
// large, la concordance du code n'entre pas dans le score.
const NAF_BEAUTE = ['96.02A', '96.02B', '96.04Z', '96.09Z', '47.75Z'];
const NAF_BY_CATEGORY: Record<string, string[]> = {
  'salon de coiffure': NAF_BEAUTE,
  barbier: NAF_BEAUTE,
  'institut de beaute': NAF_BEAUTE,
  'institut de soins du visage': NAF_BEAUTE,
  'salon de manucure': NAF_BEAUTE,
  "centre d epilation laser": NAF_BEAUTE,
  'centre de bien etre': NAF_BEAUTE,
  'institut de massages': NAF_BEAUTE,
  ramoneur: ['81.22Z', '43.22B', '43.99C'],
};

export function nafFor(category: string | null): string[] | null {
  return category ? (NAF_BY_CATEGORY[fold(category)] ?? null) : null;
}

const LEGAL_FORMS: Record<string, string> = {
  '1000': 'Entreprise individuelle',
  '5498': 'EURL',
  '5499': 'SARL',
  '5710': 'SAS',
  '5720': 'SASU',
  '5202': 'SNC',
  '6540': 'SCI',
  '9220': 'Association',
};

export const legalFormLabel = (code: string | null | undefined) => (code ? (LEGAL_FORMS[code] ?? `Forme ${code}`) : 'Inconnue');

export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'a', 'au', 'aux', 'en', 'sur', 'chez', 'the', 'by']);
const STREET_ABBR: Record<string, string> = {
  av: 'avenue', ave: 'avenue', bd: 'boulevard', blvd: 'boulevard', cr: 'cours', crs: 'cours', pl: 'place',
  r: 'rue', imp: 'impasse', all: 'allee', rte: 'route', chem: 'chemin', sq: 'square', fg: 'faubourg',
  pass: 'passage', res: 'residence', qu: 'quai',
};
const STREET_TYPES = new Set([
  'rue', 'avenue', 'boulevard', 'cours', 'place', 'impasse', 'allee', 'route', 'chemin', 'square', 'faubourg',
  'passage', 'residence', 'quai', 'voie', 'galerie', 'centre', 'commercial', 'cc', 'bis', 'ter',
]);

export type ParsedAddress = { number: string | null; street: string[]; query: string };

export function parseAddress(raw: string): ParsedAddress {
  const tokens = fold(raw).split(' ').filter(Boolean);
  let number: string | null = null;
  let rest = tokens;
  const m = tokens[0]?.match(/^(\d+)[a-z]*$/);
  if (m) {
    number = m[1];
    rest = tokens.slice(1);
  }
  const expanded = rest.map(t => STREET_ABBR[t] ?? t);
  const street = expanded.filter(t => !STOPWORDS.has(t) && !STREET_TYPES.has(t));
  return { number, street, query: [number, ...expanded].filter(Boolean).join(' ') };
}

// Compare l'adresse Google à l'adresse déclarée au registre (qui contient aussi CP et ville).
export function compareAddress(google: string | null, registry: string | null | undefined): AddressRelation {
  if (!google || !registry) return null;
  const g = parseAddress(google);
  if (!g.street.length) return null;
  const r = fold(registry).split(' ').map(t => STREET_ABBR[t] ?? t);
  const streetShare = g.street.filter(t => r.includes(t)).length / g.street.length;
  if (streetShare < 0.6) return null;
  const numbers = r.map(t => t.match(/^(\d{1,4})[a-z]*$/)?.[1]).filter(Boolean);
  return g.number && numbers.includes(g.number) ? 'exacte' : 'rue';
}

// Mots qui décrivent le métier plutôt que l'établissement : ils ne discriminent rien.
const GENERIC_NAME_WORDS = new Set([
  ...STOPWORDS, 'salon', 'salons', 'coiffure', 'coiffures', 'coiffeur', 'coiffeuse', 'coiffeurs', 'institut', 'beaute',
  'barbier', 'barber', 'barbershop', 'shop', 'hair', 'spa', 'ongles', 'ongle', 'nails', 'nail', 'onglerie', 'esthetique',
  'estheticienne', 'soins', 'soin', 'visage', 'massage', 'massages', 'bien', 'etre', 'centre', 'studio', 'atelier',
  'maison', 'espace', 'beauty', 'cut', 'coupe', 'homme', 'femme', 'mixte', 'bordeaux', 'sarl', 'sas', 'sasu', 'eurl',
  'ei', 'afro', 'concept', 'style', 'ramonage', 'ramoneur', 'domicile',
]);

export function nameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return [...new Set(fold(s).split(' ').filter(t => t.length > 1 && !GENERIC_NAME_WORDS.has(t) && !/^\d+$/.test(t)))];
}

const parenthetical = (s: string | null | undefined) => [...(s ?? '').matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
const withoutParens = (s: string | null | undefined) => (s ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

function commercialNames(u: UniteLegale, etab: Etablissement): string[] {
  const isEi = u.nature_juridique === '1000';
  return [
    ...(isEi ? [] : [u.nom_raison_sociale ?? withoutParens(u.nom_complet)]),
    ...parenthetical(u.nom_complet),
    ...(etab.liste_enseignes ?? []),
    ...(u.siege?.liste_enseignes ?? []),
  ].filter(Boolean) as string[];
}

// Les fiches Google ajoutent souvent une description : « Tendance Vintage - Salon de
// coiffure », « Les mæssages d'Ô fée | Bien-être, soins… ». On garde le nom propre.
export function coreName(name: string): string {
  const first = name.split(/\s+[|–—-]\s+|\s*\|\s*/)[0];
  return nameTokens(first).length ? first.trim() : name;
}

const compact = (s: string) => fold(s).replace(/ /g, '');

// concorde : au moins un mot distinctif commun (ou le nom collé identique, « AKG HAIR » / « AKGHAIR ») ;
// full : nom collé identique, ou au moins deux mots distinctifs tous retrouvés. Un seul mot
// commun (« Urban », un prénom) ne suffit pas à accepter sans lien d'adresse.
// Les mots du nom du dirigeant ne comptent pas comme nom commercial : « MARINE TOURNOIS (CAYRE) »
// porte un nom de famille entre parenthèses, pas une enseigne.
export function compareName(googleName: string, commercial: string[], personTokens: string[]): { relation: NameRelation; full: boolean } {
  const g = nameTokens(googleName);
  const person = new Set(personTokens);
  const c = new Set(commercial.flatMap(nameTokens).filter(t => !person.has(t)));
  const sameCompact = commercial.some(n => compact(n).length >= 4 && compact(n) === compact(googleName));
  const hits = g.filter(t => c.has(t) || person.has(t));
  if (sameCompact || hits.length) {
    return { relation: 'concorde', full: sameCompact || (g.length >= 2 && hits.length === g.length) };
  }
  return { relation: c.size ? 'diverge' : 'neutre', full: false };
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, m => m.toUpperCase());

export function pickPerson(u: UniteLegale): { person: Person | null; reason: string | null } {
  if (u.statut_diffusion === 'P' || /NON-DIFFUSIBLE/i.test(u.nom_complet ?? '')) return { person: null, reason: 'diffusion partielle' };
  const people = (u.dirigeants ?? []).filter(d => d.type_dirigeant === 'personne physique' && d.nom && d.prenoms);
  const lead = people.find(d => /g[ée]rant|pr[ée]sident|entrepreneur|exploitant/i.test(d.qualite ?? '')) ?? people[0];
  if (!lead) return { person: null, reason: (u.dirigeants ?? []).length ? 'dirigeant personne morale' : 'aucun dirigeant publié' };
  const lastName = withoutParens(lead.nom);
  const other = parenthetical(lead.nom)[0] ?? null;
  return {
    person: {
      firstName: titleCase(String(lead.prenoms).split(/\s+/)[0]),
      lastName: titleCase(lastName),
      otherLastName: other && fold(other) !== fold(lastName) ? titleCase(other) : null,
      role: lead.qualite ?? (u.nature_juridique === '1000' ? 'Entrepreneur individuel' : null),
    },
    reason: null,
  };
}

export type LeadForMatch = { name: string; address: string | null; postalCode: string | null };

export function evaluate(lead: LeadForMatch, u: UniteLegale, foundBy: Candidate['foundBy']): Candidate[] {
  const etabs = (u.matching_etablissements?.length ? u.matching_etablissements : u.siege ? [u.siege] : []).filter(
    e => (e.etat_administratif ?? 'A') === 'A' && (!lead.postalCode || !e.code_postal || e.code_postal === lead.postalCode),
  );
  const { person, reason } = pickPerson(u);
  const personTokens = person ? nameTokens(`${person.firstName} ${person.lastName} ${person.otherLastName ?? ''}`) : [];
  const googleName = coreName(lead.name);
  // « Face Beauty Club by Agathe » désigne sa gérante : une autre personne à l'adresse
  // est un indice contraire, pas un nom neutre.
  const owner = /\bby\s+(\p{L}{3,})/iu.exec(lead.name)?.[1];
  return etabs.map(etab => {
    const addressRelation = compareAddress(lead.address, etab.adresse);
    const name = compareName(googleName, commercialNames(u, etab), personTokens);
    const nameRelation: NameRelation =
      owner && name.relation === 'neutre' && !personTokens.includes(fold(owner)) ? 'diverge' : name.relation;
    // haute    : adresse exacte + nom concordant (decide() y ajoute « seule entreprise à
    //            l'adresse, sans nom commercial qui la contredise »)
    // moyenne  : même rue + nom concordant, ou nom entièrement retrouvé sans lien d'adresse
    // sinon    : file manuelle, en particulier adresse exacte + nom commercial différent
    //            (un autre salon dans les mêmes murs).
    let confidence: Confidence | null = null;
    if (addressRelation === 'exacte' && nameRelation === 'concorde') confidence = 'haute';
    else if (addressRelation === 'rue' && nameRelation === 'concorde') confidence = 'moyenne';
    else if (addressRelation === null && name.full) confidence = 'moyenne';
    return {
      foundBy,
      siren: u.siren,
      siret: etab.siret,
      legalName: u.nom_complet ?? u.siren,
      legalForm: legalFormLabel(u.nature_juridique),
      naf: etab.activite_principale ?? u.activite_principale ?? null,
      address: etab.adresse ?? '',
      addressRelation,
      nameRelation,
      nameFull: name.full,
      confidence,
      person,
      personMissingReason: reason,
    };
  });
}

const RANK = { haute: 2, moyenne: 1 } as const;
const score = (c: Candidate) =>
  (c.confidence ? RANK[c.confidence] * 10 : 0) +
  (c.nameRelation === 'concorde' ? (c.nameFull ? 4 : 3) : 0) +
  (c.addressRelation === 'exacte' ? 2 : c.addressRelation === 'rue' ? 1 : 0);

const personKey = (c: Candidate) => (c.person ? fold(`${c.person.firstName} ${c.person.lastName}`) : `siren:${c.siren}`);

export type Decision =
  | { outcome: 'trouve'; best: Candidate; candidates: Candidate[] }
  | { outcome: 'ambigu' | 'introuvable'; best: null; candidates: Candidate[] };

// Retient le meilleur candidat ; deux candidats de même niveau sans nom concordant
// pour les départager partent dans la file manuelle plutôt que d'être tirés au sort.
export function decide(candidates: Candidate[]): Decision {
  const unique = [...new Map(candidates.map(c => [c.siret, { ...c }])).values()];
  // Une seule entreprise active à l'adresse exacte, sans nom commercial qui la contredise :
  // typiquement l'entreprise individuelle de la gérante. On la tient pour sûre.
  const atAddress = unique.filter(c => c.addressRelation === 'exacte');
  if (new Set(atAddress.map(c => c.siren)).size === 1 && atAddress.every(c => c.nameRelation === 'neutre')) {
    for (const c of atAddress) c.confidence = 'haute';
  }
  unique.sort((a, b) => score(b) - score(a));
  const accepted = unique.filter(c => c.confidence);
  if (!accepted.length) {
    // Des pistes sans certitude (même adresse, ou nom en partie commun) : à trancher à la main.
    const leads = unique.filter(c => c.addressRelation === 'exacte' || c.nameRelation === 'concorde');
    return leads.length
      ? { outcome: 'ambigu', best: null, candidates: leads.slice(0, 5) }
      : { outcome: 'introuvable', best: null, candidates: unique.slice(0, 5) };
  }
  const [first] = accepted;
  // Égalité entre entreprises différentes : ambigu, sauf si elles mènent à la même
  // personne (une gérante avec une EI puis une société) — l'étage 1 cherche la personne.
  const tied = accepted.filter(c => c.siren !== first.siren && score(c) === score(first));
  if (tied.some(c => personKey(c) !== personKey(first))) return { outcome: 'ambigu', best: null, candidates: accepted.slice(0, 5) };
  return { outcome: 'trouve', best: first, candidates: unique.slice(0, 5) };
}
