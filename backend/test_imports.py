"""Quick import test to verify refactoring didn't break anything."""
import sys

print("Testing imports after refactoring...")

try:
    # Test core imports
    print("  ✓ Importing app.core.config...", end=" ")
    from app.core.config import settings
    print("OK")

    print("  ✓ Importing app.core.database...", end=" ")
    from app.core.database import Base, get_db, engine
    print("OK")

    # Test models
    print("  ✓ Importing app.models...", end=" ")
    from app import models
    print("OK")

    # Test schemas
    print("  ✓ Importing app.schemas...", end=" ")
    from app import schemas
    print("OK")

    # Test main app
    print("  ✓ Importing app.main...", end=" ")
    from app.main import app
    print("OK")

    # Verify app has routes
    print("  ✓ Checking routes...", end=" ")
    routes = [route.path for route in app.routes]
    assert "/health" in routes, "Missing /health route"
    assert "/" in routes, "Missing / route"
    print("OK")

    # Check models are registered with Base
    print("  ✓ Checking SQLAlchemy models registered...", end=" ")
    tables = Base.metadata.tables.keys()
    expected_tables = ['users', 'meetings', 'participants', 'transcripts', 'summaries', 'action_items']
    for table in expected_tables:
        assert table in tables, f"Missing table: {table}"
    print("OK")

    print("\n✅ All imports successful! Refactoring verified.")
    sys.exit(0)

except Exception as e:
    print(f"\n❌ Import failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
