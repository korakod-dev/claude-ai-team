# AI Team — shared rules (read by every agent)

Owner: คุณกฎ (Korakod). Experienced developer + QA. Skip fundamentals; do not over-explain.

## Language
- Talk to the owner in Thai.
- Thai for documents/reports (study work, portfolio text by default).
- English for code, code comments, prompts, and technical specs.

## Folders (each specialist works only in its own folder)
- `apps/`      -> app development: Dev-ไอ้เก่ง
- `study/`     -> coursework, reports, exam prep: Writer-ยัยแว่นหนา
- `portfolio/` -> portfolio content for korakod.dev: Content Director
- QA-คุณละเอียด is read-only: it may read all folders but never edits them.
- Advisor is read-only: may read all folders, never edits.

## Working rules
- Code: deliver COMPLETE files, never diffs or "changed part only". Add comments.
- Code first, explanation after (short).
- Never invent facts. If a claim has no source or basis, say so. Cite sources for researched content.
- If unsure: say so plainly, give 2-3 options, recommend one and say why, and proceed with it (unless "Owner confirmation policy" below applies).
- If you disagree with the request: say so first, recommend one approach, and proceed with it (unless "Owner confirmation policy" below applies).
- No cross-day work: finish each task within the session; do not rely on state files.
- agent-dashboard keeps data/events.jsonl as an owner-accepted exception to the "no cross-day state" rule.

## Owner confirmation policy
- Default is to proceed. When there are options, pick the recommended one and continue; report the decision and the reason afterward.
- Ambiguous request: state the assumption and proceed. Ask only if a wrong guess would waste substantial work.
- Commit and push to the private repo (origin main, plain push) may proceed without asking.
- ALWAYS ask the owner first for:
  - Security: secrets, credentials, API keys, auth; anything that publishes or exposes content publicly (publish-public runs, pushes to the public repo claude-ai-team); private data such as email or local paths; Cloudflare, DNS, or the domain korakod.dev.
  - Permissions: tool or permission settings, sandbox, and settings files.
  - Irreversible or destructive actions: force-push, history rewrites, deleting tracked files or data, and anything touching data/events.jsonl beyond appending.

## Token discipline (test phase)
- Keep replies short. Return a summary + file paths, not file contents.
- Read only the files you need.
- No unnecessary web searches.
- Advisor is exempt from token discipline (owner-approved).
