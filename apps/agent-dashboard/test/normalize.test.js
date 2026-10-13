'use strict';
/**
 * normalize.test.js - redaction, clipping, id caps, cwd home folder and reason (QA M3 + round 2).
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, safeText, homeToTilde,
  MAX_ERROR, MAX_TEXT, MAX_ID, MAX_CWD, MAX_REASON, MAX_INPUT,
} = require('../lib/normalize');

const NOW = new Date('2026-10-11T09:00:00.000Z');

/** Redacted error text of a single PostToolUseFailure payload. */
const errorOf = (text) => normalize({ hook_event_name: 'PostToolUseFailure', error: text }, NOW).error;

// ---- Existing behaviour (clip, flatten, drop non-strings) ----

test('error text is clipped to MAX_ERROR characters', () => {
  // Words with spaces, so the opaque-token rule does not apply and only clipping is tested
  const rec = normalize({ hook_event_name: 'PostToolUseFailure', error: `boom ${'step '.repeat(200)}` }, NOW);
  assert.ok(rec.error.length <= MAX_ERROR + 3, `error length ${rec.error.length} too long`);
  assert.ok(rec.error.endsWith('...'));
});

test('error text: secrets, emails and home folder names are redacted', () => {
  // ";" ends the bare token value, so the other items below are not hidden by the keyword rule
  // and each redaction is tested on its own.
  const raw = 'auth failed token=abc123; key sk-ABCDEFGHIJKL12345; mail john@example.com; in /Users/alice/secret-project';
  const rec = normalize({ hook_event_name: 'PostToolUseFailure', error: raw }, NOW);
  assert.equal(rec.error.includes('abc123'), false);
  assert.equal(rec.error.includes('sk-ABCDEFGHIJKL12345'), false);
  assert.equal(rec.error.includes('john@example.com'), false);
  assert.equal(rec.error.includes('/Users/alice'), false);
  assert.ok(rec.error.includes('[REDACTED]'));
  assert.ok(rec.error.includes('~/secret-project'));
});

test('bearer tokens and long opaque strings are redacted', () => {
  const rec = normalize({
    hook_event_name: 'StopFailure',
    error: `Bearer abcdefghijklmnop ${'Z'.repeat(40)}`,
  }, NOW);
  assert.equal(rec.error.includes('abcdefghijklmnop'), false);
  assert.equal(rec.error.includes('ZZZZZZZZZZ'), false);
});

test('control characters and newlines are flattened to spaces', () => {
  const rec = normalize({ hook_event_name: 'PostToolUseFailure', error: 'line1\nline2\tline3' }, NOW);
  assert.equal(rec.error, 'line1 line2 line3');
});

test('last_assistant_message and task description are redacted and clipped too', () => {
  const rec = normalize({
    hook_event_name: 'SubagentStop',
    last_assistant_message: `password: hunter2 ${'y'.repeat(500)}`,
    tool_input: { description: `api_key=SECRETVALUE ${'d'.repeat(300)}` },
  }, NOW);
  assert.equal(rec.last_message.includes('hunter2'), false);
  assert.ok(rec.last_message.length <= 204);
  assert.equal(rec.description.includes('SECRETVALUE'), false);
  assert.ok(rec.description.length <= 123);
});

test('non-string error is dropped, not stored', () => {
  const rec = normalize({ hook_event_name: 'PostToolUseFailure', error: { nested: 'x' } }, NOW);
  assert.equal(rec.error, undefined);
});

// ---- Round 2 (Med): one test per redaction pattern ----

test('AWS_SECRET_ACCESS_KEY= env assignment is redacted', () => {
  const out = errorOf('deploy failed AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end');
  assert.equal(out.includes('wJalrXUtnFEMI'), false);
  assert.equal(out.includes('bPxRfiCYEXAMPLEKEY'), false);
  assert.ok(out.includes('AWS_SECRET_ACCESS_KEY=[REDACTED]'));
});

test('DB_PASSWORD= is redacted (keyword without a word boundary before it)', () => {
  const out = errorOf('connect DB_PASSWORD=hunter2x now');
  assert.equal(out.includes('hunter2x'), false);
  assert.ok(out.includes('DB_PASSWORD=[REDACTED]'));
});

