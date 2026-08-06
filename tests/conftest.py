# Tests must not be affected by a real `.env` at the repo root (e.g. a local
# Docker deployment's `.env` -- gitignored and machine-local, but still sits
# in the cwd pytest runs from). Several test modules instantiate `create_app()`
# at import time (module-level), before any per-test fixture would run, so
# this has to be disabled here at conftest import time -- every test's
# auth/config values then come only from hardcoded defaults plus whatever it
# explicitly sets via monkeypatch.setenv, never from whatever happens to be
# in a real .env.
from arrlink.config import Settings

Settings.model_config["env_file"] = None
