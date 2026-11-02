# Contributing

Thanks for your interest in DTA-Luchs. This file describes how a contribution gets into the repo. How the code looks is in `CONVENTIONS.md`.

## Bugs and requests

Report a bug or a request as an issue, in English or German; the templates ask for what helps. For a bug that is what you did, what you expected and what happened instead, plus the firmware version of the controller and the version of DTA-Luchs. Attach a DTA file only if you want to share it: it contains the readings of your heat pump.

## Pull requests

- For a larger change (new behavior, API, field catalog, new dependency) open an issue first, so we can agree on the approach.
- One pull request, one thing. The title says what is different now, the description why.
- `./dtaluchs check` must be green. It is the one command CI runs as well. Run `uv sync` in `backend/` and `npm install` in `frontend/` once beforehand.
- A new test must bite: break the rule once on purpose and see it turn red.
- If the user interface changes, add a screenshot to the pull request.
- Pull requests are merged by squash. You stay the author of the commit.

## Field catalog and domain knowledge

A domain statement, such as what a raw field means, its unit or its factor, needs a source (`CONVENTIONS.md` §6): the manufacturer's manual with document, edition and page, an own measurement with date and method, or another open source project with file, line and commit. Name the source in the pull request; `fields.yaml` itself does not list sources. Without a source, an empty field is better than a guessed one.

## What does not belong in the repo

DTA files from your heat pump, Parquet and DuckDB files, `dtaluchs.toml` and `.env`.

## License

By contributing, you license your contribution under the project's license, Apache-2.0.
