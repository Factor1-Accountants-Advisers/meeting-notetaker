"""IN-391 failure taxonomy: one category + user sentence per failure.

The four delivery/processing failure sites map exceptions (or exception-less
condition branches) onto a small fixed vocabulary. User-facing fields only
ever carry the fixed sentences below; raw exception text goes to logs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

from app.services.storage_api import StorageApiError

logger = logging.getLogger(__name__)

_DETAIL_LIMIT = 500


class FailureCategory(str, Enum):
    network = "network"
    azure_signin = "azure_signin"
    provider_credentials = "provider_credentials"
    service_unavailable = "service_unavailable"
    audio_problem = "audio_problem"
    processing_error = "processing_error"
    interrupted = "interrupted"
    stalled = "stalled"


# Product-voice sentences (spec §1; DRAFT table ratified at spec review).
USER_SENTENCES: dict[FailureCategory, str] = {
    FailureCategory.network: "Couldn't reach the network. Check your connection and retry.",
    FailureCategory.azure_signin: "Microsoft sign-in is needed. Sign in again, then retry.",
    FailureCategory.provider_credentials: (
        "A processing service credential needs attention. "
        "Ask an administrator to update it, then retry."
    ),
    FailureCategory.service_unavailable: "A cloud service is temporarily unavailable. Retry in a few minutes.",
    FailureCategory.audio_problem: "There was a problem with the recorded audio. Retry, and report a problem if it happens again.",
    FailureCategory.processing_error: "Processing failed. The recording is saved — retry to try again.",
    FailureCategory.interrupted: "The app restarted while this meeting was processing. Retry to continue.",
    FailureCategory.stalled: "Processing stalled before finishing. The recording is saved — retry to try again.",
}


@dataclass(frozen=True)
class FailureReason:
    category: FailureCategory
    user_sentence: str
    technical_detail: str

    @classmethod
    def for_category(cls, category: FailureCategory, *, detail: str = "") -> "FailureReason":
        """Build a reason for exception-less branches (condition checks)."""
        return cls(category, USER_SENTENCES[category], detail[:_DETAIL_LIMIT])


_SIGNIN_STATUSES = {401, 403}
_UNAVAILABLE_STATUSES = {408, 429}

# Always local file-op errors, never network — regardless of whether they
# were constructed with enough args to populate `filename` (e.g.
# `FileNotFoundError(local_path)` is a valid single-arg raise and leaves
# `filename` as None, indistinguishable from a socket error by that
# attribute alone). Exclude the whole subtree before the OSError+filename
# heuristic runs.
_FILE_ERROR_TYPES = (
    FileNotFoundError,
    PermissionError,
    IsADirectoryError,
    NotADirectoryError,
    FileExistsError,
)


def _status_code(exc: BaseException) -> int | None:
    for attribute in ("status_code", "status", "code"):
        value = getattr(exc, attribute, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def _is_storage_api_failure(exc: BaseException) -> bool:
    """True when any link in the cause chain is a Storage API error.

    Storage API requests authenticate with the user's delegated Microsoft
    token, so a 401/403 from that chain means "sign in again" — even when it
    surfaces at stage="pipeline" (voiceprint resolution runs inside the
    pipeline try block), where a bare 401 otherwise means a provider
    credential like the pyannoteAI key.
    """
    link: BaseException | None = exc
    for _ in range(5):  # bounded like the root-cause unwrap below
        if link is None:
            return False
        if isinstance(link, StorageApiError):
            return True
        link = link.__cause__
    return False


def _is_network_error(exc: BaseException) -> bool:
    if isinstance(exc, _FILE_ERROR_TYPES):
        return False
    # OSError covers DNS/socket/connection/timeout failures (ConnectionError,
    # TimeoutError, and urllib's URLError all subclass it) — none of those
    # carry a `filename`. Other local file errors are also OSError subclasses
    # and usually set `filename`, so we exclude them by attribute as a
    # secondary net for subclasses not covered by `_FILE_ERROR_TYPES` above.
    return isinstance(exc, OSError) and getattr(exc, "filename", None) is None


def classify(exc: BaseException, *, stage: str) -> FailureReason:
    """Map a caught exception to a fixed category + user sentence.

    Wrapper exceptions raised with `raise ... from cause` (e.g.
    `MeetingVoiceprintsUnavailable` in meeting_voiceprints.py:178) inherit
    their cause's category: we unwrap explicit `__cause__` links (bounded
    depth) before applying the rules, so the wrapper classifies by what
    actually went wrong underneath (network vs 5xx vs auth).

    `interrupted`/`stalled` are never produced here — those categories are
    assigned directly at the startup/watchdog marking sites, which have no
    exception object.
    """
    root: BaseException = exc
    for _ in range(5):  # bounded: cause chains are short; avoid cycles
        if root.__cause__ is None:
            break
        root = root.__cause__
    detail = f"{exc.__class__.__name__}: {exc}"
    if root is not exc:
        # The wrapper's own text rarely says what actually went wrong —
        # append the root cause so the delivery_failure log line is useful.
        detail += f" (cause: {root})"
    detail = detail.replace("\n", " ")[:_DETAIL_LIMIT]
    status = _status_code(root)
    if status in _SIGNIN_STATUSES and _is_storage_api_failure(exc):
        category = FailureCategory.azure_signin
    elif status in _SIGNIN_STATUSES and stage == "pipeline":
        category = FailureCategory.provider_credentials
    elif status in _SIGNIN_STATUSES:
        category = FailureCategory.azure_signin
    elif status is not None and (status in _UNAVAILABLE_STATUSES or status >= 500):
        category = FailureCategory.service_unavailable
    elif _is_network_error(root):
        category = FailureCategory.network
    else:
        category = FailureCategory.processing_error
    return FailureReason(category, USER_SENTENCES[category], detail)


def log_delivery_failure(
    meeting_id: object,
    stage: str,
    reason: FailureReason,
    *,
    code: str,
) -> None:
    """One structured, greppable line per failure (rides into main.log and
    therefore the IN-473 Report Problem bundle). `code` is the exception
    class name, or a stable branch name for exception-less branches."""
    logger.warning(
        "delivery_failure meeting=%s stage=%s category=%s code=%s detail=%s",
        meeting_id,
        stage,
        reason.category.value,
        code,
        reason.technical_detail,
    )
