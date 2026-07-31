"""IN-484: /health echoes the supervisor-injected app version so a packaged
supervisor can distinguish its own backend from a stale orphan before
adopting whatever is listening on the port."""

import os
import unittest

import tests.conftest_env  # noqa: F401 — isolate MN_DATA_DIR before app imports

from app.config import get_settings
from app.routers.health import health


class HealthVersionHandshakeTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        os.environ.pop("MN_APP_VERSION", None)
        get_settings.cache_clear()

    async def test_health_reports_injected_app_version(self):
        os.environ["MN_APP_VERSION"] = "2.0.12"
        get_settings.cache_clear()

        payload = await health()

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["app_version"], "2.0.12")

    async def test_health_reports_empty_version_without_injection(self):
        # A manually-run dev backend has no MN_APP_VERSION — the packaged
        # supervisor must see the empty string and refuse adoption.
        get_settings.cache_clear()

        payload = await health()

        self.assertEqual(payload["app_version"], "")


if __name__ == "__main__":
    unittest.main()
