# Contributing to rimmerge-rules

## What belongs here, and what doesn't

A rule goes in this repository **only if
[RimSort's community-rules format](https://github.com/RimSort/Community-Rules-Database)
cannot express it.** That format covers `loadAfter`/`loadBefore`/
`loadTop`/`loadBottom`/`incompatibleWith` per `packageId` — every plain
load-order pair. It cannot express:

- a **precedence rule** (which def type has a verified rule for
  resolving a multi-owner conflict, and what that rule is),
- a **patch-operation class → behaviour mapping** (a custom
  `PatchOperation` subclass's real runtime effect),
- a **def-cache-carrier** (a plugin that isn't a mod at all, detected by
  a dropped DLL and a log line prefix),
- a **log shape** (a game-log line format that a mod, not the game,
  prints: a stack-trace block, a fallback line, a back-reference stub,
  written as a format template; see the README's
  [Log-shape templates](README.md#log-shape-templates)), or
- a **tag rule** (a signal that earns a mod a framework/category tag).

**A note on `tag-rules.json` specifically**: Rimmerge parses and
validates this section today, but nothing in Rimmerge consumes it yet —
there is no import path from this source into a profile's `rules.json`,
unlike the community and Steam Workshop databases. A row you add here
is validated and shipped, but currently has **no effect** on anything
Rimmerge does. It's still worth contributing if you have a well-evidenced
signal worth capturing ahead of that importer existing — just don't
expect it to change anyone's sort order today.

If what you want to contribute is "mod A should load before/after mod
B", **please open a PR against
[RimSort/Community-Rules-Database](https://github.com/RimSort/Community-Rules-Database)
instead** — Rimmerge reads that database too, and duplicating a plain
pair here would just be two sources of truth for the same fact.

## Evidence is required, every row

Every row in every section requires an `evidence` field (a `patch-operations`/
`def-cache-carriers`/`log-shapes` row) or an `evidence` object with `source` and
`verified` (a `precedence` row). "I tested it and it worked" is not
evidence on its own — what we're asking for is *how you know*, so a
future contributor (or a Rimmerge maintainer, or you in a year) can
re-verify it without re-discovering your reasoning from scratch. Good
evidence looks like:

- **Decompiled source**, named precisely: the assembly, the version, the
  class and method (`"decompiled ExampleFramework 1.6,
  GroupDef_Helper.GetGroupDefInternal"`).
- **IL inspection**, when decompilation is ambiguous or the method is a
  transpiler: name the assembly and what you inspected
  (`"IL-verified: RR.PatchOperationCustomBase::Skip"`).
- For a `log-shapes` row: the decompiled assembly, its version, and the
  class and method that write the line (`"ExampleLogger.dll 2.1.0,
  decompiled with ilspycmd 8.2.0.7535, ExampleLogger.Reporter.PrintStub
  writes $\"[Ref {id:X}] ...\""`), so the exact wording can be
  re-checked. Copy the format string, not a sample line: a sample shows
  one path or id, the format string shows what varies. When an assembly
  carries no real version (for example 1.0.0.0 on every build), name its
  sha256 instead, so the exact build can still be found.
- For a `precedence` row specifically: the `verified` date (when you
  checked it against source), and ideally a `note` explaining the rule
  in plain language, not just its shape.

A row backed only by "seems to work in my load order" will be asked to
provide a decompiled/IL citation before merge, or redirected to the
community-rules pair-database if it turns out to be a plain load-order
fact after all.

## Before you open a PR

1. Edit exactly one file under `data/` (or add rows to more than one, if
   your change genuinely spans sections — most PRs touch one).
2. Validate your change against its schema and rebuild the bundle:

   ```sh
   bun scripts/build.mjs
   ```

   Commit both the `data/*.json` change and the regenerated
   `rimmerge-rules.json` — CI rejects a PR where they've drifted apart
   (`.github/workflows/validate.yml`).
3. Fill in the PR template's evidence section. A row with no evidence,
   or evidence that's just "trust me", will not be merged.

## Removing or changing a row

Precision matters here more than most repositories: this file gets
embedded into released Rimmerge binaries (see the root
[README.md](README.md#how-rimmerge-uses-this-file)). Changing what an
existing key *means*, or narrowing a `match`/`behaviour` value's
meaning, can silently change what an already-released binary predicts.
When in doubt, add a new, more specific row rather than editing an
existing one's meaning, and say so in your PR description.

## License

By contributing, you agree your contribution is released under
[CC0 1.0 Universal](LICENSE) — the same license as the rest of this
repository. Don't submit anything you don't have the right to place in
the public domain (a decompiled snippet quoted verbatim at length may
not qualify; a plain-language description of what the code does
always does).
