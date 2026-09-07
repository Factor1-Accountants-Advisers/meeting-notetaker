"""Outbound TLS must verify through the operating system's trust engine.

Three new Intune devices in three weeks (17 Aug, 31 Aug, 7 Sep 2026) could
not enrol voiceprints: ``CERTIFICATE_VERIFY_FAILED ... unable to get local
issuer certificate`` on the pyannoteAI upload. The bundled backend used
stdlib ``urllib`` with OpenSSL's default context, which only trusts what is
already in the Windows certificate stores and cannot ask Windows to fetch a
missing root (ISRG Root X1, needed for api.pyannote.ai) or a missing
intermediate. Windows' own chain engine (CryptoAPI) does both on demand.

``app.tls.install_system_trust`` routes every ``ssl.SSLContext`` — and so
``urllib.request.urlopen``'s default HTTPS context — through ``truststore``,
which verifies with CryptoAPI on Windows. These tests are offline; the
``MN_LIVE_TLS_TESTS=1`` class exercises real hosts.
"""

import os
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import tests.conftest_env  # noqa: F401 — isolate MN_DATA_DIR before app imports

import truststore

from app.tls import install_system_trust

BACKEND_DIR = Path(__file__).resolve().parents[1]


class SystemTrustInstallTests(unittest.TestCase):
    def test_default_context_verifies_through_os_trust_store(self):
        install_system_trust()

        context = ssl.create_default_context()

        # urllib's default HTTPS context is built by ssl.create_default_context,
        # so this is the context every urlopen() in the backend will use.
        self.assertIsInstance(context, truststore.SSLContext)

    def test_default_context_still_requires_verification(self):
        install_system_trust()

        context = ssl.create_default_context()

        # Routing through the OS engine must never degrade into "verify nothing".
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_install_is_idempotent(self):
        install_system_trust()
        install_system_trust()

        self.assertIs(ssl.SSLContext, truststore.SSLContext)
        self.assertIsInstance(ssl.create_default_context(), truststore.SSLContext)

    def test_importing_the_app_installs_system_trust(self):
        # A fresh interpreter, so this proves the import-time hook in app.main
        # rather than a leftover from another test in this process.
        script = (
            "import tests.conftest_env, ssl, truststore\n"
            "import app.main\n"
            "print(ssl.SSLContext is truststore.SSLContext)\n"
        )
        env = {**os.environ, "MN_DATA_DIR": tempfile.mkdtemp(prefix="mn-tls-test-")}
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=BACKEND_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "True")


@unittest.skipUnless(os.environ.get("MN_LIVE_TLS_TESTS") == "1", "set MN_LIVE_TLS_TESTS=1 to hit real hosts")
class SystemTrustLiveTests(unittest.TestCase):
    """Network checks. On Windows these exercise CryptoAPI's on-demand root and
    intermediate retrieval, the behaviour the fix exists for."""

    def setUp(self):
        install_system_trust()

    def _assert_tls_ok(self, url: str) -> None:
        try:
            urllib.request.urlopen(url, timeout=30).close()
        except urllib.error.HTTPError:
            pass  # any HTTP status means the TLS handshake and verification succeeded
        except urllib.error.URLError as exc:
            self.fail(f"TLS verification failed for {url}: {exc.reason}")

    def test_pyannote_api_verifies(self):
        # Let's Encrypt chain (YR2 -> ISRG Root YR cross-signed by ISRG Root X1):
        # the exact chain that failed on the three new devices.
        self._assert_tls_ok("https://api.pyannote.ai/v1/test")

    def test_incomplete_chain_is_completed_by_os_engine(self):
        # Server omits its intermediate; stdlib OpenSSL cannot fetch it, CryptoAPI can.
        self._assert_tls_ok("https://incomplete-chain.badssl.com/")


if __name__ == "__main__":
    unittest.main()
