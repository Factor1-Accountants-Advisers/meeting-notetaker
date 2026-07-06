"""Trigger test isolation before any test module is imported."""

import tests.conftest_env  # noqa: F401 — side-effect: sets MN_DATA_DIR
