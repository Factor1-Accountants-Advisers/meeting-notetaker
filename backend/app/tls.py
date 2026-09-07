"""Route outbound TLS verification through the operating system's trust engine.

Why: the bundled backend talks to api.pyannote.ai (a Let's Encrypt chain)
with stdlib ``urllib``. OpenSSL trusts only what is already in the Windows
certificate stores and cannot ask Windows to fetch a missing root or
intermediate, so a freshly enrolled device whose ``AuthRoot`` store has not
yet received ISRG Root X1 fails every voiceprint enrolment with
``CERTIFICATE_VERIFY_FAILED`` (three new devices: 17 Aug, 31 Aug, 7 Sep
2026). Windows' own chain engine (CryptoAPI) fetches both on demand, exactly
as Edge, curl.exe and PowerShell do, and also honours any corporate or
antivirus inspection CA installed in the machine store.

``truststore.inject_into_ssl`` replaces ``ssl.SSLContext`` so every context
created afterwards, including the default HTTPS context that
``urllib.request.urlopen`` builds for each request, verifies through the OS
engine: CryptoAPI on Windows, Security.framework on macOS, OpenSSL's system
store elsewhere.
"""

import ssl

import truststore


def install_system_trust() -> None:
    """Idempotent. Call once, before the first outbound HTTPS request."""
    if ssl.SSLContext is truststore.SSLContext:
        return
    truststore.inject_into_ssl()