test('GITHUB_TOKEN= is redacted, with or without a ghp_ prefix', () => {
  const out = errorOf('GITHUB_TOKEN=ghp_abcdefghijklmnop1234 push rejected');
  assert.equal(out.includes('ghp_abcdef'), false);
  assert.equal(out.includes('1234'), false);
  assert.ok(out.includes('GITHUB_TOKEN=[REDACTED]'));

  const plain = errorOf('GITHUB_TOKEN=plainvalue123 push rejected');
  assert.equal(plain.includes('plainvalue123'), false);
});

test('client_secret= is redacted', () => {
  const out = errorOf('oauth client_secret=s3cr3tV4lue refused');
  assert.equal(out.includes('s3cr3tV4lue'), false);
  assert.ok(out.includes('client_secret=[REDACTED]'));
});

test('JSON keys "password" and "token" are redacted; other keys are kept', () => {
  const out = errorOf('payload {"password": "hunter2pw", "token":"tok123", "user":"bob"}');
  assert.equal(out.includes('hunter2pw'), false);
  assert.equal(out.includes('tok123'), false);
  assert.ok(out.includes('"user":"bob"'), 'non-secret keys stay readable');
});

test('quoted JSON value with spaces is redacted as a whole', () => {
  const out = errorOf('{"api_key": "alpha beta gamma"} end');
  assert.equal(out.includes('alpha'), false);
  assert.equal(out.includes('gamma'), false);
  assert.ok(out.includes('[REDACTED]'));
});

test('Authorization: Basic credentials are redacted (scheme and credential)', () => {
  const out = errorOf('request sent Authorization: Basic dXNlcjpwYXNzd29yZA== to host');
  assert.equal(out.includes('dXNlcjpwYXNz'), false);
  assert.equal(out.includes('Basic'), false);
  assert.ok(out.includes('Authorization: [REDACTED]'));
});

test('Authorization header with Bearer scheme and a bare Authorization value are redacted', () => {
  const bearer = errorOf('Authorization: Bearer abc.def.ghi');
  assert.equal(bearer.includes('abc.def.ghi'), false);
  const bare = errorOf('Authorization: rawsecretvalue');
  assert.equal(bare.includes('rawsecretvalue'), false);
});

test('AWS access key ID (AKIA and ASIA, 20 chars) is redacted', () => {
  const out = errorOf('used key AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE here');
  assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(out.includes('ASIAIOSFODNN7EXAMPLE'), false);
  assert.ok(out.includes('[REDACTED_AWS_KEY]'));
});

