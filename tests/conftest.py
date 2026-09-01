# Tests must not be affected by a real `.env` at the repo root (e.g. a local
# Docker deployment's `.env` -- gitignored and machine-local, but still sits
# in the cwd pytest runs from). Disable env-file loading here at conftest
# import time so every test's auth/config values come only from hardcoded
# defaults plus whatever it sets via monkeypatch.setenv.
from pathlib import Path

from arrlink.config import Settings

Settings.model_config["env_file"] = None

# A successful login (password or OIDC) returns RedirectResponse("/", 302).
# TestClient follows redirects by default, so those tests then GET "/", which
# only resolves if create_app() can find a built SPA (web/dist/index.html).
# CI's backend job doesn't run `npm run build`, so drop a minimal stub bundle
# (web/dist/ is gitignored) if one isn't already present.
_dist = Path(__file__).resolve().parents[1] / "web" / "dist"
if not (_dist / "index.html").is_file():
    (_dist / "assets").mkdir(parents=True, exist_ok=True)
    (_dist / "index.html").write_text("<!doctype html><title>ArrLink</title>\n")
