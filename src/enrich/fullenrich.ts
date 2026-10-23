// Client FullEnrich (API v2) : e-mails pro et perso à partir de prénom + nom + entreprise.
// Facturé au résultat : 1 crédit l'e-mail pro, 3 l'e-mail perso. Les téléphones (10 crédits)
// ne sont jamais demandés : la fiche Google les donne déjà.
const API = 'https://app.fullenrich.com/api/v2';
const POLL_MS = 5000;
const MAX_CREDITS_PER_CONTACT = 4;
const BATCH = 100;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function key(): string {
  const k = process.env.FULLENRICH_API_KEY;
  if (!k) throw new Error('FULLENRICH_API_KEY manquante (.env)');
  return k;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`FullEnrich ${path} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export type FullEnrichInput = { placeId: string; firstName: string; lastName: string; companyName: string };
type Email = { email: string; status: string };
export type FullEnrichResult = { placeId: string; workEmail: Email | null; personalEmail: Email | null; linkedinUrl: string | null };

type ResultItem = {
  custom?: { place_id?: string };
  contact_info?: { most_probable_work_email?: Email | null; most_probable_personal_email?: Email | null };
  profile?: { social_profiles?: { professional_network?: { url?: string } } };
};

export async function creditBalance(): Promise<number> {
  return (await call<{ balance: number }>('/account/credits')).balance;
}

export async function enrichContacts(contacts: FullEnrichInput[], label: string): Promise<{ results: FullEnrichResult[]; credits: number }> {
  if (!contacts.length) return { results: [], credits: 0 };
  const worstCase = contacts.length * MAX_CREDITS_PER_CONTACT;
  const balance = await creditBalance();
  if (balance < worstCase) throw new Error(`FullEnrich : ${balance} crédits disponibles, ${worstCase} nécessaires au pire cas`);

  const results: FullEnrichResult[] = [];
  let credits = 0;
  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH);
    const { enrichment_id } = await call<{ enrichment_id: string }>('/contact/enrich/bulk', {
      method: 'POST',
      body: JSON.stringify({
        name: label,
        data: batch.map(c => ({
          first_name: c.firstName,
          last_name: c.lastName,
          company_name: c.companyName,
          enrich_fields: ['contact.work_emails', 'contact.personal_emails'],
          custom: { place_id: c.placeId },
        })),
      }),
    });
    let body: { status: string; cost?: { credits?: number }; data?: ResultItem[] };
    do {
      await sleep(POLL_MS);
      body = await call(`/contact/enrich/bulk/${enrichment_id}`);
    } while (body.status === 'CREATED' || body.status === 'IN_PROGRESS');
    if (body.status !== 'FINISHED') throw new Error(`FullEnrich : enrichissement ${enrichment_id} terminé en ${body.status}`);
    credits += body.cost?.credits ?? 0;
    for (const d of body.data ?? []) {
      if (!d.custom?.place_id) continue;
      results.push({
        placeId: d.custom.place_id,
        workEmail: d.contact_info?.most_probable_work_email ?? null,
        personalEmail: d.contact_info?.most_probable_personal_email ?? null,
        linkedinUrl: d.profile?.social_profiles?.professional_network?.url ?? null,
      });
    }
  }
  return { results, credits };
}
