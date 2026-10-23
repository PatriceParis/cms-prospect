import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPassword, cleanName, createSession, readCookie, verifySession } from '../src/web/auth.ts';

const SECRET = 'secret-de-test';

describe('session', () => {
  it('un jeton signé redonne le prénom', () => {
    assert.deepEqual(verifySession(createSession('Mariem', SECRET), SECRET), { name: 'Mariem' });
  });

  it('refuse un jeton altéré, signé avec un autre mot de passe ou expiré', () => {
    const token = createSession('Mariem', SECRET);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ n: 'Intrus', e: Date.now() + 1e9 })).toString('base64url');
    assert.equal(verifySession(`${forged}.${sig}`, SECRET), null);
    assert.equal(verifySession(`${payload}.${sig}x`, SECRET), null);
    assert.equal(verifySession(token, 'autre-mot-de-passe'), null);
    assert.equal(verifySession(token, SECRET, Date.now() + 31 * 24 * 3600 * 1000), null);
    assert.equal(verifySession(null, SECRET), null);
    assert.equal(verifySession('pas-un-jeton', SECRET), null);
  });
});

describe('checkPassword', () => {
  it('compare exactement', () => {
    assert.equal(checkPassword(SECRET, SECRET), true);
    assert.equal(checkPassword(`${SECRET} `, SECRET), false);
    assert.equal(checkPassword('', SECRET), false);
  });
});

describe('cleanName / readCookie', () => {
  it('nettoie le prénom et lit le cookie', () => {
    assert.equal(cleanName('  Patrice \u0000 '), 'Patrice');
    assert.equal(cleanName('   '), null);
    assert.equal(cleanName(42), null);
    assert.equal(readCookie('a=1; crm_session=abc.def; b=2'), 'abc.def');
    assert.equal(readCookie(undefined), null);
  });
});
