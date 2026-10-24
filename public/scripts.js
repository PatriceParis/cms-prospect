// Scripts d'appel et messages personnalisés par lead. Module pur (aucun accès au DOM),
// testé côté Node. Modifier un texte ici est une décision commerciale : elle passe par
// un commit.

// Exemple de site vitrine par secteur, montré quand le prospect n'a pas encore sa propre
// maquette (API Fold) : la page montre un salon fictif, présentée comme un exemple.
export const PREVIEW_LINKS = {
  Coiffeur: 'https://test.fold-medias.com/admin/clients/45/preview/',
};

export const OFFER = {
  presence: '29 € par mois',
  visibilite: '39 € par mois',
};

export const SETTINGS_KEY = 'crm-expediteur-v1';

const SECTOR = {
  Coiffeur: { place: 'salon', the: 'le salon', kind: 'un salon de coiffure', search: 'coiffeur' },
  'Institut de beauté': { place: 'institut', the: 'l’institut', kind: 'un institut de beauté', search: 'institut de beauté' },
  Ramoneur: { place: 'entreprise', the: 'l’entreprise', kind: 'une entreprise de ramonage', search: 'ramoneur' },
};
const DEFAULT_SECTOR = { place: 'établissement', the: 'l’établissement', kind: 'un commerce de proximité', search: 'commerce' };

// « Tendance Vintage - Salon de coiffure » → « Tendance Vintage » ; on écarte les segments
// purement descriptifs (« Salon de beauté », « coiffeur afro »).
const GENERIC = /^(salon( de (coiffure|beaut[ée]))?|institut( de beaut[ée])?|coiffeur.*|coiffure.*|barbier.*|bien[- ]être.*|bordeaux.*|nail art.*)$/i;
export function salonName(name) {
  const parts = String(name).split(/\s+[|–—-]\s+|\s*\|\s*|\s*,\s*/).map(s => s.trim()).filter(Boolean);
  return parts.find(p => !GENERIC.test(p)) ?? parts[0] ?? String(name);
}

const frNumber = n => String(n).replace('.', ',');

// « de » + ville : « du Bouscat », « des Mureaux », « d’Eysines », « de Bordeaux ».
export function ofCity(city) {
  const c = String(city).trim();
  if (/^le\s/i.test(c)) return `du ${c.slice(3)}`;
  if (/^les\s/i.test(c)) return `des ${c.slice(4)}`;
  if (/^[aeiouyhéèêàâîôû]/i.test(c)) return `d’${c}`;
  return `de ${c}`;
}

function reviewsHook(lead) {
  const n = Number(lead.reviews_count) || 0;
  const r = Number(lead.rating) || 0;
  if (n >= 30 && r >= 4.5) return `vos ${n} avis à ${frNumber(r)}/5 sur Google`;
  if (r >= 4.5 && n > 0) return `votre note de ${frNumber(r)}/5 sur Google`;
  if (n > 0) return `vos ${n} avis sur Google`;
  return 'votre fiche Google';
}

function addBusinessDays(n, from) {
  const d = new Date(from);
  while (n > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n--;
  }
  return d;
}
const weekday = d => d.toLocaleDateString('fr-FR', { weekday: 'long' });

// Maquette du prospect tant qu'elle est valable (30 jours, prolongeable), sinon l'exemple du secteur.
export const ownPreview = (lead, now = new Date()) =>
  Boolean(lead.maquette_link) && !(lead.maquette_expires_at && new Date(lead.maquette_expires_at) < now);

export function previewUrl(lead, now = new Date()) {
  return ownPreview(lead, now) ? lead.maquette_link : (PREVIEW_LINKS[lead.search_sector] ?? null);
}

export function missingSettings(settings) {
  return ['sender', 'brand'].filter(k => !String(settings?.[k] ?? '').trim());
}

// Adresse dont le domaine ne reçoit pas de courrier (vérification DNS de la cascade) :
// jamais proposée comme canal d'envoi.
export const emailUsable = lead => Boolean(lead.email) && lead.email_check !== 'sans_mx' && lead.email_check !== 'inexistant';

// Les relances concernent un lead déjà contacté sans réponse.
export const isFollowUp = lead => lead.crm_status === 'CONTACTE' || lead.crm_status === 'PAS_DE_REP';

