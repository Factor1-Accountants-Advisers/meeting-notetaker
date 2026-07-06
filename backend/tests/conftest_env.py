"""Test isolation bootstrap.

Set ``MN_DATA_DIR`` to a temporary directory and clear the pydantic-settings
LRU cache *before* any ``app.*`` import happens.  This keeps the live
``backend/var/store.json`` untouched when running the full test suite.

Usage (unittest runner / module-level import guard):
  import tests.conftest_env  # noqa: F401 — must precede all app.* imports
"""

import os
import tempfile

# Set MN_DATA_DIR *before* the first import from app.* so pydantic-settings
# picks up the temp directory upfront (env file + env var are read at
# Settings() construction time).
os.environ["MN_DATA_DIR"] = tempfile.mkdtemp(prefix="mn-test-")

from app.config import get_settings  # noqa: E402 — must run after env set

get_settings.cache_clear()
