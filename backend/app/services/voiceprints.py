"""Voiceprint repository (IN-69, IN-76).

Stores pyannoteAI provider voiceprints for enrolled staff. Voiceprints are
opaque provider payloads; never log them or expose them to the renderer. The
local JSON file is a Slice 1 stand-in for encrypted database/Key Vault storage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app import store


VOICEPRINT_PATH = Path(__file__).resolve().parents[2] / "var" / "voiceprints.json"


@dataclass
class Voiceprint:
    employee_id: str
    display_name: str
    voiceprints: list[str]
    model_version: str
    enrolled_at: str  # ISO 8601


class VoiceprintRepository(Protocol):
    """Storage and retrieval of enrolled provider voiceprints."""

    def get_all(self) -> list[Voiceprint]:
        ...

    def get_by_employee_id(self, employee_id: str) -> Voiceprint | None:
        ...

    def enroll(self, voiceprint: Voiceprint) -> None:
        ...


class JsonVoiceprintRepository:
    """Local encrypted-storage stand-in for pyannoteAI voiceprint payloads."""

    def __init__(self, path: Path = VOICEPRINT_PATH) -> None:
        self._path = path
        self._voiceprints: dict[str, Voiceprint] = {}
        self._load()

    def get_all(self) -> list[Voiceprint]:
        return list(self._voiceprints.values())

    def get_by_employee_id(self, employee_id: str) -> Voiceprint | None:
        return self._voiceprints.get(employee_id)

    def enroll(self, voiceprint: Voiceprint) -> None:
        self._voiceprints[voiceprint.employee_id] = voiceprint
        self._save()
        person = next(
            (p for p in store.PEOPLE if p.employee_id == voiceprint.employee_id),
            None,
        )
        if person:
            person.enrolled = True
            person.model_version = voiceprint.model_version
            person.reenrollment_required = False

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            people = raw.get("people", {}) if isinstance(raw, dict) else {}
            self._voiceprints = {
                employee_id: Voiceprint(
                    employee_id=employee_id,
                    display_name=str(item["display_name"]),
                    voiceprints=list(item["voiceprints"]),
                    model_version=str(item["model_version"]),
                    enrolled_at=str(item["enrolled_at"]),
                )
                for employee_id, item in people.items()
                if isinstance(item, dict)
            }
        except Exception:
            self._voiceprints = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "people": {
                employee_id: {
                    "display_name": vp.display_name,
                    "voiceprints": vp.voiceprints,
                    "model_version": vp.model_version,
                    "enrolled_at": vp.enrolled_at,
                }
                for employee_id, vp in self._voiceprints.items()
            }
        }
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(self._path)


_voiceprint_repo: VoiceprintRepository | None = None


def get_voiceprint_repository() -> VoiceprintRepository:
    global _voiceprint_repo
    if _voiceprint_repo is None:
        _voiceprint_repo = JsonVoiceprintRepository()
    return _voiceprint_repo
