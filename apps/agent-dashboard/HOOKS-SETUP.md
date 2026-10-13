# HOOKS-SETUP - Claude Code hook configuration for the Agent Dashboard

> Status: **Applied to the project only.** The hook block is in
> `<repo>/.claude/settings.local.json` (owner decision B, project scope).
> `~/.claude/settings.json` and every other global or user config are **not** changed.
> Matcher `*` (every tool) is applied since 2026-10-13, see section 3b for cost and the failure rule. Verification status: section 7.
> The hook command calls the wrapper `bin/hook.sh` (finds node at run time, no fixed nvm path) since 2026-10-13, see section 4b.

## 1. What the hooks do

Each hook runs `hook-logger.js`. The script reads one JSON payload from stdin, keeps only the
fields the dashboard needs, and appends one line to `apps/agent-dashboard/data/events.jsonl`.
It writes nothing to stdout and always exits `0`, so it cannot change agent behaviour.
The hook run is short, but it is not async (see section 3).

## 2. Hook events used

Event names and fields are taken from the owner's notes for this dashboard. They have **not** been
re-checked against the official Claude Code docs in this session, and no copy of those docs is in this repo.
If a field name is wrong, the dashboard shows less data but nothing breaks.

| Event | Used for | Key fields used |
| :- | :- | :- |
| `SessionStart` | session start, main agent name | `source`, `agent_type` (when `--agent` is used) |
| `UserPromptSubmit` | main session turn starts (`running`) | common fields only |
| `PreToolUse` (matcher `*`) | delegation starts (Agent), or a tool call starts (all other tools) | Agent: `tool_input.subagent_type`, `tool_input.description`; all: `tool_name`, `tool_use_id` |
| `PostToolUse` (matcher `*`) | delegation returned (Agent: binds the spawned agent id); or a tool call ended | Agent: `tool_response.agentId`, `tool_response.status` (`completed` / `async_launched`); all: `tool_name`, `tool_use_id` |
| `PostToolUseFailure` (matcher `*`) | Agent: delegation failed (ERROR). Other tools: a red beam only (see 3b) | `error`, `tool_name`, `tool_use_id` |
| `SubagentStart` | subagent instance begins | `agent_id`, `agent_type` |
| `SubagentStop` | subagent finished | `agent_id`, `agent_type`, `last_assistant_message` |
| `Stop` | main turn finished | `last_assistant_message` |
| `StopFailure` | main turn ended by API error | `error` (error type) |
| `SessionEnd` | session ended | `reason` |

Common fields: `session_id`, `cwd`, `hook_event_name`.

## 3. Known gaps and limits

- **No explicit "subagent failed" event.** `SubagentStop` has no error flag. The dashboard marks a delegation
  `failed` only when the Agent tool call itself fails (`PostToolUseFailure` of `Agent`) or the main turn fails (`StopFailure`). A failed ordinary tool (Bash, Edit, ...) is not an agent failure (see 3b).
- **No `tool_use_id` on `SubagentStart` / `SubagentStop`.** Linking uses `PostToolUse(Agent).tool_response.agentId`
  (exact). When that is missing, it falls back to matching by agent name (`name-match`).
- **Agent tool name.** Current Claude Code calls the sub-agent tool `Agent`, older versions `Task`. Both are treated as a delegation everywhere
  (one shared check, `isDelegationTool()` in `lib/delegation.js`; tests in `test/delegation-task-parity.test.js`). The matcher is `*`,
  so the hook itself does not depend on the name. If delegations are missing, check `tool_name` in the events file.
- **Large payloads (stdin cap).** `hook-logger.js` reads at most 1 MiB of stdin. With matcher `*`, a `PostToolUse` of Read / WebFetch can carry a huge
  `tool_response`. Past the cap the rest is drained and dropped, and one compact record is written from the head of the payload
  (event, ids, `tool_name`, and for the Agent tool `subagent_type` / `description`) with `"truncated": true`. If even `hook_event_name` is not in the
  first 1 MiB, nothing is written. Always exit `0`, nothing on stdout (`test/hook-logger.test.js`).
