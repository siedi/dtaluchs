# Conventions

How the code of DTA-Luchs looks. The rules apply to every contribution; whatever can be checked, `./dtaluchs check` checks (§9). How a contribution gets into the repo is in `CONTRIBUTING.md`.

## 1. Language and writing

- **English:** code and everything public that addresses developers. Code means identifiers, docstrings, comments (also in `Dockerfile`, `compose.yaml`, configuration files and workflows), test names, log messages, API paths and field names in JSON. Public for developers means `CONVENTIONS.md`, `CONTRIBUTING.md`, issue templates and the commits in the public repo.
- **Values in code are English too:** states, keys and file names in `backend/src` and `frontend/src`.
- **German:** the user interface, `detail` texts of errors (the frontend shows them), documentation for users (`README.md`, the docs of the Home Assistant app, guides under `docs/`), internal commits and documents. Technical terms stay English.
- **Write briefly, each statement in one place.** Guidelines, deviation allowed:

  | Kind of text | Guideline | What belongs there |
  |---|---|---|
  | Comment | 1 to 3 lines | the why that the code does not show |
  | Docstring | 1 sentence | what the function does |
  | Commit | subject, at most 3 lines of body | what is different now and why |

- **Markdown without hard line breaks:** a paragraph is one line, so is a list item. Separate lines only for headings, table rows, list items and code blocks. This holds even where an older file is still wrapped.
- No history in the code. Date, case and symptom belong in the commit.

## 2. Names

| Context | Convention | Example |
|---|---|---|
| Python modules, functions, variables | `snake_case` | `field_catalog.py`, `merge_records` |
| Python classes, pydantic models | `PascalCase` | `DtaHeader`, `SeriesResponse` |
| Python constants | `UPPER_SNAKE` | `MISSING_DATA_GAP` |
| TS components, types | `PascalCase` | `SeriesChart.tsx` |
| TS functions, variables, hooks | `camelCase`, hooks with `use` | `useSeries` |
| DB tables and columns | `snake_case`, tables in plural | `imported_files`, `gaps` |
| API routes | `/api/<resource>`, plural, kebab | `/api/stats/daily` |
| Field IDs in the catalog | `snake_case`, English | `t_flow`, `compressor_on` |

No abbreviations except established ones (`db`, `id`, `sql`, `api`) and the Luxtronik abbreviations from the field catalog (`vd`, `hup`, `zwe`, `evu`).

Two files in one folder never differ only in case (`Band.tsx` next to `band.ts`); macOS does not tell them apart, tsc reports TS1261.

## 3. Backend

- **`core/` is the core.** All domain logic lives there exactly once. `core` never imports `api` or `cli`; import-linter checks this. If the same logic is in a router and the CLI, it belongs in `core`.
- **Routers are plain HTTP adapters:** validate the request, call the core, return the response model. No SQL in a router; `.execute(...)` belongs in a `store` or `query` module.
- **Nothing blocks the event loop.** An `async def` contains only awaitable calls. DuckDB, file access and expensive computation run in `def` or `asyncio.to_thread`. An `async def` that opens a DuckDB connection is a bug. The Ruff rule set `ASYNC` checks this.
- **Only the core opens connections:** `core/stock/meta.py` read-only on `meta.duckdb`, `core/query/source.py` through the in-memory DuckDB (`core/duck.py`) on the partitions, `core/store/migrations.py` writing to `meta.duckdb`, `core/store/partition.py` when writing partitions. The API passes on `data_dir` from `get_plant` (`api/deps.py`) and never opens anything itself; in tests `data_dir` points to a folder of its own.
- **Dependencies without I/O are `async def`** (`api/deps.py`), because a `def` takes a slot in the thread pool on every request. A dependency with file or DuckDB access stays `def`.
- **The core names errors** (`core/errors.py`: `NotFound`, `Invalid`, `Unavailable`). An `exception_handler` translates them into HTTP.
- **Separate computing from writing.** First plan on a read connection (`plan_…`), then write in a short write window (`persist_…`).
- **One writer.** Only the import writes, serially. The API opens DuckDB `read_only`.
- **Size guardrails**, a hint rather than a ban: split a module over 400 lines the next time you touch it, extract a function over 60 lines or 15 branches. This holds for `.ts` and `.tsx` too; `./dtaluchs check` reports Python only (`backend/scripts/size_hints.py`).

