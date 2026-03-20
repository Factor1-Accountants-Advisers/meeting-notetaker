#!/bin/bash
# =============================================================================
# Step 7: Read Endpoints Integration Test Script
# =============================================================================
#
# Prerequisites:
#   1. docker compose up -d --build
#   2. docker compose exec api alembic upgrade head
#   3. docker compose exec api python seed_test_data.py
#
# Usage:
#   ./test_step7_curl.sh [BASE_URL]
#
# If you have Azure AD auth configured, set TOKEN env var:
#   TOKEN="your-jwt-here" ./test_step7_curl.sh
#
# For dev testing without auth, temporarily disable auth dependency
# or use the dev bypass (see AUTH_TESTING.md).
# =============================================================================

BASE_URL="${1:-http://localhost:8000}"
AUTH_HEADER=""
if [ -n "$TOKEN" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer $TOKEN\""
fi

PASS=0
FAIL=0

check() {
    local desc="$1"
    local expected_code="$2"
    local actual_code="$3"
    local body="$4"

    if [ "$actual_code" == "$expected_code" ]; then
        echo "  ✅ $desc (HTTP $actual_code)"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $desc — expected $expected_code, got $actual_code"
        echo "     Response: $(echo "$body" | head -c 200)"
        FAIL=$((FAIL + 1))
    fi
}

echo "============================================"
echo " Step 7: Read Endpoints Integration Tests"
echo " Target: $BASE_URL"
echo "============================================"
echo ""

# Wait for API to be reachable
echo "▸ Waiting for API..."
for i in $(seq 1 15); do
    if curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" | grep -q "200"; then
        echo "  API is ready."
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo "  ❌ API not reachable after 15s. Is 'docker compose up -d' running?"
        echo "     Try: curl $BASE_URL/health"
        exit 1
    fi
    sleep 1
done
echo ""

# ------- Health check -------
echo "▸ Health check"
RESP=$(curl -s -w "\n%{http_code}" "$BASE_URL/health")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /health" "200" "$CODE" "$BODY"
echo ""

# ------- GET /api/meetings -------
echo "▸ Meeting list"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings — returns list" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings?page=1&per_page=1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings — pagination" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings?status=complete")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings — filter by status" "200" "$CODE" "$BODY"
echo ""

# ------- GET /api/meetings/{id} -------
echo "▸ Meeting detail"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/1 — complete meeting with all data" "200" "$CODE" "$BODY"

# Verify response has expected fields
if echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('transcript'), 'no transcript'; assert d.get('summary'), 'no summary'; assert len(d.get('action_items',[])) > 0, 'no action items'; assert len(d.get('participants',[])) > 0, 'no participants'" 2>/dev/null; then
    echo "  ✅ Response includes transcript, summary, action_items, participants"
    PASS=$((PASS + 1))
else
    echo "  ❌ Response missing expected nested data"
    FAIL=$((FAIL + 1))
fi

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/2")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/2 — processing meeting" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/9999")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/9999 — not found" "404" "$CODE" "$BODY"
echo ""

# ------- GET /api/meetings/{id}/transcript -------
echo "▸ Transcript"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/1/transcript")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/1/transcript — has segments" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/2/transcript")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/2/transcript — not ready" "404" "$CODE" "$BODY"
echo ""

# ------- GET /api/meetings/{id}/action-items -------
echo "▸ Meeting action items"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/1/action-items")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/1/action-items — has items" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/meetings/2/action-items")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/meetings/2/action-items — empty list" "200" "$CODE" "$BODY"
echo ""

# ------- GET /api/action-items -------
echo "▸ All action items"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/action-items")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/action-items — list all" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/action-items?status=open")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/action-items?status=open — filter" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" $AUTH_HEADER "$BASE_URL/api/action-items?page=1&per_page=1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "GET /api/action-items — pagination" "200" "$CODE" "$BODY"
echo ""

# ------- PATCH /api/action-items/{id} -------
echo "▸ Update action item"

RESP=$(curl -s -w "\n%{http_code}" -X PATCH $AUTH_HEADER \
    -H "Content-Type: application/json" \
    -d '{"status": "complete"}' \
    "$BASE_URL/api/action-items/1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "PATCH /api/action-items/1 — mark complete" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" -X PATCH $AUTH_HEADER \
    -H "Content-Type: application/json" \
    -d '{"owner_name": "New Owner", "due_date": "2026-04-15"}' \
    "$BASE_URL/api/action-items/2")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "PATCH /api/action-items/2 — update owner and due_date" "200" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" -X PATCH $AUTH_HEADER \
    -H "Content-Type: application/json" \
    -d '{"status": "invalid"}' \
    "$BASE_URL/api/action-items/1")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "PATCH /api/action-items/1 — invalid status rejected" "400" "$CODE" "$BODY"

RESP=$(curl -s -w "\n%{http_code}" -X PATCH $AUTH_HEADER \
    -H "Content-Type: application/json" \
    -d '{"status": "complete"}' \
    "$BASE_URL/api/action-items/9999")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
check "PATCH /api/action-items/9999 — not found" "404" "$CODE" "$BODY"
echo ""

# ------- Summary -------
echo "============================================"
echo " Results: $PASS passed, $FAIL failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
