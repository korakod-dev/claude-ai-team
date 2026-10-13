'use strict';
/**
 * normalize-redaction.test.js - the stderr of a failed Bash call lands in `error` (PostToolUseFailure), so it can carry
 * secrets. One test per pattern family (Bearer, AWS, GitHub / vendor tokens, JWT, generic key=value, URL credentials,
 * secret flags, long hex / base64 blobs), plus a control test that normal error text is NOT over-redacted, and the
 * 160-char cap that still applies after redaction. Complements test/normalize.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, MAX_ERROR } = require('../lib/normalize');

const NOW = new Date('2026-10-13T09:00:00.000Z');
/** What a failed Bash call with this stderr text stores in `error`. */
const errorOf = (text) => normalize({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: text }, NOW).error;
/** Assert that none of the secret fragments survives in the stored error. */
function assertGone(text, secrets) {
  const out = errorOf(text);
  for (const secret of secrets) assert.equal(out.includes(secret), false, `"${secret}" leaked: ${out}`);
  return out;
}

test('Bearer tokens and JWTs are redacted (the whole token, claims included)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assertGone(`curl: (22) The requested URL returned error: 401 Bearer abc123.def-456_x`, ['abc123.def-456_x']);
  assertGone(`header Authorization: Bearer ${jwt}`, [jwt, 'eyJzdWIi', 'SflKx']);
  const bare = assertGone(`token in response: ${jwt} rejected`, [jwt, 'eyJzdWIi', 'SflKx']);
  assert.match(bare, /rejected$/, 'text after the token is kept');
});

test('AWS access key IDs and secret keys are redacted', () => {
  assertGone('InvalidClientTokenId: AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE']);
  assertGone('temporary ASIAIOSFODNN7EXAMPLE rejected', ['ASIAIOSFODNN7EXAMPLE']);
  assertGone('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI', 'bPxRfiCYEXAMPLEKEY']);
});

test('GitHub tokens (ghp_ gho_ ghu_ ghs_ ghr_ github_pat_) and other vendor tokens are redacted', () => {
  const tokens = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghu_abcdefghijkl12345678',
    'ghs_abcdefghijkl12345678',
    'ghr_abcdefghijkl12345678',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuv_WXYZ0123',
    'glpat-abcdefghij1234567890',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'xoxb-1234567890-abcdefghij',
    'sk_live_abcdefghijklmnopqrstuv',
  ];
  for (const t of tokens) {
    const out = assertGone(`remote: Invalid token ${t} for user`, [t, t.slice(6)]);
    assert.match(out, /^remote: Invalid token .* for user$/, `surrounding text kept: ${out}`);
  }
});

test('generic key=value secrets are redacted: env style, flags, JSON, query strings', () => {
  assertGone('export DB_PASSWORD=hunter2hunter2', ['hunter2']);
  assertGone('API_KEY=abc123xyz789', ['abc123xyz789']);
  assertGone('client_secret: s3cr3tValue', ['s3cr3tValue']);
  assertGone('{"access_token":"tok-value-1","user":"bob"}', ['tok-value-1']);
  assertGone('curl "https://api.example.com/v1/items?token=qwerty123&page=2"', ['qwerty123']);
  assertGone('curl https://maps.example.com/api?key=AbC123dEf456&q=1', ['AbC123dEf456']);
  assertGone('mysql --password hunter2 -h db.local', ['hunter2']);
  assertGone('deploy --api-key abc123xyz --env prod', ['abc123xyz']);
  assertGone('login --token=abc123xyz', ['abc123xyz']);
  // Context around the secret stays readable
  assert.match(errorOf('mysql --password hunter2 -h db.local'), /^mysql --password \[REDACTED\] -h db\.local$/);
  assert.match(errorOf('deploy --api-key abc123xyz --env prod'), /--env prod$/);
});

test('URLs with credentials are redacted, host and path are kept', () => {
  assert.equal(errorOf('fatal: unable to access https://bob:hunter2@github.com/x/y.git/'), 'fatal: unable to access https://[REDACTED]@github.com/x/y.git/');
  // A password that itself contains "@"
  assertGone('git clone https://bob:p@ssw0rd@example.com/repo.git', ['p@ssw0rd', 'ssw0rd']);
  assert.match(errorOf('git clone https://bob:p@ssw0rd@example.com/repo.git'), /@example\.com\/repo\.git$/);
  // Token as the user part
  assertGone('clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', ['ghp_abcdefghijklmnopqrstuvwxyz0123456789']);
  // ssh/ftp schemes too
  assertGone('ftp://admin:letmein99@files.local/pub', ['letmein99']);
});

test('long hex and base64 blobs are redacted (padding, + and / included)', () => {
  const hex = 'deadbeefdeadbeefdeadbeefdeadbeef0123456789abcdef';
  assertGone(`sha256 mismatch ${hex}`, [hex.slice(0, 32)]);
  assertGone('md5 0123456789abcdef0123456789abcdef', ['0123456789abcdef0123']);
  const b64Pad = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MA==';
  assertGone(`decoded blob ${b64Pad} end`, [b64Pad, 'QUJDREVGR0hJ', 'Nzg5MA']);
  assert.match(errorOf(`decoded blob ${b64Pad} end`), /^decoded blob \[REDACTED_TOKEN\] end$/);
  const b64Mixed = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz/NDU2Nzg5MA+xyz';
  assertGone(`key material ${b64Mixed}`, ['QUJDREVGR0hJ', 'NDU2Nzg5MA']);
});

test('normal error text is NOT over-redacted', () => {
  const samples = [
    'ENOENT: no such file or directory, open \'/src/lib/normalize.js\'',
    'Error: command failed with exit code 1: npm test (2 failed, 617 passed)',
    'fatal: not a git repository (or any of the parent directories): .git',
    'commit e76bcf6 and 68400b2 failed to apply',
    'TypeError: Cannot read properties of undefined (reading \'map\') at Object.<anonymous> (/a/b/c.js:10:5)',
    'http://localhost:3000/api failed, retry http://127.0.0.1:8080/x',
    'Error: Cannot find module ./some/relative/path/to/file/deeply/nested/index',
    '/usr/local/lib/node_modules/lodash/lib/index.js:10',
    'npm-check-updates and run-all are not installed; my-key=3 is a short thing',
    'test passed: bypass=true, compass north',
    'Permission denied (publickey). user@example is not an email',
    'zsh: command not found: foo --no-verify --force',
  ];
  for (const text of samples) {
    const out = errorOf(text);
    assert.equal(out, text, `over-redacted:\n  in:  ${text}\n  out: ${out}`);
  }
});

test('the 160-char cap still applies after redaction, and a secret is never half-readable at the cap', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const out = errorOf(`${'x '.repeat(70)}${secret} tail`);
  assert.ok(out.length <= MAX_ERROR + 3, `length ${out.length}`);
  assert.equal(out.includes('ghp_'), false);
  // A secret right at the cap boundary
  for (let pad = 140; pad <= 165; pad += 5) {
    const o = errorOf(`${'y '.repeat(pad / 2)}Authorization: Bearer ${secret}`);
    assert.equal(o.includes('abcdefghijkl'), false, `pad ${pad}: ${o}`);
  }
});
