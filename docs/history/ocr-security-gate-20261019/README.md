# OCR security-gate source archive (2026-10-19)

This directory preserves the source-side change that added the automatic
security gate and `/audit` command to the OpenCode plugin of
[alibaba/open-code-review](https://github.com/alibaba/open-code-review).

## Provenance

- Standalone source repository: `https://github.com/eric-stone-plus/open-code-review`
  (archived; not a GitHub fork and has no shared history with upstream).
- Commit: `aafedb10377d2d7b60d6e71cb714037ee620349e`
- Parent: `55450a9` (`ci: enforce PR commit policy (#1775)`)
- Original pre-rebase commit: `ff7e667`
- Patch: `0001-feat-opencode-add-automatic-security-gate-and-audit-command.patch`
- Change size: 6 files, +726/-6.

## What it contains

- `plugins/open-code-review/opencode/open-code-review.ts`: automatic security
  gate after code edits, bounded OCR review, `[security-gate]` note, and stop
  rules.
- `plugins/open-code-review/opencode/test/open-code-review.test.mjs`: gate,
  filtering, and injection tests.
- `plugins/open-code-review/opencode/README.md`: gate documentation.
- `skills/code-audit/SKILL.md`: manual/final audit path.
- `skills/open-code-review/SKILL.md` and
  `skills/open-code-review-delegate/SKILL.md`: skill updates.

## Runtime note

This is **not** the installed runtime. The active OpenCode integration is the
vendored, hardened V2 copy in this repository:

- `bootstrap/plugin/open-code-review.ts`
- `bootstrap/skills-extra/code-audit/SKILL.md`

Those files are installed into the seat and are the source of truth. This patch
is kept for provenance and for reconstructing the standalone OCR source change.

## Apply

On an OCR checkout at `55450a9`:

```bash
git am 0001-feat-opencode-add-automatic-security-gate-and-audit-command.patch
```

or:

```bash
git apply 0001-feat-opencode-add-automatic-security-gate-and-audit-command.patch
```

The standalone GitHub repository was archived and can be deleted; this patch
and the local archive under `~/Documents/Development/archive/open-code-review`
preserve the change.