test('AWS access key ID right after "=" is redacted', () => {
  const out = errorOf('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
  assert.equal(out.includes('AKIAIOSFODNN7EXAMPLE'), false);
});

test('secret-like keywords are redacted in URLs and after a colon', () => {
  const out = errorOf('GET https://x.test/cb?access_token=abc123&state=1 api-key: zzz999');
  assert.equal(out.includes('abc123'), false);
  assert.equal(out.includes('zzz999'), false);
  assert.ok(out.includes('state=1'), 'parameters after & stay readable');
});

test('long opaque strings (32+ chars) are redacted', () => {
  const out = errorOf(`hash ${'a1B2c3D4'.repeat(5)} end`);
  assert.equal(out.includes('a1B2c3D4'), false);
  assert.ok(out.includes('[REDACTED_TOKEN]'));
});

test('home folder of Linux and Windows users is replaced by ~', () => {
  const out = errorOf('path /home/alice/proj and C:\\Users\\bob\\proj failed');
  assert.equal(out.includes('alice'), false);
  assert.equal(out.includes('bob'), false);
  assert.ok(out.includes('~/proj'));
});

// ---- Round 2 (Med): a secret that crosses a boundary must not leak ----

test('secret crossing the OUTPUT clip boundary is redacted before clipping (keyword value)', () => {
  // 180 chars of padding, then token=... starts at 180. MAX_TEXT is 200, so a clip-first
  // implementation would store "token=ABCDEFGHIJKLMNOPQRST" (readable). Redact-first must not.
  const pad = 'ok '.repeat(60);
  const rec = normalize({
    hook_event_name: 'SubagentStop',
    last_assistant_message: `${pad}token=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123`,
  }, NOW);
  assert.equal(rec.last_message.includes('ABCDE'), false, `leaked: ${rec.last_message}`);
  assert.ok(rec.last_message.includes('token=[REDACTED]'));
});

test('secret crossing the OUTPUT clip boundary is redacted before clipping (opaque token)', () => {
  // A 40-char opaque token starts at 180: clip-first would keep 20 chars (below the 32-char rule).
  const pad = 'ok '.repeat(60);
  const rec = normalize({
    hook_event_name: 'SubagentStop',
    last_assistant_message: `${pad}${'Z'.repeat(40)} end`,
  }, NOW);
  assert.equal(rec.last_message.includes('ZZZZ'), false, `leaked: ${rec.last_message}`);
  assert.ok(rec.last_message.includes('[REDACTED_TOKEN]'));
});

test('secret straddling the INPUT window (MAX_INPUT) is dropped at the last space, never split', () => {
  // Each secret starts BEFORE MAX_INPUT and ends AFTER it. The window is cut at the last space
  // before MAX_INPUT, so the whole secret is dropped. A hard cut at MAX_INPUT (slice(0, MAX_INPUT))
  // would keep a fragment that no pattern matches and leak it:
  //   - 40 opaque chars: 20 kept (below the 32-char rule)
  //   - AWS key ID: first 10 of 20 chars kept (no AKIA match)
  //   - keyword value: "password" kept, value hidden only by the keyword rule
  const cases = [
    { secret: 'Z'.repeat(40), forbidden: ['ZZZZ'] },
    { secret: 'AKIAIOSFODNN7EXAMPLE', forbidden: ['AKIAIOSFOD'] },
    { secret: 'password=HUNTER2SECRETVALUE', forbidden: ['HUNTER2', 'password'] },
  ];
  for (const { secret, forbidden } of cases) {
    const start = MAX_INPUT - Math.floor(secret.length / 2); // even number: start is at MAX_INPUT - half
    const head = 'a '.repeat(start / 2);                     // ends with a space right before the secret
    // Large max so the whole output is visible (MAX_TEXT would clip before the tail).
    const out = safeText(`${head}${secret} tail`, 100000);
    for (const bad of forbidden) {
      assert.equal(out.includes(bad), false, `leaked "${bad}" from ${secret.length}-char secret: ...${out.slice(-40)}`);
    }
    assert.ok(out.endsWith('a'), 'text before the straddling secret is kept');
  }
});

test('straddling secret: the window cut keeps text up to the space, nothing after it', () => {
  // Exact check: everything after the last space before MAX_INPUT is gone, the text before it is kept.
  const head = 'a '.repeat(1990); // 3980 chars, last char is a space at index 3979
  const out = safeText(`${head}${'Q'.repeat(60)} tail`, 100000);
  assert.equal(out, head.trim(), 'only the text before the secret is stored');
});

test('text longer than the input window is cut, not stored in full', () => {
  const rec = safeText(`${'word '.repeat(2000)}`, 100000);
  assert.ok(rec.length <= MAX_INPUT, `stored ${rec.length} chars`);
});

// ---- Round 2 (Low): id caps, cwd home folder, reason ----

test('short identifier fields are capped at MAX_ID characters', () => {
  const big = 'x'.repeat(500);
  const rec = normalize({
    hook_event_name: 'PreToolUse', session_id: big, agent_id: big, tool_use_id: big,
    tool_name: big, agent_type: big, tool_input: { subagent_type: big },
  }, NOW);
  for (const key of ['session_id', 'agent_id', 'tool_use_id', 'tool_name', 'agent_type', 'subagent_type']) {
    assert.equal(rec[key].length, MAX_ID, `${key} must be capped`);
  }
});

test('cwd: home folder is replaced by ~ so the user name is not stored', () => {
  const rec = normalize({ hook_event_name: 'SessionStart', cwd: '/Users/alice/Desktop/ai-team' }, NOW);
  assert.equal(rec.cwd, '~/Desktop/ai-team');
  assert.equal(JSON.stringify(rec).includes('alice'), false);

  const linux = normalize({ hook_event_name: 'SessionStart', cwd: '/home/alice' }, NOW);
  assert.equal(linux.cwd, '~');
});

test('cwd outside the home folder is kept, and capped at MAX_CWD', () => {
  const rec = normalize({ hook_event_name: 'SessionStart', cwd: '/tmp/x' }, NOW);
  assert.equal(rec.cwd, '/tmp/x');
  const long = normalize({ hook_event_name: 'SessionStart', cwd: `/srv/${'d/'.repeat(300)}` }, NOW);
  assert.equal(long.cwd.length, MAX_CWD);
});

test('homeToTilde handles macOS, Linux and Windows home folders', () => {
  assert.equal(homeToTilde('/Users/alice/Desktop/x'), '~/Desktop/x');
  assert.equal(homeToTilde('/Users/alice'), '~');
  assert.equal(homeToTilde('/home/alice/src'), '~/src');
  assert.equal(homeToTilde('C:\\Users\\bob\\proj'), '~\\proj');
  assert.equal(homeToTilde('/Users2/x'), '/Users2/x', 'only the exact /Users segment is replaced');
});

test('reason (SessionEnd) is redacted and capped', () => {
  const rec = normalize({ hook_event_name: 'SessionEnd', reason: `logout password=hunter2 ${'r'.repeat(300)}` }, NOW);
  assert.equal(rec.reason.includes('hunter2'), false);
  assert.ok(rec.reason.length <= MAX_REASON + 3);
});

test('reason falls back to SessionStart source, and empty reason uses source', () => {
  assert.equal(normalize({ hook_event_name: 'SessionStart', source: 'startup' }, NOW).reason, 'startup');
  assert.equal(normalize({ hook_event_name: 'SessionEnd', reason: '', source: 'clear' }, NOW).reason, 'clear');
});

// ---- Final QA (Med): redaction bypasses, one test per bypass ----

test('DB_PASS= and pass: keys are redacted', () => {
  const env = errorOf('connect DB_PASS=hunter2 failed');
  assert.equal(env.includes('hunter2'), false, env);
  assert.ok(env.includes('DB_PASS=[REDACTED]'));

  const colon = errorOf('login pass: hunter2 rejected');
  assert.equal(colon.includes('hunter2'), false, colon);
  assert.ok(colon.includes('pass: [REDACTED]'));
});

test('"pass" inside normal words is NOT redacted (no over-redaction of passed:, bypass=)', () => {
  const out = errorOf('tests passed: 76 bypass=true compass');
  assert.equal(out, 'tests passed: 76 bypass=true compass');
});

test('URL userinfo (://user:pw@host) is redacted, host kept', () => {
  const out = errorOf('dsn postgres://user:s3cr3tpw@db.local:5432/app failed');
  assert.equal(out.includes('s3cr3tpw'), false, out);
  assert.equal(out.includes('user:'), false, out);
  assert.ok(out.includes('postgres://[REDACTED]@db.local:5432/app'));
});

test('Cookie and Set-Cookie headers are redacted', () => {
  const cookie = errorOf('Cookie: sessionid=abc123; csrf=xyz789 and more');
  assert.equal(cookie.includes('abc123'), false, cookie);
  assert.equal(cookie.includes('xyz789'), false, cookie);
  assert.ok(cookie.includes('Cookie: [REDACTED]'));

  const setCookie = errorOf('Set-Cookie: id=secretvalue1; Path=/; HttpOnly');
  assert.equal(setCookie.includes('secretvalue1'), false, setCookie);
  assert.ok(setCookie.includes('Set-Cookie: [REDACTED]'));
});

test('X-Amz-Signature (and the other SigV4 query parameters) are redacted', () => {
  const out = errorOf('GET https://s3.test/o?X-Amz-Signature=deadbeef0123&X-Amz-Date=20261011');
  assert.equal(out.includes('deadbeef0123'), false, out);
  assert.ok(out.includes('X-Amz-Signature=[REDACTED]'));
  assert.ok(out.includes('X-Amz-Date=20261011'), 'non-secret parameter stays readable');
});

test('unclosed quotes are redacted (password="x and token=\'abc def)', () => {
  const dq = errorOf('config password="hunter2 tail');
  assert.equal(dq.includes('hunter2'), false, dq);
  assert.ok(dq.includes('password=[REDACTED]'));

  const sq = errorOf("config token='abc def");
  assert.equal(sq.includes('abc'), false, sq);
  assert.equal(sq.includes('def'), false, sq);
});

test('unquoted values that contain spaces are redacted to the end of the plain words', () => {
  const out = errorOf('set DB_PASSWORD=my secret pass now');
  assert.equal(out.includes('secret'), false, out);
  assert.equal(out.includes('my '), false, out);
  assert.ok(out.includes('DB_PASSWORD=[REDACTED]'));
});

test('multi-line PEM private key block is fully redacted (no base64 fragments leak)', () => {
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC+ab/cd',
    'XYZ+/12==',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const out = errorOf(`key ${pem} done`);
  assert.equal(out.includes('MIIE'), false, out);
  assert.equal(out.includes('XYZ'), false, out);
  assert.equal(out.includes('ab/cd'), false, out);
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'));
  assert.ok(out.includes('done'), 'text after the block stays readable');
});

test('PEM block cut by the input window is redacted to the end of the window', () => {
  const body = 'A+/'.repeat(MAX_INPUT); // no END marker inside the window
  const out = safeText(`-----BEGIN RSA PRIVATE KEY-----\n${body}`, 100000);
  assert.equal(out.includes('A+/'), false, 'key body must not leak');
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'));
});

test('redaction still runs before clipping for the new patterns', () => {
  // The URL userinfo starts after 180 chars: clip-first would keep a readable prefix of it.
  const pad = 'ok '.repeat(60);
  const rec = normalize({
    hook_event_name: 'SubagentStop',
    last_assistant_message: `${pad}postgres://user:s3cr3tpw@host`,
  }, NOW);
  assert.equal(rec.last_message.includes('s3cr3tpw'), false, rec.last_message);
});

// ---- Final QA round 3 (Med): bare keyword values must hide the whole tail ----

test('bare value followed by a word with digits: "password=abc def123" hides def123', () => {
  // Before the fix the tail "def123" leaked (the value stopped at a non-letter-only word).
  const out = errorOf('password=abc def123');
  assert.equal(out.includes('def123'), false, out);
  assert.equal(out.includes('abc'), false, out);
  assert.equal(out, 'password=[REDACTED]');
});

test('bare value followed by plain words: "password=x is wrong" is over-redacted (accepted rule)', () => {
  // Over-redaction is accepted on purpose: everything up to the next quote, ";", "&" or end is hidden.
  const out = errorOf('password=x is wrong');
  assert.equal(out, 'password=[REDACTED]', out);
});

test('bare value with spaces and digits: "DB_PASS=a b c" hides the whole value', () => {
  const out = errorOf('DB_PASS=a b c');
  assert.equal(out, 'DB_PASS=[REDACTED]', out);
});

test('bare value stops at ";" and "&" so the next parameter stays readable', () => {
  const out = errorOf('password=abc def123; mode=fast&x=1 done');
  assert.equal(out.includes('def123'), false, out);
  // The value ends at ";": the text after it stays readable.
  assert.equal(out, 'password=[REDACTED]; mode=fast&x=1 done', out);
});

// ---- Owner-approved fix (Med): a quote INSIDE a bare value must not stop the redaction ----

test('bare value with a quote inside: "password=a\\"b c d" hides the whole tail (no "b c d leak)', () => {
  // Before the fix the bare rule stopped at the quote, so the tail '"b c d' was stored in plaintext.
  const out = errorOf('password=a"b c d');
  assert.equal(out.includes('b c d'), false, out);
  assert.equal(out.includes('"b'), false, out);
  assert.equal(out, 'password=[REDACTED]', out);
});

test('bare value with a single quote inside is hidden to the end (same rule as double quote)', () => {
  const out = errorOf("password=a'b c d");
  assert.equal(out.includes('b c d'), false, out);
  assert.equal(out, 'password=[REDACTED]', out);
});

test('bare value with a quote still stops at ";" (the rule keeps the next parameter readable)', () => {
  // The quote does not end the value, but ";" does: "user=bob" after ";" must stay readable.
  const out = errorOf('password=a"b c; user=bob');
  assert.equal(out.includes('b c'), false, out);
  assert.equal(out, 'password=[REDACTED]; user=bob', out);
});

// ---- Final QA round 3 (Low): no lone UTF-16 surrogate after a clip ----

test('clip never leaves a lone high surrogate at the end (emoji cut in half)', () => {
  // Index 199 is a high surrogate. slice(0, 200) would end with it, so the cut must go back one unit.
  const out = safeText(`${'word '.repeat(39)}abcd\u{1F600}tail`, 200);
  assert.ok(out.endsWith('...'), out);
  const body = out.slice(0, -3);
  const last = body.charCodeAt(body.length - 1);
  assert.equal(last >= 0xd800 && last <= 0xdbff, false, 'no lone high surrogate before "..."');
  // A lone surrogate would be replaced by U+FFFD on a UTF-8 round trip.
  assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out, 'output is well-formed UTF-16');
});

