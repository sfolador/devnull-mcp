import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPayload,
  commitIdFromReference,
  DevNullError,
  extractSignature,
  keyId,
  sanitize,
  uniqueKeyIds,
  validateBaseUrl,
  validateMessage,
  validateReplyTo,
  validateUsername,
} from '../src/protocol.js';

describe('keyId', () => {
  it('keeps type and blob, drops the comment', () => {
    assert.equal(keyId('ssh-ed25519 AAAAC3Nza me@host'), 'ssh-ed25519 AAAAC3Nza');
    assert.equal(keyId('  ssh-rsa AAAAB3Nza  \n'), 'ssh-rsa AAAAB3Nza');
  });
  it('rejects other key types and garbage', () => {
    assert.equal(keyId('ecdsa-sha2-nistp256 AAAA x'), null);
    assert.equal(keyId('sk-ssh-ed25519@openssh.com AAAA'), null);
    assert.equal(keyId('ssh-ed25519'), null);
    assert.equal(keyId('ssh-ed25519 not*base64'), null);
    assert.equal(keyId(''), null);
  });
});

describe('uniqueKeyIds', () => {
  it('deduplicates in first-seen order and skips invalid lines', () => {
    assert.deepEqual(uniqueKeyIds(['ssh-rsa B b', 'ssh-ed25519 A a', 'junk', 'ssh-rsa B other-comment']), [
      'ssh-rsa B',
      'ssh-ed25519 A',
    ]);
  });
});

describe('validateReplyTo', () => {
  it('accepts empty, hashes and links', () => {
    assert.equal(validateReplyTo(undefined), '');
    assert.equal(validateReplyTo('  '), '');
    assert.equal(validateReplyTo('0be0130'), '0be0130');
    assert.equal(validateReplyTo('https://dev-null.sh/@nuno/commits/01a1-2'), 'https://dev-null.sh/@nuno/commits/01a1-2');
  });
  it('rejects anything that could break the payload line', () => {
    assert.throws(() => validateReplyTo('abc\ndef'), DevNullError);
    assert.throws(() => validateReplyTo('a b'), DevNullError);
    assert.throws(() => validateReplyTo('<script>'), DevNullError);
  });
});

describe('validateMessage', () => {
  it('returns the message untouched when it is in range', () => {
    assert.equal(validateMessage('Hello world!'), 'Hello world!');
  });
  it('enforces the server limits', () => {
    assert.throws(() => validateMessage(''), /empty commit message/);
    assert.throws(() => validateMessage('   '), /empty commit message/);
    assert.throws(() => validateMessage('hi'), /at least 3/);
    assert.throws(() => validateMessage('x'.repeat(4001)), /at most 4000/);
    assert.equal(validateMessage('x'.repeat(4000)).length, 4000);
  });
});

describe('buildPayload', () => {
  it('matches the script: four newline-separated lines, no trailing newline', () => {
    const payload = buildPayload({ timestamp: 1700000000, nonce: 'a'.repeat(32), replyTo: '', message: 'Hi\nthere' });
    assert.equal(payload, `1700000000\n${'a'.repeat(32)}\n\nHi\nthere`);
  });
  it('rejects malformed parts', () => {
    assert.throws(() => buildPayload({ timestamp: 1.5, nonce: 'a'.repeat(32), replyTo: '', message: 'x' }), DevNullError);
    assert.throws(() => buildPayload({ timestamp: 1, nonce: 'A'.repeat(32), replyTo: '', message: 'x' }), DevNullError);
    assert.throws(() => buildPayload({ timestamp: 1, nonce: 'a'.repeat(31), replyTo: '', message: 'x' }), DevNullError);
    assert.throws(() => buildPayload({ timestamp: 1, nonce: 'a'.repeat(32), replyTo: 'a\nb', message: 'x' }), DevNullError);
  });
});

describe('extractSignature', () => {
  it('strips the armor and joins the lines', () => {
    const file = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\nAAAA\n-----END SSH SIGNATURE-----\n';
    assert.equal(extractSignature(file), 'U1NIU0lHAAAA');
  });
  it('refuses non-base64 output', () => {
    assert.throws(() => extractSignature(''), DevNullError);
    assert.throws(() => extractSignature('-----BEGIN-----\nnot base64!\n-----END-----'), DevNullError);
  });
});

describe('validateBaseUrl', () => {
  it('defaults to dev-null.sh and strips trailing slashes', () => {
    assert.equal(validateBaseUrl(undefined), 'https://dev-null.sh');
    assert.equal(validateBaseUrl('https://example.test///'), 'https://example.test');
  });
  it('allows plain http only for localhost', () => {
    assert.equal(validateBaseUrl('http://localhost:8000'), 'http://localhost:8000');
    assert.equal(validateBaseUrl('http://127.0.0.1'), 'http://127.0.0.1');
    assert.throws(() => validateBaseUrl('http://dev-null.sh'), DevNullError);
    assert.throws(() => validateBaseUrl('ftp://x'), DevNullError);
    assert.throws(() => validateBaseUrl('nope'), DevNullError);
  });
});

describe('validateUsername', () => {
  it('accepts GitHub usernames with or without @', () => {
    assert.equal(validateUsername('@sfolador'), 'sfolador');
    assert.equal(validateUsername('nuno-maduro'), 'nuno-maduro');
  });
  it('rejects path tricks', () => {
    assert.throws(() => validateUsername('../admin'), DevNullError);
    assert.throws(() => validateUsername('a b'), DevNullError);
    assert.throws(() => validateUsername(''), DevNullError);
  });
});

describe('commitIdFromReference', () => {
  const id = '01a1461d-a767-73f5-91f5-0a7cdecea096';
  it('accepts a UUID or a commit link', () => {
    assert.equal(commitIdFromReference(id), id);
    assert.equal(commitIdFromReference(id.toUpperCase()), id);
    assert.equal(commitIdFromReference(`https://dev-null.sh/@sfolador/commits/${id}`), id);
  });
  it('rejects short hashes (the public API wants the UUID)', () => {
    assert.throws(() => commitIdFromReference('ecea096'), DevNullError);
  });
});

describe('sanitize', () => {
  it('removes control characters but keeps newlines and tabs', () => {
    assert.equal(sanitize('a\u001b[31mb\n\tc\u007f'), 'a[31mb\n\tc');
  });
});
