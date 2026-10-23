// Validation des comptes Instagram et profils LinkedIn trouvés par Google pour un lead.
// Fonctions pures : la mesure du 23/10 a montré que le nom seul ramène des homonymes
// (un « Ali Sekhar » data scientist, un « LM Beauté » en Isère). Le téléphone et
// l'adresse de la fiche Google sont les preuves fortes.
import { compareAddress, coreName, fold, nameTokens } from './match.ts';

export type Organic = {
  title?: string;
  url?: string;
  description?: string;
  personalInfo?: { location?: string; jobTitle?: string; companyName?: string };
};

export type LeadContact = {
  placeId: string;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
};

export type Confidence = 'haute' | 'moyenne';

const compact = (s: string) => fold(s).replace(/ /g, '');

// Les 9 derniers chiffres identifient un numéro français quel que soit son format.
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

export function phonesIn(text: string | null | undefined): string[] {
  const found = (text ?? '').match(/(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/g) ?? [];
  return found.map(phoneKey).filter((k): k is string => k !== null);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
export const emailIn = (text: string | null | undefined) => EMAIL_RE.exec(text ?? '')?.[0].toLowerCase() ?? null;

// Le nom du salon se retrouve-t-il dans un pseudo ou un titre (« losmosebyleonie », « L'élégante ») ?
export function nameRelated(leadName: string, text: string, exclude: string[] = []): boolean {
  const skip = new Set(exclude.flatMap(e => fold(e).split(' ')));
  const tokens = nameTokens(coreName(leadName)).filter(t => t.length >= 3 && !skip.has(t));
  if (!tokens.length) return false;
  const words = new Set(fold(text.replace(/[._]/g, ' ')).split(' '));
  const glued = compact(text);
  return tokens.some(t => words.has(t) || (t.length >= 4 && glued.includes(t)));
}

// --- Instagram ---------------------------------------------------------------

const RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'popular', 'stories', 'tv', 'accounts', 'about', 'direct', 'tags', 'locations']);

export function instagramHandle(url: string): string | null {
  const m = /^https?:\/\/(?:[a-z]+\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:(?:reels|tagged)\/?)?(?:\?.*)?$/.exec(url);
  return m && !RESERVED.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

export function instagramShortcode(url: string): string | null {
  return /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel)\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null;
}

export type IgCandidate = { handle: string | null; url: string; title: string; snippet: string };

// Profils dont le pseudo ou le titre rappelle le salon, ou dont l'extrait cite son
// téléphone ; publications seulement si l'extrait cite le téléphone (on remontera à l'auteur).
export function instagramCandidates(lead: LeadContact, organic: Organic[], max = 3): IgCandidate[] {
  const leadPhone = phoneKey(lead.phone);
  const out: IgCandidate[] = [];
  const seen = new Set<string>();
  for (const r of organic) {
    if (!r.url) continue;
    const title = r.title ?? '';
    const snippet = r.description ?? '';
    const citesPhone = leadPhone !== null && phonesIn(snippet).includes(leadPhone);
    const handle = instagramHandle(r.url);
    if (handle) {
      if (seen.has(handle) || !(nameRelated(lead.name, `${handle} ${title}`) || citesPhone)) continue;
      seen.add(handle);
      out.push({ handle, url: `https://www.instagram.com/${handle}/`, title, snippet });
    } else if (citesPhone && instagramShortcode(r.url)) {
      out.push({ handle: null, url: r.url, title, snippet });
    }
    if (out.length >= max) break;
  }
  return out;
}

export type IgProfile = {
  username?: string;
  full_name?: string;
  biography?: string;
  business_email?: string;
  email?: string | null;
  emails?: string[];
  emailSource?: string | null;
  business_phone_number?: string;
  phone?: string | null;
  phones?: string[];
  business_address_json?: string;
};

