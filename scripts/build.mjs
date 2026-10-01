#!/usr/bin/env bun
// Builds rimmerge-rules.json from data/*.json, validating each section
// against its own schema/*.schema.json first.
//
// Run with `bun scripts/build.mjs` from the repo root (or anywhere —
// paths below are resolved relative to this file, not the cwd). Pass
// `--check` to build into memory and fail instead of writing, comparing
// the result against the committed rimmerge-rules.json byte for byte —
// that's what `.github/workflows/validate.yml` runs, so a contributor who
// edits a data/*.json file without re-running this script (without
// `--check`) fails CI with the exact same message they'd see locally.
//
// Deterministic by construction: every section is written with the same
// fixed top-level key order it's read in (schema, precedence,
// patch_operations, def_cache_carriers, tag_rules, log_shapes), `JSON.stringify`'s own
// key order (insertion order, which is what `JSON.parse` produces for a
// plain object) is never reshuffled, indentation is a fixed two spaces,
// and the file is written with LF line endings and exactly one trailing
// newline — no locale-, timezone-, or platform-dependent input reaches
// the output at all.
//
// Every run starts with `selfTest()`, which proves against the real,
// committed schemas that the validator actually rejects what it claims
// to — see that function's own doc comment.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const SCHEMA_DIR = join(ROOT, "schema");
const BUNDLE_PATH = join(ROOT, "rimmerge-rules.json");

// Section name (as it appears in data/<name>.json and schema/<name>.schema.json)
// -> the envelope key it's nested under. Order here is the envelope's own
// committed key order.
const SECTIONS = [
  ["precedence", "precedence"],
  ["patch-operations", "patch_operations"],
  ["def-cache-carriers", "def_cache_carriers"],
  ["tag-rules", "tag_rules"],
  ["log-shapes", "log_shapes"],
];

function readJson(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

// -- a minimal JSON Schema validator -----------------------------------
//
// Supports exactly the keywords this repo's own schema/*.schema.json
// files use: $schema, $id, title, description (documentation only,
// never checked), type, required, properties, additionalProperties
// (boolean or a schema applied to every property not named in
// `properties`), items, enum, minItems, minimum, pattern. Not a
// general-purpose validator — there is no $ref, no oneOf/anyOf, no
// format. That's a deliberate scope limit: every schema in this repo is
// self-contained and was written against exactly this subset, so a
// fuller (dependency-pulling) validator would buy nothing a
// contributor's own PR review doesn't already cover.
//
// `checkSchemaKeywords` is the enforcement for that scope limit: it
// walks a *schema* (not the data) and throws on any keyword outside
// `KNOWN_SCHEMA_KEYWORDS`, so a schema author who reaches for `oneOf`/
// `$ref`/`format` — none of which `validate` below actually implements
// — gets a loud failure instead of a validator that silently pretends
// to check something it doesn't.

const KNOWN_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "enum",
  "pattern",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "minimum",
]);

function checkSchemaKeywords(schema, path) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KNOWN_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(
        `${path}: unsupported JSON Schema keyword "${key}" — this validator only ` +
          `implements ${[...KNOWN_SCHEMA_KEYWORDS].join(", ")}`,
      );
    }
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    checkSchemaKeywords(sub, `${path}.properties.${key}`);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    checkSchemaKeywords(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.items) {
    checkSchemaKeywords(schema.items, `${path}.items`);
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "number" ? "number" : typeof value;
}

