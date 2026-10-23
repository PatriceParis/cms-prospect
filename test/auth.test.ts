import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPassword, createSession, readCookie, verifySession } from '../src/web/auth.ts';

const SECRET = 'secret-de-test';

describe('session', () => {
  it('un jeton signé avec le bon mot de passe est valide', () => {
    assert.equal(verifySession(createSession(SECRET), SECRET), true);
  });

  it('refuse un jeton altéré, signé avec un autre mot de passe ou expiré', () => {
    const token = createSession(SECRET);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ e: Date.now() + 1e12 })).toString('base64url');
    assert.equal(verifySession(`${forged}.${sig}`, SECRET), false);
    assert.equal(verifySession(`${payload}.${sig}x`, SECRET), false);
    assert.equal(verifySession(token, 'autre-mot-de-passe'), false);
    assert.equal(verifySession(token, SECRET, Date.now() + 31 * 24 * 3600 * 1000), false);
    assert.equal(verifySession(null, SECRET), false);
    assert.equal(verifySession('pas-un-jeton', SECRET), false);
  });
});

describe('checkPassword', () => {
  it('compare exactement', () => {
    assert.equal(checkPassword(SECRET, SECRET), true);
    assert.equal(checkPassword(`${SECRET} `, SECRET), false);
    assert.equal(checkPassword('', SECRET), false);
  });
});

describe('readCookie', () => {
  it('lit le cookie de session', () => {
    assert.equal(readCookie('a=1; crm_session=abc.def; b=2'), 'abc.def');
    assert.equal(readCookie(undefined), null);
  });
});
