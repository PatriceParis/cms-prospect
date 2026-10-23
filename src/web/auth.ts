import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Accès partagé par un seul mot de passe (CRM_PASSWORD). La clé de signature des
// sessions dérive du mot de passe : le changer déconnecte tout le monde.
export const COOKIE_NAME = 'crm_session';
const MAX_AGE_S = 30 * 24 * 3600;

const signingKey = (password: string) => createHmac('sha256', password).update('cms-prospect/session/v1').digest();
const sign = (payload: string, password: string) => createHmac('sha256', signingKey(password)).update(payload).digest('base64url');

export function checkPassword(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createSession(password: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: now + MAX_AGE_S * 1000 })).toString('base64url');
  return `${payload}.${sign(payload, password)}`;
}

export function verifySession(token: string | null, password: string, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, sig, ...rest] = token.split('.');
  if (!payload || !sig || rest.length) return false;
  const expected = Buffer.from(sign(payload, password));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const { e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e?: unknown };
    return typeof e === 'number' && e >= now;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | undefined, name = COOKIE_NAME): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}
