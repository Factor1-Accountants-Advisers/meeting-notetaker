"""Voiceprint repository (IN-69, IN-76).

Stores enrolled staff voiceprints for speaker matching. The repository is a
provider interface so the real storage (PostgreSQL / Key Vault) and the
in-memory stub are interchangeable.
"""

from dataclasses import dataclass, field
from typing import Protocol

from app import store
from app.config import get_settings


@dataclass
class Voiceprint:
    employee_id: str
    display_name: str
    embedding: list[float]
    model_version: str
    enrolled_at: str  # ISO 8601


class VoiceprintRepository(Protocol):
    """Storage and retrieval of enrolled voiceprints."""

    def get_all(self) -> list[Voiceprint]:
        ...

    def get_by_employee_id(self, employee_id: str) -> Voiceprint | None:
        ...

    def enroll(self, voiceprint: Voiceprint) -> None:
        ...


class StubVoiceprintRepository:
    """In-memory voiceprint store backed by the app store's PEOPLE list."""

    def __init__(self) -> None:
        self._voiceprints: dict[str, Voiceprint] = {}

    def get_all(self) -> list[Voiceprint]:
        return list(self._voiceprints.values())

    def get_by_employee_id(self, employee_id: str) -> Voiceprint | None:
        return self._voiceprints.get(employee_id)

    def enroll(self, voiceprint: Voiceprint) -> None:
        self._voiceprints[voiceprint.employee_id] = voiceprint
        # Update the person's enrollment status in the main store.
        person = next(
            (p for p in store.PEOPLE if p.employee_id == voiceprint.employee_id),
            None,
        )
        if person:
            person.enrolled = True
            person.model_version = voiceprint.model_version
            person.reenrollment_required = False


_voiceprint_repo: VoiceprintRepository | None = None


def get_voiceprint_repository() -> VoiceprintRepository:
    global _voiceprint_repo
    if _voiceprint_repo is None:
        _voiceprint_repo = StubVoiceprintRepository()
    return _voiceprint_repo