function validate(value, schema, path, errors) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const matches =
      types.includes(actual) || (types.includes("number") && actual === "integer");
    if (!matches) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${actual}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
  }

  if (
    (typeOf(value) === "number" || typeOf(value) === "integer") &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
  }

  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, propValue] of Object.entries(value)) {
      if (known.has(key)) {
        validate(propValue, schema.properties[key], `${path}.${key}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validate(propValue, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  if (typeOf(value) === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, errors));
    }
  }
}

function schemaFor(name) {
  const schema = readJson(join(SCHEMA_DIR, `${name}.schema.json`));
  checkSchemaKeywords(schema, name);
  return schema;
}

function validateSection(name, data) {
  const errors = [];
  validate(data, schemaFor(name), name, errors);
  if (errors.length > 0) {
    throw new Error(`data/${name}.json failed schema validation:\n  ${errors.join("\n  ")}`);
  }
}

function buildBundle() {
  const bundle = { schema: 1 };
  for (const [fileStem, envelopeKey] of SECTIONS) {
    const data = readJson(join(DATA_DIR, `${fileStem}.json`));
    validateSection(fileStem, data);
    if (fileStem === "log-shapes") {
      const errors = logShapeLimitErrors(data);
      if (errors.length > 0) {
        throw new Error(
          `data/${fileStem}.json breaks a limit Rimmerge enforces:\n  ${errors.join("\n  ")}`,
        );
      }
    }
    bundle[envelopeKey] = data;
  }
  return bundle;
}

function render(bundle) {
  // `JSON.stringify`'s own two-space form, then a single trailing
  // newline — never `\r\n`, matching this repo's own LF convention.
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// -- log-shape limits ----------------------------------------------------------
//
// The schema's `pattern` keyword counts UTF-16 code units and knows nothing
// about placeholders, so it cannot state the limits Rimmerge applies when it
// loads a `log-shapes` row (`ports/log_shapes.rs` in the Rimmerge repo). This
// mirrors them, so CI rejects exactly what the binary would drop: a template
// of at most 512 UTF-8 bytes, at most 8 placeholders, at least 4 bytes of
// literal text, the `{name:type}` grammar with `{{`/`}}` as literal braces,
// each field's required captures, at most 8 rows per role, and ids and plain
// strings within their byte limits. Keep it in step with that file.
const MAX_TEMPLATE_BYTES = 512;
const MAX_PLACEHOLDERS = 8;
const MIN_LITERAL_BYTES = 4;
const MAX_ROWS_PER_ROLE = 8;
const MAX_ROW_ID_BYTES = 64;
const MAX_MARKER_BYTES = 32;
const PLACEHOLDER_TYPES = new Set(["text", "token", "int", "hex"]);
const PLACEHOLDER_NAME = /^[a-z][a-z_]{0,31}$/;

// Role -> template field -> the placeholders it must capture.
const LOG_SHAPE_ROLES = {
  patch_stack_blocks: { start: ["mod"], end: [], trailer: ["path"] },
  texture_fallbacks: {
    head: ["path"],
    dimensions: ["path", "width", "height", "format"],
    trailer: [],
  },
  stack_back_references: { original: ["id"], stub: ["id"] },
};

const utf8Length = (text) => new TextEncoder().encode(text).length;

// Parses a template the way `LogTemplate::parse` does. Returns
// `{ names }` (the placeholder names, in order) or `{ error }`.
function parseTemplate(text) {
  if (text.length === 0) return { error: "the template is empty" };
  const bytes = utf8Length(text);
  if (bytes > MAX_TEMPLATE_BYTES) {
    return { error: `the template is ${bytes} bytes; the limit is ${MAX_TEMPLATE_BYTES}` };
  }
  const chars = [...text];
  const names = [];
  let literalBytes = 0;
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    index += 1;
    if ((char === "{" || char === "}") && chars[index] === char) {
      index += 1;
      literalBytes += 1;
    } else if (char === "}") {
      return { error: "the template has an unbalanced brace" };
    } else if (char === "{") {
      let body = "";
      for (;;) {
        const next = chars[index];
        index += 1;
        if (next === "}") break;
        if (next === undefined || next === "{") {
          return { error: "the template has an unbalanced brace" };
        }
        body += next;
      }
      const colon = body.indexOf(":");
      const name = colon < 0 ? "" : body.slice(0, colon);
      if (colon < 0 || !PLACEHOLDER_NAME.test(name)) {
        return { error: `malformed placeholder \`${body}\`` };
      }
      const type = body.slice(colon + 1);
      if (!PLACEHOLDER_TYPES.has(type)) {
        return { error: `unknown placeholder type \`${type}\`` };
      }
      if (names.includes(name)) return { error: `duplicate placeholder name \`${name}\`` };
      names.push(name);
    } else {
      literalBytes += utf8Length(char);
    }
  }
  if (names.length > MAX_PLACEHOLDERS) {
    return {
      error: `the template has ${names.length} placeholders; the limit is ${MAX_PLACEHOLDERS}`,
    };
  }
  if (literalBytes < MIN_LITERAL_BYTES) {
    return {
      error: `the template has ${literalBytes} bytes of literal text; at least ${MIN_LITERAL_BYTES} are needed`,
    };
  }
  return { names };
}

