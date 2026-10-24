import { createHash } from 'node:crypto';

// Empreinte de la base visée, calculée sur le nom d'hôte seul (insensible aux espaces,
// au schéma ou à une barre finale) : compare un poste et la production sans exposer
// l'adresse. Module à part : la fonction Vercel ne doit pas charger le client libSQL natif.
export function dbFingerprint(url: string | undefined): string | null {
  if (!url) return null;
  let host = url.trim();
  try {
    host = new URL(host).hostname || host;
  } catch {
    // adresse non analysable : empreinte de la valeur brute
  }
  return createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 8);
}