## 4. API

- **`response_model` is mandatory.** No endpoint returns a `dict`. Models live in `api/schemas/`. Exception: `core/views/model.py` is also the response model, because a saved view has the same shape as the response.
- **OpenAPI is the contract.** `frontend/openapi.json` and `frontend/src/lib/api-types.ts` are generated from it and checked in. `./dtaluchs check` regenerates both and compares byte for byte. A new field starts in the pydantic model, never in the frontend first.
- **The server checks time ranges.** An endpoint with `from`/`to` rejects nonsensical or too large ranges with 422 before it loads anything. A date field fires on every keystroke.
- **`status_code` explicitly** wherever it is not 200.

## 5. Data and DuckDB

- **Raw values stay raw.** Parquet holds `ts`, `layout_id`, every value as int32 and every bit as BOOLEAN. Factors and units come from the field catalog when reading. Exception: the input bits of DTA 8209, which are stored inverted in the file, are saved by the import with their meaning, as in 9003.
- **Bump `READER_REVISION`** when the parser stores different values for the same file (`core/dta/reader.py`). It is part of the fingerprint, so the next import rebuilds the stock. No test notices if you forget.
- **Write Parquet atomically:** to a temporary file, then rename.
- **`meta.duckdb` is created only by the migration runner** (`core/store/migrations.py`, table `meta(schema_version)`, steps in ascending order in one transaction, additive). `read_only` never applies migrations.
- **Never guess the schema:** `DESCRIBE <table>` against the database.
- **Never open `meta.duckdb` as a plain file** while the process has DuckDB open on it, not even under a second name (hard link). When the process closes that descriptor, the lock of the open instance is gone: another process can write, and the reader reads foreign blocks until FATAL. Size and time of the file come from `stat`.
- **Integer division means `//`.** In DuckDB `/` is floating point even for integers, and the cast afterwards rounds. This affects every bucket calculation.
- **Time:** `ts` is Unix seconds, as the controller writes it.
- **Write several rows** with `con.register(name, {column: np.ndarray})` and `INSERT … SELECT`, never with `executemany`. A Polars DataFrame cannot be registered in DuckDB without `pyarrow`.

## 6. Field catalog and domain knowledge

- **Every domain statement needs a source:** the manufacturer's manual (document, edition, page), an own measurement with date and method, or another open source project (project, file, line, commit; not confirmed by the manufacturer). No source, no statement; an empty field is better than a guessed one. The pull request names the source; in the repo the project keeps it separate from `fields.yaml`.
- **Every threshold of a finding states its origin:** a decision (name, date) or a derivation from a measurement. A derivation says which freedom it takes.
- **Unknown fields** are shown with their raw name and file factor, never dropped.
- **Every factor has a plausibility range.** A test checks it against the own DTA files when `LUX_DTA_DIR` is set; the project also checks it against files from other installations. So a range must fit every installation, not just your own.

## 7. Frontend

- **Folders:** `src/app/` (shell, navigation, routes), `src/features/<feature>/`, `src/shared/` (shared domain building blocks), `src/components/` (shared UI), `src/lib/` (technology without domain knowledge: HTTP, query client, i18n, shared types). Imports only go downwards, never between features. What belongs to a feature stays in the feature. The order is `app > features > shared > components > lib`; `locales` imports nothing from `src` and may be read by `lib` and everything above, subfolders of one feature may import each other. Checked by `src/layers.test.ts` (Vitest, so `./dtaluchs check`), without test files.
- **One place per resource:** what several features need about the same API resource (query, types, keys) lives once in `shared/<resource>/`, for example `shared/import/`.
- **`components/ui/` is our own code.** shadcn generated the files once; since then they are maintained here. Never `shadcn add --overwrite`, it replaces our changes.
- **Per feature** `types.ts`, `api.ts` (communication only), `queries.ts` (TanStack Query hooks), then page and components. `api.ts` and `queries.ts` stay separate.
- **Import order:** external packages first, then `@/…`, then `../…`, then `./…`. Within each group by name or path in code point order: uppercase before lowercase, a shorter path before a longer one with the same beginning. An import only for its side effect (`import "./index.css"`) stays where it is, because its position can matter, and splits the imports into sections, as does any other statement between two imports; ordering happens within a section. Exempt is `components/ui/` (code from shadcn). Python imports are ordered by Ruff (§9). Checked by `./dtaluchs check`.
- **Server state only through TanStack Query**, never mirrored in `useState`. Stock data is valid until the next import (`staleTime: Infinity` in `lib/query-client.ts`); the import invalidates it. A query that must see changes from outside (status, views) sets `staleTime: 0` and `refetchOnWindowFocus: true` itself.
- **One HTTP helper** in `lib/http.ts`, which throws `ApiError` with the German `detail`.
- **Design tokens instead of hex values**, traffic light `--ok`, `--warn`, `--crit`. One toast system.
- **No action without feedback**, errors included, never silent. No second click while it runs.
- **Separate input from execution:** fields that trigger an expensive query fill a draft; only a button or Enter runs it.

