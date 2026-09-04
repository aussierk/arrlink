# Contributing to ArrLink

Thanks for taking the time. ArrLink is a single-maintainer homelab project,
so please keep changes focused and be patient with review turnaround.

- **Questions / ideas:** [GitHub Discussions](https://github.com/aussierk/arrlink/discussions)
- **Bugs:** [open an issue](https://github.com/aussierk/arrlink/issues) with
  the bug template
- **Security vulnerabilities:** see [SECURITY.md](SECURITY.md) — not public
  issues

## Development setup

Requires Python 3.12 and Node 22.

```sh
# backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
pre-commit install

# frontend
cd web && npm ci
```

`npm ci` in `web/` is also required before `pre-commit` — the `eslint-web` hook
is type-checked and runs against the installed `web/node_modules`.

## The loop

```sh
ruff check . && ruff format .          # backend lint + format (the CI lint gate)
pytest -q                              # backend tests
cd web && npm run lint                 # type-checked ESLint (also chained into build)
cd web && npm run build                # type-checks (tsc -b) + lint + builds the SPA
```

`pre-commit` runs ruff, prettier, ESLint (`web/`), and basic hygiene checks on
every commit.
The backend test suite needs a Linux toolchain (`uvloop`/`httptools` have no
Windows wheels) — run it in WSL or a container if you're on Windows, or lean
on CI.

## Pull requests

- Branch from `main`; name it for the change (`fix-tag-import`,
  `feat-regex-groups`) — not a bare `fix` or `bug`.
- **PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)**
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`). Release
  notes and version bumps are generated from them, so this matters.
- Keep the PR to one concern. Unrelated churn (reformatting untouched files,
  drive-by renames) makes review harder.
- Fill in the PR template: what changed, why, and how you tested it.
- CI must be green (backend lint/tests, frontend format + lint + build).
- If a change is user-facing, mention it so it lands in the changelog.

## AI-assisted contributions

Using an LLM or AI coding tool as an assistant is fine. Letting one author a
contribution you don't understand is not. This policy follows the spirit of
[Jellyfin's LLM policy](https://jellyfin.org/docs/general/contributing/llm-policies/)
and [Seerr's](https://github.com/seerr-team/seerr/blob/develop/CONTRIBUTING.md).

- **Disclose it.** Note in the PR description that AI assistance was used and
  roughly how much — wording/docs help vs. generated implementation code.
  Trivial single-token editor autocomplete doesn't need disclosing.
- **You own what you submit.** You must understand the change, be able to
  explain *why* it's written the way it is, and handle review feedback
  yourself — not by pasting the reviewer's comment back into a model.
- **Write your own prose.** PR descriptions, issue reports, and review
  replies should be in your words, not raw model output.
- **Unreviewed AI output will be closed** — blank PR descriptions, failing
  CI, unchecked template boxes, sprawling unrelated diffs, code that doesn't
  match the described intent.

This is about incoming contributions; it isn't a statement about how any
existing code was written.