function plainStringErrors(value, path) {
  const bytes = utf8Length(value);
  return bytes >= 1 && bytes <= MAX_MARKER_BYTES
    ? []
    : [`${path}: must be 1 to ${MAX_MARKER_BYTES} bytes, got ${bytes}`];
}

function logShapeRowErrors(row, fields, path) {
  const errors = [];
  if (utf8Length(row.id) > MAX_ROW_ID_BYTES) {
    errors.push(`${path}.id: over ${MAX_ROW_ID_BYTES} bytes`);
  }
  for (const [field, required] of Object.entries(fields)) {
    const parsed = parseTemplate(row[field]);
    if (parsed.error !== undefined) {
      errors.push(`${path}.${field}: ${parsed.error}`);
      continue;
    }
    for (const name of required) {
      if (!parsed.names.includes(name)) errors.push(`${path}.${field}: must capture \`${name}\``);
    }
  }
  if (row.xpath_detail_prefix !== undefined) {
    errors.push(...plainStringErrors(row.xpath_detail_prefix, `${path}.xpath_detail_prefix`));
    for (const marker of ["match", "nomatch"]) {
      errors.push(
        ...plainStringErrors(row.branch_markers[marker], `${path}.branch_markers.${marker}`),
      );
    }
  }
  return errors;
}

// Every limit violation of a schema-valid `log-shapes` section.
function logShapeLimitErrors(data) {
  const errors = [];
  for (const [role, fields] of Object.entries(LOG_SHAPE_ROLES)) {
    const rows = data[role];
    if (rows.length > MAX_ROWS_PER_ROLE) {
      errors.push(`${role}: ${rows.length} rows; the limit is ${MAX_ROWS_PER_ROLE}`);
    }
    rows.forEach((row, index) => {
      errors.push(...logShapeRowErrors(row, fields, `${role}[${index}]`));
    });
  }
  return errors;
}

// -- self-tests -----------------------------------------------------------
//
// Proves the validator actually rejects what it claims to, against the
// real, committed schemas — not just that it accepts what's already
// valid. Runs unconditionally, before either `--check` or a real build,
// so a validator regression (e.g. `minimum` silently stops being
// enforced) fails loudly instead of only being noticed the next time
// someone happens to submit bad data.
function expectRejected(caseName, data, schemaName) {
  const errors = [];
  validate(data, schemaFor(schemaName), schemaName, errors);
  if (errors.length === 0) {
    throw new Error(
      `self-test failed: "${caseName}" should be rejected by ${schemaName}.schema.json, ` +
        "but the validator accepted it",
    );
  }
}