// ---- Final QA round 3 (Low): cwd goes through the same redaction ----

test('cwd: secrets in the path are redacted, and the home folder is still replaced', () => {
  const secretQuery = normalize({ hook_event_name: 'SessionStart', cwd: '/srv/deploy?token=abc123secret' }, NOW);
  assert.equal(secretQuery.cwd.includes('abc123secret'), false, secretQuery.cwd);
  assert.ok(secretQuery.cwd.includes('token=[REDACTED]'));

  const withHome = normalize({ hook_event_name: 'SessionStart', cwd: '/Users/alice/Desktop/password=hunter2' }, NOW);
  assert.equal(withHome.cwd, '~/Desktop/password=[REDACTED]');
});

// ---- Owner-approved fix (Med): a quoted value followed by glued chars must not leak its tail ----

test('double-quoted value with glued tail: password="a b"c d hides "c d", and user=bob after ";" stays readable', () => {
  const out = errorOf('password="a b"c d; user=bob');
  assert.equal(out.includes('c d'), false, out);
  assert.equal(out.includes('"a'), false, out);
  assert.equal(out, 'password=[REDACTED]; user=bob', out);
});

test('single-quoted value with glued tail: password=\'a b\'c d hides the whole tail', () => {
  const out = errorOf("password='a b'c d");
  assert.equal(out.includes('c d'), false, out);
  assert.equal(out.includes('a b'), false, out);
  assert.equal(out, 'password=[REDACTED]', out);
});

