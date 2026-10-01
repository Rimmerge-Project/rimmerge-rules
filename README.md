# rimmerge-rules

The mod-specific knowledge [Rimmerge](https://github.com/Rimmerge-Project/rimmerge)
can't derive from a game install on its own: verified precedence rules
for specific def-ownership conflicts, custom `PatchOperation` class
behaviours Rimmerge's `verify` needs to model correctly, def-cache-plugin
detection data, the game-log line formats that mods (not the game) print,
and framework/category tag signals.

A rule goes here **only when RimSort's community-rules format can't
express it**. A plain load-order pair (`loadAfter`/`loadBefore`/
`loadTop`/`loadBottom`/`incompatibleWith`) belongs in
[RimSort's Community-Rules-Database](https://github.com/RimSort/Community-Rules-Database)
instead — see [CONTRIBUTING.md](CONTRIBUTING.md).

## The five sections

`data/` holds five independently authored, independently schema'd files.
Each one degrades on its own: a malformed row in one never invalidates
the others.

| File | Schema | What it says |
| --- | --- | --- |
| `data/precedence.json` | `schema/precedence.schema.json` | Which def type has a verified rule for resolving a multi-owner conflict (e.g. "prefer the def owned outside the framework mod"). |
| `data/patch-operations.json` | `schema/patch-operations.schema.json` | Which custom (non-vanilla) `PatchOperation` classes map onto which modelled behaviour, plus the one known mods-loaded gate, so Rimmerge's replay can model them instead of reporting them `Unsupported`. |
| `data/def-cache-carriers.json` | `schema/def-cache-carriers.schema.json` | Which mods/plugins act as a def-cache plugin (not a normal mod — a startup-time cache rebuilder with no `packageId` of its own), detected by the DLL they drop and the `Player.log` line prefix they write. |
| `data/log-shapes.json` | `schema/log-shapes.schema.json` | The game-log line formats that mods (not the game) print, so `log import` can read them in a `Player.log` or a console snapshot: a patch-reporting mod's stack-trace block, a texture loader's fallback lines, and a patching library's back-reference stubs. Each is a **format template** (literal text plus typed placeholders such as `{path:text}`), never a regex; see [Log-shape templates](#log-shape-templates). |
| `data/tag-rules.json` | `schema/tag-rules.schema.json` | Signals that earn a mod a framework/category tag. Rimmerge parses and validates this section — a malformed row is still caught and reported — but **does not yet consume it anywhere**: unlike the community and Steam Workshop databases, there is no import path from this source into a profile's `rules.json` today, so a row here currently has no effect on anything Rimmerge does. A tag rule you want applied has to be written by hand or inferred, same as before this section existed. |

`scripts/build.mjs` concatenates the five into one committed envelope,
`rimmerge-rules.json`:

```json
{
  "schema": 1,
  "precedence": { "...": "..." },
  "patch_operations": { "...": "..." },
  "def_cache_carriers": { "...": "..." },
  "tag_rules": { "...": "..." },
  "log_shapes": { "...": "..." }
}
```

### Log-shape templates

A template mirrors the format string a mod prints:

```text
template    := ( literal | placeholder )*
placeholder := "{" name ":" type "}"
name        := [a-z][a-z_]{0,31}      unique within a template
type        := text   one or more characters, spaces allowed
             | token  one or more non-space characters
             | int    one or more ASCII digits
             | hex    one to sixteen hex digits
literal     := any text; "{{" and "}}" are literal braces
```

A template matches the whole trimmed line. Literals are matched as
plain text (Rimmerge escapes them, so regex syntax in a literal is just
text), and the four placeholder types are fixed in Rimmerge, so a row can
never add regex behaviour. Limits Rimmerge enforces when it loads a row
(a row over one is ignored with a warning): at most 512 bytes and 8
placeholders per template, at least 4 bytes of literal text, at most 8
rows per role, and at most 32 bytes for the plain strings
(`xpath_detail_prefix`, the branch markers); a row `id` is at most 64
bytes. All of these are counted in UTF-8 bytes and enforced in both
places: `scripts/build.mjs` (so CI rejects a row that breaks one) and
Rimmerge itself (so an older or hostile file still cannot exceed them).
Required placeholders:
`start` needs `mod`; the stack block's `trailer` needs `path`; `head`
and `dimensions` need `path` (and `dimensions` also `width`, `height`
and `format`); `original` and `stub` need `id`. A template with no
placeholder (`end`, a texture `trailer`) is an exact-line match.

Rows live in one array per role (`patch_stack_blocks`,
`texture_fallbacks`, `stack_back_references`); a role an older Rimmerge
does not know is ignored with a warning.

Run it with [bun](https://bun.sh):

```sh
bun scripts/build.mjs          # rebuilds rimmerge-rules.json
bun scripts/build.mjs --check  # validates + fails on drift, no write (what CI runs)
```

`.github/workflows/validate.yml` runs the `--check` form on every PR: it
validates each `data/*.json` file against its own schema and fails if
the rebuilt bundle differs from the committed `rimmerge-rules.json` —
the same "regenerate and diff" shape Rimmerge's own CI uses for its
generated TypeScript bindings.

## How Rimmerge uses this file

Two independent ways, both read-only from this repo's point of view:

1. **Embedded at compile time.** Rimmerge's own repository carries this
   repository as a git submodule at `rules/`, and
   `crates/rim-io/build.rs` embeds `rules/rimmerge-rules.json` straight
   into the compiled binary. That embedded snapshot is what a fresh
   install, an offline run, or a run with the network refresh turned off
   falls back to — there is never a state with *no* knowledge at all,
   only a potentially stale one. **The bundle's shape is therefore a
   compatibility contract with every already-released Rimmerge binary**:
   a new top-level key is fine (an older binary warns and ignores it — see
   "Forward compatibility" below), but changing an existing key's meaning
   or type is not.
2. **Fetched at runtime, manually.** Rimmerge can also fetch this exact
   file over HTTPS, on request only, from:

   ```
   https://raw.githubusercontent.com/Rimmerge-Project/rimmerge-rules/main/rimmerge-rules.json
   ```

   This is the **only** URL Rimmerge ever fetches this data from, it is
   a hardcoded constant (never a setting), and the fetch is capped at
   4 MB. In the **desktop app**, this happens **automatically, once a
   day, at launch** by default — but never before its first-run notice
   is answered — alongside a manual `Refresh` click in the Databases
   card. The **CLI never fetches this on its own**: only when you
   explicitly run `rimmerge db refresh`. Either way, the fetch is
   skipped entirely, before any address is built or connection opened,
   whenever Rimmerge's `allow_network` setting is `false`. A fetched
   copy is cached locally and, section by section, overrides the
   embedded snapshot for that run — see Rimmerge's own
   [`docs/concepts/rules-databases.md`](https://github.com/Rimmerge-Project/rimmerge/blob/main/docs/concepts/rules-databases.md)
   and
   [`docs/privacy-and-network.md`](https://github.com/Rimmerge-Project/rimmerge/blob/main/docs/privacy-and-network.md)
   for the full fetch/cache/import pipeline.

### Forward compatibility

Rimmerge's own parser is deliberately tolerant: an unknown `behaviour`,
`match` mode, `rule` discriminant, log-shape role or placeholder type, or
top-level section key is ignored with a warning, and the rest of the
file still loads. That's what makes
it safe for this repo to add a new row or even a new section ahead of a
Rimmerge release that understands it — a newer data file must never
break an older binary, and an older binary must never pretend it
understood something it didn't.

Tolerance stops at a listed field. A section is read as a whole, so a row
that omits a field the older binary lists as required (for example a
stack block without `branch_markers`) makes that binary drop the entire
section and keep its embedded copy, with a warning. Making a listed field
optional, or removing it, is therefore a breaking change for older
binaries: follow expand, migrate, contract, and keep writing the field
until the releases that need it are gone.

## License

Every file in this repository is dedicated to the public domain under
[CC0 1.0 Universal](LICENSE) — no attribution required, no restriction on
reuse. Vendor this file (or any part of it) into your own tooling
however you like.