function selfTest() {
  // Every section's own `schema` field carries `"minimum": 1` — `0` must
  // fail it, proving `minimum` is actually enforced and not merely
  // documented in this file's own doc comment.
  expectRejected("schema: 0", { schema: 0, rules: {} }, "precedence");

  // `rules/schema/patch-operations.schema.json`'s `match` enum is
  // exactly `["suffix", "prefix"]` — `ClassMatch::from_wire`
  // (`crates/rim-merge/src/patch_behaviours.rs`) implements only those
  // two, so a hypothetical third mode like `"exact"` must fail here
  // rather than silently ship a row this binary can never match.
  expectRejected(
    "match: exact",
    {
      schema: 1,
      classes: [
        {
          class: "Example.PatchOperationFoo",
          match: "exact",
          behaviour: "add_or_replace",
          evidence: "self-test fixture",
        },
      ],
      gates: [],
    },
    "patch-operations",
  );

  // `log-shapes` rows are format templates; the only recogniser
  // language Rimmerge implements is `"template"`, so a raw-regex mode
  // must fail here rather than ship a row no binary will read.
  expectRejected(
    "log shape match: regex",
    {
      schema: 1,
      patch_stack_blocks: [],
      texture_fallbacks: [
        {
          id: "self-test",
          match: "regex",
          head: "x {path:text}",
          dimensions: "x {path:text}",
          trailer: "y",
          evidence: "self-test fixture",
        },
      ],
      stack_back_references: [],
    },
    "log-shapes",
  );

  // The limits Rimmerge applies to a template are mirrored by
  // `logShapeLimitErrors`; each case below must be rejected for its own
  // reason, and the committed data (checked in `buildBundle`) must not be.
  const stackRow = (overrides = {}) => ({
    id: "self-test",
    match: "template",
    start: "[{mod:text} - start]",
    end: "[end of trace]",
    trailer: "Source:{path:text}",
    xpath_detail_prefix: "xpath=",
    branch_markers: { match: "<match>", nomatch: "<nomatch>" },
    evidence: "self-test fixture",
    ...overrides,
  });
  const shapes = (rows) => ({
    schema: 1,
    patch_stack_blocks: rows,
    texture_fallbacks: [],
    stack_back_references: [],
  });
  const expectLimitError = (caseName, rows, fragment) => {
    const errors = logShapeLimitErrors(shapes(rows));
    if (!errors.some((error) => error.includes(fragment))) {
      throw new Error(
        `self-test failed: "${caseName}" should report "${fragment}", got ${JSON.stringify(errors)}`,
      );
    }
  };
  if (logShapeLimitErrors(shapes([stackRow()])).length > 0) {
    throw new Error("self-test failed: a valid stack block row was rejected");
  }
  const placeholders = [..."abcdefghi"].map((name) => `{${name}:int}`).join(" ");
  // 200 euro signs are 200 UTF-16 units but 600 UTF-8 bytes.
  expectLimitError("over 512 UTF-8 bytes", [stackRow({ end: "€".repeat(200) })], "limit is 512");
  expectLimitError("9 placeholders", [stackRow({ end: `abcd ${placeholders}` })], "9 placeholders");
  expectLimitError("3 literal bytes", [stackRow({ end: "abc" })], "3 bytes of literal text");
  expectLimitError("stray closing brace", [stackRow({ end: "abcd }" })], "unbalanced brace");
  expectLimitError("unterminated placeholder", [stackRow({ end: "abcd {x" })], "unbalanced brace");
  expectLimitError("placeholder without a type", [stackRow({ end: "abcd {x}" })], "malformed");
  expectLimitError("uppercase placeholder name", [stackRow({ end: "abcd {X:int}" })], "malformed");
  expectLimitError("unknown placeholder type", [stackRow({ end: "abcd {x:float}" })], "unknown placeholder");
  expectLimitError("duplicate placeholder", [stackRow({ end: "abcd {x:int} {x:int}" })], "duplicate");
  expectLimitError("missing capture", [stackRow({ start: "[start of trace]" })], "must capture `mod`");
  expectLimitError("9 rows in a role", Array.from({ length: 9 }, () => stackRow()), "9 rows");
  expectLimitError("id over 64 bytes", [stackRow({ id: "i".repeat(65) })], "over 64 bytes");
  expectLimitError("marker over 32 bytes", [stackRow({ xpath_detail_prefix: "x".repeat(33) })], "1 to 32");
  for (const accepted of ["{{end}} of trace", "€€"]) {
    if (logShapeLimitErrors(shapes([stackRow({ end: accepted })])).length > 0) {
      throw new Error(`self-test failed: "${accepted}" must be accepted`);
    }
  }
}

function main() {
  selfTest();

  const check = process.argv.includes("--check");
  const rendered = render(buildBundle());

  if (!check) {
    writeFileSync(BUNDLE_PATH, rendered, "utf8");
    console.log(`wrote ${BUNDLE_PATH}`);
    return;
  }

  let committed;
  try {
    committed = readFileSync(BUNDLE_PATH, "utf8");
  } catch (error) {
    console.error(`${BUNDLE_PATH} does not exist — run 'bun scripts/build.mjs' first`);
    process.exit(1);
  }
  if (committed !== rendered) {
    console.error(
      "rimmerge-rules.json is stale: rebuilding data/*.json produces a different file. " +
        "Run 'bun scripts/build.mjs' and commit the result.",
    );
    process.exit(1);
  }
  console.log("rimmerge-rules.json matches data/*.json — no drift");
}

main();