- **Hook timing.** The config uses plain `command` hooks. Each event starts one Node process (about 0.1 s); with matcher `*` that is 2 per tool call (see 3b). The hook is
  not configured as async, because the `async` key was not verified for this Claude Code version.
  Check the `/hooks` output after the first start.
- **Ordering.** Events from parallel hooks can swap order by milliseconds. The workspace emits events in file order and does not re-sort them.
  Exception: a `SubagentStop` of a sync sub-agent run is held until its `PostToolUse(Agent)` arrives (it carries the
  `tool_use_id`), then released with that id, so it can be emitted after later events. The hold lasts at most 8 s
  (`TOOL_USE_WAIT_MS` in `lib/workspace.js`); after that it is released without an id (approximate match). If the Agent
  call fails (`PostToolUseFailure` of the Agent tool), the held stop is dropped. A failed ordinary tool does not touch it. All other events keep file order.
- **Escaped JSON is not redacted (known limit, accepted).** A JSON string that is itself escaped, such as
  `{\"password\":\"x\"}` (quotes written as `\"`), is not matched by the `"key": "value"` rule, so its value is stored as is.
  Plain JSON (`{"password":"x"}`) is redacted. Fixing this would need an unescape step, which was not added.
- **Keyword without a separator is not redacted.** `my pass is hunter2` or `user password is hunter2` has no `:` or `=`
  after the keyword, so the value is stored as is.
- **Cut in the middle of a space-free text.** A text longer than the 4000-char window that has no space before the limit
  is cut at the limit (hard cut). A secret that straddles that cut can then be stored in part (see section 5).

## 3b. Tool activity (เปิดใช้แล้ว 2026-10-13)

ฉาก 3D แสดงจังหวะคิดและลำแสงต่อ tool call (Read, Edit, Bash, ...) ซึ่งต้องใช้ event ของทุก tool จึงเปลี่ยน matcher ของ
`PreToolUse`, `PostToolUse`, `PostToolUseFailure` ใน `.claude/settings.local.json` จาก `"Agent"` เป็น `"*"` (ตรงกับทุก tool;
รูปแบบ `"*"` ใช้ได้ใน Claude Code ที่รันอยู่ ตรวจแล้วจากข้อมูลจริง: หลังแก้ไฟล์ record `Bash` เริ่มเข้า `data/events.jsonl` ทันที)
ไฟล์อื่นของ config ไม่ถูกแก้ ส่วน `.claude/settings.json` ไม่ถูกแตะ

**ต้นทุนที่ต้องรู้**
- node รัน **2 ครั้งต่อ tool call** (Pre + Post, ครั้งละประมาณ 0.1 s, ไม่ async) บวกกับ event อื่นที่มีอยู่แล้ว
  ผลคือหน่วงทุก tool call เล็กน้อย (Pre รันก่อน tool จึงบวกเวลาของ tool call จริง ๆ)
- `data/events.jsonl` เพิ่ม 2 บรรทัดต่อ tool call บรรทัดละประมาณ 220-270 byte (วัดจากทุก record ใน `events.jsonl` ตอนนี้ 2,462 บรรทัด: เฉลี่ย 248, p50 222, max 519 byte
  record ของ tool ธรรมดาไม่มี description จึงเล็กกว่านี้เล็กน้อย) ประมาณ 0.5 KB ต่อ tool call, 1,000 tool call ~ 0.5 MB
- **ไฟล์ไม่มีการ rotate และไม่มี size cap** (ตรวจ `hook-logger.js`, `lib/store.js`, `lib/workspace.js`: เขียนต่อท้ายอย่างเดียว,
  ล้างได้ด้วย `npm run replay:reset` หรือ `rm`) และ server อ่านทั้งไฟล์ตอนเริ่ม ข้อเสนอ (ยังไม่ได้ทำ): ดู "Log growth" ข้างล่าง
- ที่เก็บต่อ tool call: `tool_name`, `tool_use_id`, `agent_type`, `agent_id`, `session_id`, `cwd` (+ `error` ที่ redact และตัดที่ 160 ตัวอักษร
  เฉพาะตอน fail) **ไม่เก็บ input/output ของ tool** และตั้งแต่ 2026-10-13 `lib/normalize.js` ไม่เก็บ `description` ของ tool ธรรมดาอีก
  (เก็บเฉพาะ tool `Agent`/`Task` เพราะใช้เป็นข้อความงาน)

