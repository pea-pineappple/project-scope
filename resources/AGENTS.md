# AGENTS.md — Project Scope analysis contract (한국어: `AGENTS.ko.md`)

After analyzing source code, the local AI agent records its results in the
contract below. This file is the single contract the agent (Claude Code etc.)
reads — everything the extension displays comes from these records.

## Where to write

    <workspace>/.scope/analysis.jsonl

- JSON Lines format. **One line = one analysis record.**
- Append-only. To re-analyze an existing target, append a new line
  (the last line for a target wins — never edit or delete older lines).
- If a function/class **disappeared from the source**, append a deletion marker:
  `{"v": 1, "target": "func:src/a.ts:old", "deleted": true, "generatedAt": "…"}`
  (if the same target is recorded again later, it reappears)

## Record schema

One JSON object per line:

    {
      "v": 1,
      "target": "func:src/services/core.py:build_slice",
      "kind": "func",
      "name": "build_slice",
      "file": "src/services/core.py",
      "line": 186,
      "endLine": 214,
      "lang": "python",
      "srcHash": "a3f9c1d2e4b5",
      "summary": "One-paragraph summary of what this does",
      "params": ["idx", "seed", "max_depth"],
      "calls": ["_resolve", "node_key"],
      "calledBy": ["internal_calls"],
      "imports": [{"module": ".util", "names": ["node_key"]}],
      "model": "claude-sonnet-4-5",
      "generatedAt": "2026-10-12T09:30:00Z"
    }

## Field rules

| Req | Field | Rule |
|---|---|---|
| Y | v | Schema version, always 1 |
| Y | target | Unique key `<kind>:<file>:<qual>`. kind is `func` or `class`; qual rules below |
| Y | kind | func \| class |
| Y | name | Symbol name = **last segment of qual only** (`Invoice.Total` → `Total`) |
| Y | file | Workspace-relative path, `/` separators |
| Y | line / endLine | Definition start/end lines (1-based) |
| Y | lang | python, typescript, go … |
| Y | srcHash | **sha1 of the function body text, first 16 chars.** Body = lines `line..endLine` of file joined with `\n` after stripping trailing `\r` (LF files: as-is) |
| Y | summary | LLM summary. Match the language of the code's comments/docstrings |
| N | params | Parameter name array |
| N | calls | Project-internal functions called in the body. Keep the qualifiers as written (`Invoice.Total`, `math::normalize`, `util.node_key`) — used to disambiguate same-named functions |
| N | calledBy | Project-internal callers (the extension back-fills from `calls` if omitted) |
| N | imports | This file's imports. Array of `{"module", "names"?, "alias"?}` — see below |
| N | ns | Namespace / package / module of this symbol (C# `Shop.Billing`, C++ `math`, Java `com.shop`) |
| N | entry | `true` if a framework/runtime entry point (route handler, callback, event handler) — excluded from orphan detection |
| N | model | Model used to produce the summary |
| Y | generatedAt | ISO 8601 UTC |

## qual rules

- Class methods: `Class.method` (nested classes: `Outer.Inner.method`)
- Functions nested in functions: `outer.<locals>.inner` (like Python `__qualname__`)
- Separator is always `.` regardless of language — C++/Rust `::` becomes `.`
- Namespaces/packages are NOT part of qual; put them in `ns`

## imports — resolving same-named functions

The extension reads import statements directly (`import`, `from … import`,
`using`, `#include`, `use`, Go `import`) to decide which same-named function is
called. Only where it cannot (macros, generated code, path aliases in build
config) should the agent add `imports`.
**Merging is per-file, so one record for the file is enough.**

| Language | module notation | Example |
|---|---|---|
| Python | dotted, leading dot for relative | `{"module": ".core", "names": ["node_key"]}` |
| TS / JS | the import string as written | `{"module": "../render", "names": ["blankCell"]}`, `{"module": "./cell", "alias": "cells"}` |
| C# / Java | namespace / package | `{"module": "Shop.Billing"}` |
| C / C++ | include path or namespace | `{"module": "math/vec.h"}`, `{"module": "math"}` |
| Rust | use path | `{"module": "crate::net::parse", "names": ["parse"]}` |
| Go | import path | `{"module": "example.com/proj/math", "alias": "m"}` |

- No `names` = whole module (`using`, `#include`, `use x::*`)
- `alias` is an alias of the module itself (`import * as cells`, `using R = Shop.Report`)
- A bare string is also valid: `"imports": ["Shop.Billing", "math/vec.h"]`

## Notes

- Do not analyze files under `.scope/`
- Do not copy code into the record beyond `summary` — the extension reads the real source
- For classes: kind=class; `params/calls/calledBy` may be omitted
- New fields (`imports`, `ns`, `entry`) are all optional — existing records stay valid
