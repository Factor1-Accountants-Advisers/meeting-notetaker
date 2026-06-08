"""Tests for voiceprint onboarding API."""
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import Base, get_db
from app.main import app
from app.models import User, Voiceprint
from app.services.pyannote_voiceprint_provider import get_pyannote_voiceprint_provider


TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


class FakeVoiceprintProvider:
    def __init__(self):
        self.calls = 0

    def create_voiceprint(self, sample_path, *, label: str) -> str:
        self.calls += 1
        assert sample_path.exists()
        assert label == "Test User"
        return "vp_from_api"


@pytest.fixture()
async def voiceprint_api_client():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        user = User(
            id=1,
            email="test@example.com",
            name="Test User",
            azure_ad_id="test-azure-id-123",
            role="user",
        )
        session.add(user)
        await session.commit()

        provider = FakeVoiceprintProvider()

        async def override_get_db():
            yield session

        async def override_get_current_user():
            return user

        def override_provider():
            return provider

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user] = override_get_current_user
        app.dependency_overrides[get_pyannote_voiceprint_provider] = override_provider

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, session, provider

        app.dependency_overrides.clear()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_voiceprint_upload_stores_provider_id_without_raw_sample(voiceprint_api_client):
    client, db, provider = voiceprint_api_client

    response = await client.post(
        "/api/voiceprints",
        files={"sample_file": ("joseph.wav", b"RIFFfakeWAV", "audio/wav")},
        data={
            "consent_confirmed": "true",
            "sample_duration_seconds": "20.5",
            "sample_source": "desktop_recorder",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "pyannote"
    assert payload["display_name"] == "Test User"
    assert payload["email"] == "test@example.com"
    assert payload["status"] == "active"
    assert payload["sample_duration_seconds"] == 20.5
    assert payload["sample_source"] == "desktop_recorder"
    assert provider.calls == 1

    result = await db.execute(select(Voiceprint).where(Voiceprint.provider_voiceprint_id == "vp_from_api"))
    voiceprint = result.scalars().one()
    assert voiceprint.raw_sample_path is None


@pytest.mark.asyncio
async def test_create_voiceprint_requires_consent(voiceprint_api_client):
    client, db, provider = voiceprint_api_client

    response = await client.post(
        "/api/voiceprints",
        files={"sample_file": ("joseph.wav", b"RIFFfakeWAV", "audio/wav")},
        data={"consent_confirmed": "false"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Voiceprint consent is required"
    assert provider.calls == 0
    result = await db.execute(select(Voiceprint))
    assert result.scalars().all() == []