**กฎ failure (เจ้าของตัดสิน 2026-10-13)**

| PostToolUseFailure ของ | ผล |
| :- | :- |
| tool `Agent` (dispatch sub-agent ล้มเหลว) | `ERROR` ของ sub-agent นั้น (ดาวแดง + ดาวหางเข้าหลุมดำ) ปิดงานด้วย `tool_use_id` และทิ้ง stop ที่พักไว้ + failure marker ตามเดิม |
| tool ธรรมดาอื่นทั้งหมด (Bash exit != 0, Edit ไม่ตรง, Read ไม่พบไฟล์, ...) ทั้งใน sub-agent และใน main session | **ไม่เปลี่ยนสถานะดาว/instance, ไม่มีหลุมดำ, ไม่แตะ stop-hold และ failure marker, ไม่มีบรรทัด log** ส่งเป็น activity `error` ช่องเดียว: ลำแสงสีแดงจาก actor นั้น (ยาวกว่าลำปกติ 25%) |

เหตุผล: เมื่อ hook ครอบทุก tool, tool fail เป็นเรื่องปกติของการทำงาน ไม่ได้แปลว่า agent ล้มเหลว (กฎเดิม "ทุก failure = ERROR" จะทำให้ดาวแดงบ่อยเกินจริง)
ไม่มีบรรทัด log สำหรับ tool fail เพราะ workspace event ทุกชนิดมีสถานะ (`status`) ที่ไปเปลี่ยนดาว จึงทำบรรทัด log เฉย ๆ ไม่ได้โดยไม่เปลี่ยนโมเดล event

**Log ในหน้าเว็บและ replay ไม่ถูกท่วม**
- `PostToolUse` ของ tool ธรรมดาไม่สร้างบรรทัด log; `PreToolUse` ของ tool ธรรมดาสร้างบรรทัด "ใช้เครื่องมือ X" แบบสด แต่ **ไม่เข้า replay buffer**
  (`isToolStartLog` ใน `lib/workspace.js`) และ DOM ของ log เก็บไม่เกิน 300 บรรทัด (`MAX_LOG_LINES` ใน `public/workspace/app.js`)
- activity ของ tool ไปทางช่อง SSE `activity` แยก สดเท่านั้น ไม่เก็บ ไม่เข้า log
- stop-hold และการจับคู่ instance (`trackInstance`, `stopHold.*`) เกี่ยวข้องกับ tool `Agent` เท่านั้น event ของ tool อื่นไม่เข้าตรรกะนี้เลย (มีเทสต์ใน `test/workspace-tool-failure.test.js`)

**Log growth: ข้อเสนอ (ยังไม่ได้สร้าง)** เลือกอย่างใดอย่างหนึ่ง
1. rotate ตามขนาดใน `hook-logger.js`: ก่อน append ถ้าไฟล์ > ~5 MB ให้ `rename` เป็น `events.1.jsonl` (เก็บ 1-2 ไฟล์) ข้อดีง่าย ข้อเสีย `stat` ต่อทุก hook และ hub ต้องรองรับไฟล์ถูกแทนที่ (รองรับ truncate/replace อยู่แล้ว แต่ประวัติหายจาก replay)
2. ตัดทอนตอนเริ่ม server (`server.js`): ถ้า > N MB ให้เก็บเฉพาะท้ายไฟล์ ข้อดีไม่แตะ hook (เร็ว) ข้อเสียโตระหว่าง session ได้
3. ล้างเองด้วย `npm run replay:reset` เมื่อไม่ต้องการประวัติ (ไม่ต้องเขียนโค้ด)
แนะนำข้อ 1 ถ้าไฟล์ผ่าน ~5 MB บ่อย ตอนนี้ยังไม่จำเป็น

Record ที่ยิงจากใน sub-agent มี `agent_id`; ของ main session ไม่มี dashboard แปลง `agent_id` เป็น instance (ดวงจันทร์)
ผ่าน link ที่เชื่อได้เท่านั้น (ดู README หัวข้อ "Activity effects") ไม่งั้นนับเป็นของดาว (agent type)