## 8. Tests

- **Backend:** `backend/tests/NN_<topic>_test.py`, `NN` unique; find the highest number numerically. Shared fixtures in `conftest.py` (migrated temp database, `api_client` with `httpx` over `ASGITransport`). API tests go through HTTP.
- **Test data:** synthetic DTA files under `backend/tests/data/synthetic/`, written by `backend/tests/synthetic_support.py`; a test keeps the folder equal to its output. Never put your own DTA files in the repo. Tests over the own stock run only when `LUX_DTA_DIR` is set and are absent from CI.
- **Frontend:** Vitest only for pure functions (`<module>.test.ts` next to the module), no jsdom. Playwright checks the user interface with screenshots.
- **No expectation that depends on the clock.** The clock is passed in. The machine time zone of test runs is `America/New_York` and fixed; it differs from the zone of the installation (`Europe/Berlin`), so code that reads the machine zone instead of the installation's zone turns red. Backend: `conftest.py`, frontend: `npm run test`.
- **A new test must bite:** break the rule once on purpose and see it turn red.

## 9. Tools

- **`./dtaluchs check` is the one command before every commit**, and CI runs exactly this command. Stages: `ruff check`, `ruff format --check`, `mypy`, import boundary, `pytest -n auto`, `tsc -b`, ESLint, import order, Vitest (including the check of the layer rule, §7), library (build of the library `@dtaluchs/core`), API contract, `npm audit --omit=dev` (any finding for the runtime packages turns the check red; if the query itself fails on the network or the registry (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, HTTP 5xx), it stays a hint without red, any other npm error is red; tools like `shadcn` do not belong in `dependencies`). Also, as a hint without red: the size guardrails (§3).
- **Ruff** is linter and formatter. What Ruff formats, holds. Rule sets: `E`, `W`, `F`, `I`, `UP`, `B`, `SIM`, `RET`, `C4`, `PTH`, `ASYNC`, plus `DTZ` (helps with §8 but does not enforce it: it reports `datetime(...)` and `now()` without a zone, not `replace(tzinfo=None)`; an intended time without a zone in `src` only with `# noqa: DTZ001 - <reason>` on exactly that line, in `tests/` `DTZ001` is off), `PERF` and `RUF`. `RUF001` and `RUF003` are off, because German quotation marks and `×` are intended.
- **ESLint** (`frontend/eslint.config.js`, type-checked through `tsconfig.app.json`) checks only what `tsc` does not see, as errors: `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/no-deprecated`. No `strictTypeChecked`, no compiler rules from `react-hooks`. ESLint checks only `frontend/src/`, without `lib/api-types.ts` and `components/ui/` (generated); it deliberately does not check `scripts/`. A promise nobody awaits gets `void`.
- **mypy strict, without exception lists.** If a spot does not work, `# type: ignore[code]` on exactly that line, with a reason.
- **Python version only in `backend/.python-version`.**
- Always run Python through `uv run` from `backend/`, never `python3` directly.

## 10. Configuration

- **`dtaluchs.toml`** for what does not change during operation: paths, port, interval. Environment variables take precedence. `dtaluchs.example.toml` is in the repo, `dtaluchs.toml` never.
- **`.env`** only for tokens. `.env.example` is in the repo, `.env` never.
- **Presentation** (colors, saved views) does not belong in `.env`, but later in an override layer of its own per installation.
- **A domain value** (threshold of a finding) is not configuration, but code or a rule catalog with a source (§6).