export function judgeInstagram(lead: LeadContact, cand: IgCandidate, profile: IgProfile | null): { confidence: Confidence | null; proof: string | null } {
  const bio = profile?.biography ?? '';
  const leadPhone = phoneKey(lead.phone);
  const phones = new Set([
    ...[profile?.business_phone_number, profile?.phone, ...(profile?.phones ?? [])].map(phoneKey),
    ...phonesIn(bio),
    ...phonesIn(cand.snippet),
  ]);
  if (leadPhone && phones.has(leadPhone)) return { confidence: 'haute', proof: 'téléphone' };
  if (compareAddress(lead.address, `${profile?.business_address_json ?? ''} ${bio} ${cand.snippet}`) === 'exacte') {
    return { confidence: 'haute', proof: 'adresse' };
  }
  // Sans téléphone ni adresse, un mot commun ne suffit pas (« Styles Et Couleurs » ≠ « Sorain
  // Styles », « Le Salon de Sophie » ≠ « Le Boudoir de Sophie ») : le nom du compte doit
  // contenir le nom complet du salon, et le compte citer la ville.
  const identity = `${cand.handle ?? profile?.username ?? ''} ${profile?.full_name ?? ''} ${cand.title}`;
  const context = fold(`${identity} ${bio} ${cand.snippet}`);
  const city = fold(lead.city ?? 'bordeaux');
  if (containsFullName(lead.name, identity) && context.includes(city)) return { confidence: 'moyenne', proof: 'nom complet et ville' };
  return { confidence: null, proof: null };
}

export function containsFullName(leadName: string, text: string): boolean {
  const full = compact(coreName(leadName));
  const glued = [text, ...text.split(/[\s@()·|]+/)].map(compact);
  return full.length >= 6 ? glued.some(t => t.includes(full)) : glued.some(t => t === full);
}

const isEmail = (s: string | null | undefined): s is string => typeof s === 'string' && new RegExp(`^${EMAIL_RE.source}$`).test(s.trim());

export function instagramEmail(profile: IgProfile | null, snippet: string): { email: string; source: string } | null {
  // Les adresses mal formées (accents, espaces) sont écartées : elles rebondiraient.
  const fromProfile = [profile?.business_email, profile?.email, ...(profile?.emails ?? [])].find(isEmail);
  if (fromProfile) return { email: fromProfile.trim().toLowerCase(), source: profile?.emailSource === 'contact_button' ? 'instagram_contact' : 'instagram_bio' };
  const inBio = emailIn(profile?.biography);
  if (inBio) return { email: inBio, source: 'instagram_bio' };
  const inSnippet = emailIn(snippet); // bio gardée en cache par Google
  return inSnippet ? { email: inSnippet, source: 'google_extrait' } : null;
}

// --- LinkedIn ----------------------------------------------------------------

const TRADE_WORDS = new Set([
  'coiffure', 'coiffeur', 'coiffeuse', 'beaute', 'esthetique', 'estheticienne', 'institut', 'ongle', 'ongles', 'onglerie',
  'barbier', 'barber', 'salon', 'cils', 'massage', 'spa', 'prothesiste', 'manucure', 'hair', 'nails', 'beauty', 'ramoneur', 'ramonage',
]);

export function judgeLinkedIn(lead: LeadContact, person: { firstName: string; lastName: string }, r: Organic): Confidence | null {
  if (!r.url || !/linkedin\.com\/in\//.test(r.url)) return null;
  const title = fold(r.title ?? '');
  if (!title.includes(fold(person.firstName)) || !title.includes(fold(person.lastName))) return null;
  const info = r.personalInfo ?? {};
  const text = `${r.title ?? ''} ${r.description ?? ''} ${info.location ?? ''} ${info.jobTitle ?? ''} ${info.companyName ?? ''}`;
  const words = new Set(fold(text).split(' '));
  // Le nom de la personne ne prouve rien : il est dans le titre par construction.
  if (nameRelated(lead.name, text, [person.firstName, person.lastName])) return 'haute';
  const city = fold(lead.city ?? 'bordeaux');
  const local = fold(text).includes(city) || words.has('gironde');
  const trade = [...TRADE_WORDS].some(w => words.has(w));
  return local && trade ? 'moyenne' : null;
}