**จะมีผลเมื่อไหร่:** ในเซสชันนี้ (ที่แก้ไฟล์) record ของ tool `Bash` เริ่มถูกบันทึกทันทีหลังแก้ไฟล์ โดยไม่ต้อง restart (สังเกตจาก `events.jsonl`) แต่ที่เห็นเป็นเซสชันเดียวกับที่แก้ ถ้าเซสชันอื่นที่เปิดค้างอยู่ไม่รับค่าใหม่ ให้เปิดเมนู `/hooks` หรือเริ่มเซสชันใหม่ (ยังไม่ได้ทดสอบกับเซสชันอื่น)

## 4. Hook config (applied)

File: `<repo>/.claude/settings.local.json` (created; it did not exist before, so no other keys were touched).
Paths are absolute. The command runs the wrapper `bin/hook.sh`, which finds node itself (section 4b), so an nvm update no longer breaks the hooks.
(Before 2026-10-13 the command had a fixed nvm path, `.../vX.Y.Z/bin/node`, and the hooks stopped silently when that version was removed.)

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `*`), `PostToolUse` (matcher `*`),
`PostToolUseFailure` (matcher `*`), `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `SessionEnd`.

Each entry runs this command (shown once; the file has it 10 times):

```
/bin/sh <repo>/apps/agent-dashboard/bin/hook.sh
```

Scope decision (owner): **project only**. Hooks are not in `~/.claude/settings.json`, so unrelated Claude sessions on this machine
are not logged. Sessions started in a subfolder of `ai-team` may or may not read this file (not verified).

## 4b. Wrapper `bin/hook.sh` (เพิ่ม 2026-10-13)

**ปัญหาเดิม:** command ของ hook ชี้ node ตายตัวที่ `~/.nvm/versions/node/vX.Y.Z/bin/node` พอ nvm อัปเดตแล้วลบเวอร์ชันนั้น hook
จะหยุดทำงานแบบเงียบ ๆ (ไม่มี error ให้เห็น, `events.jsonl` ไม่โต)

**ทางแก้:** `bin/hook.sh` (POSIX sh) หา node ตอนรัน แล้วเรียก `hook-logger.js` ลำดับการหา (ตัวแรกที่เจอชนะ):
1. `command -v node` (PATH ของ hook process)
2. nvm default alias: `$NVM_DIR/alias/default` (`NVM_DIR` ไม่ตั้ง = `~/.nvm`) ถ้าเป็นเลขเวอร์ชัน (เช่น `v22.1.0` หรือ `22`) เลือกตัวใหม่สุดที่ตรงกัน เทียบเป็นตัวเลข (v22.10 > v22.9)
3. nvm ตัวใหม่สุดที่ติดตั้งอยู่ (ใช้เมื่อ alias เป็นชื่อ เช่น `lts/*` หรือเวอร์ชันนั้นไม่มีแล้ว)
4. path ทั่วไป: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, `~/.volta/bin/node` (ตัวแปร `DASHBOARD_NODE_FALLBACKS` แทนรายการนี้ได้ ใช้ในเทสต์)

**พฤติกรรม:** ส่ง stdin ต่อให้ `hook-logger.js` ตามเดิม, ไม่เขียน stdout/stderr (output ของ node ถูกทิ้ง), **exit `0` เสมอ**
(node ไม่เจอ, node crash, ไม่มี `hook-logger.js`) ถ้าไม่เจอ node เลย จะต่อท้ายบรรทัดเดียวใน `data/hook-wrapper.log`
(`DASHBOARD_WRAPPER_LOG` เปลี่ยนที่ได้) เพื่อให้ความล้มเหลวไม่หายเงียบสนิท การเขียนนี้ best effort เช่นกัน
`.claude/settings.local.json` ถูกแก้เฉพาะสตริง `command` ของ hook ทั้ง 10 รายการ (matcher และส่วนอื่นเหมือนเดิม):

```
ก่อน: ~/.nvm/versions/node/vX.Y.Z/bin/node <repo>/apps/agent-dashboard/hook-logger.js
หลัง: /bin/sh <repo>/apps/agent-dashboard/bin/hook.sh
```

ใช้ `/bin/sh <script>` ไม่ใช่เรียกสคริปต์ตรง ๆ เพื่อไม่พึ่ง executable bit (ตั้ง `chmod +x` ไว้แล้วด้วย) ข้อจำกัด: ถ้า `node` บน PATH เป็นเวอร์ชันเก่ากว่า 18.18 (`engines`)
wrapper ไม่ตรวจเวอร์ชัน (ไม่อยากเพิ่ม node อีกหนึ่ง process ต่อ hook) ถ้า hook เงียบ ให้ดู `data/hook-wrapper.log` และ `node --version`
Rollback: ใส่ command เดิมกลับใน `settings.local.json`
เทสต์: `test/hook-wrapper.test.js` (sandbox: HOME ปลอม, nvm ปลอม, PATH เล็ก, events/log ใน temp)

## 5. Privacy: what is stored

- Stored: timestamp, event name, session id, cwd, agent id and name, `tool_name`, `tool_use_id`, requested agent type,
  task description (max 123 chars, Agent tool only), error text (max 163 chars), last assistant message (max 203 chars),
  SessionEnd reason / SessionStart source (max 83 chars). The limit counts the text (120 / 160 / 200 / 80)
  plus the `...` mark added when a text is cut, so the stored length can be 3 chars more than the text limit. Short id fields are capped at 128 chars; cwd at 256 chars.
- cwd: the home folder is replaced by `~` (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), then cwd is redacted
  with the same rules as free text (for example `?token=...` in a path), then capped at 256 chars.
  Side effect: a long folder name (32+ chars of `A-Za-z0-9_-`) in a cwd is redacted as well.
- Not stored: prompts, full tool inputs, transcripts, file contents.
- Free text (description, error, last message, reason) is redacted, then cut. Clipping always runs after redaction.
  Text longer than 4000 chars is cut at the last space before that limit BEFORE redaction, so a secret that
  straddles the limit is dropped, not split. A text with no space before the limit is hard-cut there.
  Clipping never leaves a lone UTF-16 surrogate (an emoji is never cut in half).
  Redaction is regex based and best effort. It covers:
  - `Authorization:` headers with any scheme (`Basic`, `Bearer`, ...): the scheme and the credential are removed.
  - `Cookie:` and `Set-Cookie:` headers: the `name=value` pairs are removed.
  - `Bearer` tokens and `sk-` / `pk-` / `ghp_` `gho_` `ghu_` `ghs_` `ghr_` / `github_pat_` / `glpat-` / `xox*-` / `xapp-` style keys, `npm_` tokens, Google `AIza...` keys.
  - JSON Web Tokens (`eyJ...` header.payload.signature): the whole token, so the claims in the payload are not left readable.
  - AWS access key IDs starting with `AKIA` or `ASIA` (20 chars). SigV4 `X-Amz-Signature=` values.
  - URL userinfo: `scheme://user:password@host` keeps the scheme and host, the user and password are removed (a password containing `@` too).
  - Secret flags with the value after a space (`--password hunter2`, `--token x`, `--api-key x`) and a `?key=` / `&key=` query parameter.
  - Multi-line PEM private key blocks (`-----BEGIN ... PRIVATE KEY-----` to `-----END ...`), also when cut by the input window.
  - Secret-like `key=value`, `key: value` and JSON `"key": "value"` pairs. The keyword is matched inside longer
    names, so `DB_PASSWORD=`, `DB_PASS=`, `GITHUB_TOKEN=`, `client_secret=` and `AWS_SECRET_ACCESS_KEY=` are caught.
    Keywords: `password`, `passwd`, `passphrase`, `pass` (as a whole word or with a `_ . -` suffix), `pwd`, `secret`,
    `token`, `credential`, `signature`, `api_key` / `apikey`, `access_key`, `private_key`.
    Values:
    - Quoted (`"..."` or `'...'`). An unclosed quote runs to the end of the text. After the closing quote, a glued
      char (no space, and not `,` `}` `]`) continues the value to `;` `&` or the end, so `password="a b"c d` hides
      `c d`. A space right after the closing quote ends the value, so `password="a b" next` keeps `next` readable.
      JSON `{"password":"x","user":"bob"}` keeps `"user":"bob"` readable.
    - Bare (no leading quote). Runs to `;` or `&`, or to the end of the text. Quotes, spaces and digits do NOT stop it.
      So `DB_PASSWORD=my secret pass`, `password=abc def123`, `DB_PASS=a b c` and `password=a"b c d` are fully hidden.
    Known limits (not fixed):
    - Escaped quotes (`\"`) inside a JSON string value end the quoted match early, so the text after the `\"` can stay
      readable up to the next quote. Example: `{"password":"abc\" def","user":"bob"}` leaves ` def` visible.
    - A keyword with no `:` or `=` right after it is not matched. Example: `password hunter2` and
      `the password is hunter2` are stored as is.
    Accepted over-redaction (owner decision: over-redaction is acceptable, leaks are not): `password=x is wrong`
    becomes `password=[REDACTED]`, and everything after a bare keyword value up to `;` `&` or the end is hidden.
  - Email addresses, and long opaque strings (32+ chars of `A-Za-z0-9_-`: hex digests, base64url). Base64 blobs with `/`, `+` or `=` padding (32+ chars)
    are redacted too, unless they look like a path (many `/`, no `+`, no padding, not mixed digits + upper + lower case).
  - A failed Bash call keeps at most 160 chars of its stderr as `error`, after all of the above. Tests: `test/normalize-redaction.test.js`.
  - The user name in `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` (replaced by `~`).
  - Not covered: bare secrets with no keyword and no known prefix (for example a plain password in prose,
    or `KEY=` alone). Such values are stored as is. Keywords also match words like `tokens:`, so some harmless
    text is redacted too (on purpose).
- **Error text and messages are stored in plaintext in `data/events.jsonl`.** The file is local and readable by any
  process running as your user. Delete it when you no longer need it (`rm data/events.jsonl`, or `npm run replay:reset`).
  `data/` is in `.gitignore`.

## 6. How to apply, check and roll back

1. Start Claude Code in `ai-team`, then run `/hooks` to confirm the 10 entries are listed.
2. Run one small delegation and check that new lines appear in `apps/agent-dashboard/data/events.jsonl`.
3. Open the dashboard: `cd apps/agent-dashboard && npm start`, then <http://127.0.0.1:4317>.
4. Rollback: delete the `hooks` key from `.claude/settings.local.json`, or delete the file if it only contains the hooks.

Manual test without Claude Code (writes to the real `data/` folder unless you set `DASHBOARD_EVENTS_FILE`):

```bash
echo '{"hook_event_name":"PreToolUse","session_id":"manual","tool_name":"Agent","tool_use_id":"t1","tool_input":{"subagent_type":"app-dev"}}' \
  | DASHBOARD_EVENTS_FILE=/tmp/check.jsonl /bin/sh <repo>/apps/agent-dashboard/bin/hook.sh
```

## 7. Verification status

- `hook-logger.js`: tested as a child process (`test/hook-logger.test.js`): one line written, prompt not stored,
  empty stdout, exit `0` on empty, invalid or non-hook input, and on payloads over the 1 MiB stdin cap (compact record with `truncated: true`).
- `bin/hook.sh`: tested in a sandbox (`test/hook-wrapper.test.js`): node on PATH, nvm default alias (exact and major only), newest nvm install,
  fixed-path fallback, no node at all, crashing node, missing `hook-logger.js`; always exit `0`, nothing on stdout / stderr.
- **Live Claude Code session: verified.** The hooks have run in real Claude Code sessions since the first setup: `data/events.jsonl` holds thousands of real records
  (including sub-agent records with `agent_id` / `agent_type`), and the matcher `*` was confirmed on 2026-10-13 (`Bash` records appeared without a restart).
  After the command was switched to `bin/hook.sh` (2026-10-13), the running session picked the change up without a restart: a temporary marker line in the wrapper
  fired on every tool call and new `PreToolUse` / `PostToolUse` records kept arriving in `data/events.jsonl` (the marker was removed afterwards).
- The settings file parses as JSON; all 10 commands are the same `/bin/sh .../bin/hook.sh` string; matchers are unchanged.
- **Not verified:** the event and field names against the current official Claude Code docs (section 2); other already-open sessions
  picking up a changed `settings.local.json`; a failing tool in a live session (covered by tests only); the `/hooks` menu listing after the wrapper change.