export function buildScripts(lead, settings, { now = new Date() } = {}) {
  const missing = missingSettings(settings);
  const sender = String(settings?.sender ?? '').trim();
  const brand = String(settings?.brand ?? '').trim();
  const first = String(lead.contact_first_name ?? '').trim();
  const salon = salonName(lead.name);
  const sector = SECTOR[lead.search_sector] ?? DEFAULT_SECTOR;
  const city = lead.city || 'Bordeaux';
  const hello = first ? `Bonjour ${first}` : 'Bonjour';
  const hook = reviewsHook(lead);
  const link = previewUrl(lead, now);
  const own = ownPreview(lead, now); // maquette préparée pour ce prospect, pas un exemple
  const unclaimed = !lead.claimed;
  const callBack = weekday(addBusinessDays(2, now));
  const followUp = isFollowUp(lead);
  const optOut = 'Si ce n’est pas le moment, dites-le-moi simplement et je ne vous relancerai pas.';
  // Nom complet pour l'appel : il vient du registre, la personne qui décroche ne connaît
  // pas forcément le prénom seul. Le tutoiement du prénom reste réservé aux DM.
  const fullName = [lead.contact_first_name, lead.contact_last_name].map(s => String(s ?? '').trim()).filter(Boolean).join(' ');
  // Canal réel pour envoyer l'exemple : pas de SMS ni de WhatsApp vers un fixe.
  const via = lead.phone_kind === 'mobile' ? 'par SMS ou WhatsApp'
    : lead.instagram ? 'en message sur Instagram'
    : emailUsable(lead) ? 'par e-mail'
    : null;

  // --- Appel -------------------------------------------------------------------------
  const call = {
    steps: [
      {
        title: 'Ouverture',
        text: `Bonjour, je suis bien chez ${salon} ? Je souhaiterais parler à ${fullName ? `${fullName} ou à la personne qui gère ${sector.the}` : `la personne qui gère ${sector.the}`}, s’il vous plaît.`,
      },
      {
        title: 'Présentation (moins de 20 secondes)',
        text: `Je suis ${sender} de ${brand}. Je vous appelle parce que j’ai vu ${hook} : bravo. Je vois que vous n’avez pas de site internet. On en crée pour les ${sector.place}s ${ofCity(city)}, déjà remplis à partir de votre fiche Google. Je vous prends deux minutes ?`,
      },
      {
        title: 'Constat',
        text: unclaimed
          ? `Votre fiche Google n’est pas encore revendiquée : vous ne pouvez pas répondre aux avis en tant que propriétaire, et n’importe qui peut y proposer des modifications. On vous guide pour la récupérer, c’est gratuit.`
          : `Aujourd’hui, quand quelqu’un cherche « ${sector.search} ${city} », il tombe sur votre fiche, mais pas sur un site qui présente vos prestations et vos photos.`,
      },
      {
        title: 'Proposition',
        text: !link
          ? `Je peux vous préparer un aperçu de votre site à partir de votre fiche Google, sans engagement. Je vous rappelle ${callBack} pour vous le montrer ?`
          : own
            ? via
              ? `J’ai déjà préparé un aperçu de votre site avec les informations de votre fiche Google. Je vous l’envoie ${via}, vous regardez tranquillement, et je vous rappelle ${callBack} pour avoir votre avis. Ça vous va ?`
              : `J’ai déjà préparé un aperçu de votre site avec les informations de votre fiche Google. Je vous l’envoie par e-mail : à quelle adresse ? Je vous rappelle ${callBack} pour avoir votre avis. (Note l’adresse dans la fiche.)`
            : via
              ? `Je vous envoie ${via} un exemple de site pour ${sector.kind}, vous regardez tranquillement, et je vous rappelle ${callBack} pour avoir votre avis. Ça vous va ?`
              : `Je peux vous envoyer par e-mail un exemple de site pour ${sector.kind} : à quelle adresse ? Je vous rappelle ${callBack} pour avoir votre avis. (Note l’adresse dans la fiche.)`,
      },
      {
        title: 'Si on vous demande le prix',
        text: `${OFFER.presence} TTC, sans engagement et sans frais de mise en ligne. ${OFFER.visibilite} TTC avec, en plus, l’optimisation de votre fiche Google chaque semaine.`,
      },
    ],
    objections: [
      { q: '« Je n’ai pas le temps »', a: `Je comprends, c’est pour ça qu’on remplit tout à partir de votre fiche Google. Je vous envoie ${own ? 'l’aperçu de votre site' : 'l’exemple'} ${via ?? 'par e-mail (à quelle adresse ?)'}, trente secondes à regarder, et je vous rappelle ${callBack}.` },
      { q: '« J’ai déjà Instagram / Planity »', a: `C’est très bien pour vos clients actuels et la réservation. Le site, c’est ce que Google met en avant quand quelqu’un cherche « ${sector.search} ${city} » sans vous connaître.` },
      { q: '« C’est trop cher »', a: `C’est ${OFFER.presence}, sans engagement : si ça ne vous apporte rien, vous arrêtez quand vous voulez.` },
      { q: '« Envoyez-moi un mail »', a: 'Avec plaisir. À quelle adresse ? (Note-la dans la fiche.)' },
      { q: '« Ça ne m’intéresse pas »', a: 'Très bien, merci de m’avoir répondu. Je note de ne pas vous rappeler. (Résultat : Pas intéressé. Si la personne demande à ne plus être contactée : Ne plus contacter.)' },
    ],
    voicemail: `Bonjour, ${sender} de ${brand}. Je vous appelais au sujet d’un site internet pour ${salon}. ${via ? `Je vous envoie ${own ? 'l’aperçu de votre site, déjà préparé,' : link ? 'un exemple' : 'quelques informations'} ${via} et je vous rappelle ${callBack}.` : `Je vous rappelle ${callBack}.`} Bonne journée !`,
  };

  // --- Messages (Instagram, WhatsApp) ------------------------------------------------------
  const linkLine = own
    ? `J’ai préparé un aperçu de votre site à partir de votre fiche Google : ${link}`
    : link ? `Voici un exemple de site pour ${sector.kind} : ${link}` : 'Je peux vous préparer un aperçu à partir de votre fiche Google, gratuitement.';
  const offerLine = `On crée des sites pour les ${sector.place}s ${ofCity(city)}, déjà remplis à partir de votre fiche Google : ${OFFER.presence}, sans engagement.`;
  const unclaimedLine = unclaimed ? 'Au passage, votre fiche Google n’est pas encore revendiquée : on peut vous aider à la récupérer.' : null;

  const dmFirst = (intro) => [
    `${hello},`,
    `Je suis ${sender}, de ${brand}. ${intro}J’ai découvert ${salon} et ${hook} : bravo !`,
    `Je vois que vous n’avez pas encore de site. ${offerLine}`,
    linkLine,
    unclaimedLine,
    own ? `Dites-moi ce que vous en pensez : on l’ajuste ensemble avant la mise en ligne. ${optOut}` : `Ça vous dirait que je vous prépare le vôtre ? ${optOut}`,
    sender,
  ].filter(Boolean).join('\n\n');

  const dmFollowUp = [
    `${hello},`,
    `Je reviens vers vous au sujet du site pour ${salon}. ${own ? `Vous avez pu jeter un œil à l’aperçu de votre site ? ${link}` : link ? `Vous avez pu jeter un œil à l’exemple ? ${link}` : 'Je peux toujours vous préparer un aperçu à partir de votre fiche Google.'}`,
    own ? 'On peut l’ajuster avec vos photos et vos prestations, sans engagement.' : 'Je peux vous préparer une version avec vos photos, vos horaires et vos prestations, sans engagement.',
    'Et si ce n’est pas pour vous, un simple « non merci » me suffit.',
    sender,
  ].join('\n\n');

  const instagram = followUp ? dmFollowUp : dmFirst('');
  const whatsapp = followUp ? dmFollowUp : dmFirst('Votre numéro figure sur votre fiche Google. ');

  // --- E-mail (envoyé depuis la fiche, via Resend) ------------------------------------------
  // Règles de prospection à froid : texte brut, 60 à 90 mots, un signal propre au salon en
  // ouverture, une seule question pour finir. Même objet pour la relance (pas de faux « Re : »),
  // angle différent : la 1re parle de la maquette, la relance des nouveaux clients.
  // La mention de désinscription est ajoutée par le serveur à l'envoi : elle ne s'édite pas.
  const recommended = (Number(lead.reviews_count) || 0) >= 10 && (Number(lead.rating) || 0) >= 4.5;
  const signal = recommended
    ? `${hook.charAt(0).toUpperCase()}${hook.slice(1)} ${hook.startsWith('vos') ? 'le montrent' : 'le montre'} : vos clients vous recommandent. Mais quand quelqu’un cherche « ${sector.search} ${city} » sans vous connaître, il ne trouve pas de site à votre nom.`
    : `Quand quelqu’un cherche « ${sector.search} ${city} », il tombe sur votre fiche Google, mais pas sur un site à votre nom.`;
  const emailBody = followUp
    ? [
        `${hello},`,
        `Je reviens vers vous au sujet du site ${ofCity(salon)}.${link ? ` ${own ? 'L’aperçu' : 'L’exemple'} est toujours là : ${link}` : ''}`,
        `Un site à votre nom, c’est ce que Google montre en premier à ceux qui cherchent « ${sector.search} ${city} » : de nouveaux clients, sans rien changer à votre organisation.`,
        'Est-ce que ce serait utile pour vous, ou ce n’est pas le moment ?',
      ]
    : [
        `${hello},`,
        signal,
        own
          ? `J’ai donc préparé un aperçu de votre site, à partir de votre fiche Google : ${link}`
          : link ? `Voici un exemple de site pour ${sector.kind} : ${link}` : 'Je peux vous préparer un aperçu de votre site à partir de votre fiche Google, gratuitement.',
        `${own ? 'Si l’aperçu vous plaît, votre site peut être en ligne cette semaine' : 'Le vôtre peut être en ligne cette semaine'} : ${OFFER.presence}, sans engagement et sans frais de mise en ligne.`,
        own ? 'Je vous laisse y jeter un œil ?' : 'Je vous prépare le vôtre ?',
      ];
  const email = {
    subject: `Le site ${ofCity(salon)}`,
    body: [
      ...emailBody,
      `${sender}\n${brand}`,
      !followUp && unclaimed ? 'P.S. Votre fiche Google n’est pas encore revendiquée : on peut vous aider à la récupérer, gratuitement.' : null,
    ].filter(Boolean).join('\n\n'),
  };

  return { missing, followUp, link, call, instagram, whatsapp, email };
}