test('quoted value followed by a space ends the value: password="a b" next keeps "next" readable', () => {
  const out = errorOf('password="a b" next');
  assert.equal(out.includes('a b'), false, out);
  assert.equal(out, 'password=[REDACTED] next', out);
});

test('normal JSON still works: {"password":"x","user":"bob"} keeps "user" readable', () => {
  const out = errorOf('{"password":"x","user":"bob"}');
  assert.equal(out.includes('"x"'), false, out);
  assert.ok(out.includes('"user":"bob"'), out);
  assert.equal(out, '{"password":[REDACTED],"user":"bob"}', out);
});

test('closing brace or bracket after a quoted value stops it (JSON arrays stay readable)', () => {
  const out = errorOf('[{"token":"abc"},{"user":"bob"}]');
  assert.equal(out.includes('abc'), false, out);
  assert.equal(out, '[{"token":[REDACTED]},{"user":"bob"}]', out);
});

test('ordinary tool records stay compact: no description (or other input text) is stored, the Agent tool keeps its task text', () => {
  // Added 2026-10-13, when the hook matcher widened to every tool: two records per tool call must stay small.
  const input = { description: 'list files in the secret folder', command: 'cat /etc/passwd', file_path: '/Users/x/y.txt', content: 'z'.repeat(5000) };
  const bash = normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: input,
    tool_response: { stdout: 'o'.repeat(5000) } }, NOW);
  assert.equal(bash.description, undefined, 'the Bash description is not stored');
  assert.ok(JSON.stringify(bash).length < 400, 'an ordinary tool record is small');
  assert.equal('command' in bash || 'content' in bash || 'file_path' in bash || 'stdout' in bash, false, 'no tool input / output keys');
  const edit = normalize({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: input }, NOW);
  assert.equal(edit.description, undefined);
  const agent = normalize({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'app-dev', description: 'do the thing' } }, NOW);
  assert.equal(agent.description, 'do the thing', 'the Agent tool keeps its task text');
  // A failed ordinary tool keeps a clipped, redacted error (max 160 + "...") and nothing else big
  const fail = normalize({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_2', error: `boom ${'x '.repeat(500)}`, tool_input: input }, NOW);
  assert.ok(fail.error.length <= 163);
  assert.ok(JSON.stringify(fail).length < 700);
});
