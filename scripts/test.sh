#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh llms.txt; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

echo "== product fixtures and OpenAPI =="
for f in \
  openapi/openapi.yaml \
  tests/fixtures/asins.json \
  tests/fixtures/short-links.json \
  tests/fixtures/html/B0BESTSELL.html \
  tests/fixtures/html/B0BOOK0001.html \
  tests/fixtures/html/B0UNAVAIL0.html \
  tests/fixtures/html/B0VARIATN1.html \
  tests/fixtures/html/B0ADULTADJ.html \
  tests/fixtures/html/B0BLOCKED0.html \
  tests/fixtures/html/B0NOREVIEW.html \
  tests/fixtures/html/reviews/B0BESTSELL.p1.helpful.html \
  tests/fixtures/html/reviews/B0BESTSELL.p1.recent.html \
  tests/fixtures/html/reviews/B0BESTSELL.p2.helpful.html \
  tests/fixtures/html/reviews/B0BOOK0001.p1.helpful.html \
  tests/fixtures/html/reviews/B0VARIATN1.p1.helpful.html \
  tests/fixtures/html/reviews/B0ADULTADJ.p1.helpful.html \
  tests/fixtures/html/reviews/B0NOREVIEW.p1.helpful.html \
  tests/fixtures/html/search/echo-dot.p1.html \
  tests/fixtures/html/search/echo-dot.p2.html \
  tests/fixtures/html/search/blocked.p1.html \
  tests/fixtures/html/search/empty-query.p1.html
do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done
grep -q '/v1/products/{asin}' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/{asin}"
grep -q '/v1/products/by-url' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/by-url"
grep -q '/v1/products/{asin}/reviews' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/{asin}/reviews"
grep -q '/v1/search' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/search"
grep -q '/v1/products/{asin}/offers' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/{asin}/offers"
grep -q 'not_implemented' openapi/openapi.yaml \
  || fail "openapi.yaml missing not_implemented"
grep -q 'name: fields' openapi/openapi.yaml \
  || fail "openapi.yaml missing fields projection"
grep -q 'invalid_asin' openapi/openapi.yaml \
  || fail "openapi.yaml missing invalid_asin"
grep -q 'marketplace_unsupported' openapi/openapi.yaml \
  || fail "openapi.yaml missing marketplace_unsupported"
if grep -qiE 'offers' README.md >/dev/null 2>&1; then
  fail "README homepage must not mention offers until 200s"
fi
asin_count="$(grep -c '"asin"' tests/fixtures/asins.json || true)"
[[ "$asin_count" -eq 50 ]] || fail "asins.json must list 50 ASINs, got ${asin_count}"

echo "== llms.txt + MCP tools =="
[[ -f src/mcp/server.ts ]] || fail "missing src/mcp/server.ts"
[[ -f src/mcp/tools.ts ]] || fail "missing src/mcp/tools.ts"
[[ -f tests/mcp.test.ts ]] || fail "missing tests/mcp.test.ts"
grep -q 'get_product' llms.txt || fail "llms.txt missing get_product"
grep -q 'list_reviews' llms.txt || fail "llms.txt missing list_reviews"
grep -q 'search_amazon' llms.txt || fail "llms.txt missing search_amazon"
grep -q 'When not to call' llms.txt || fail "llms.txt missing when-not-to-call"
grep -q 'search_amazon' src/mcp/tools.ts || fail "src/mcp/tools.ts missing search_amazon"
[[ -f src/core/search.ts ]] || fail "missing src/core/search.ts"
[[ -f src/core/fields.ts ]] || fail "missing src/core/fields.ts"
[[ -f tests/search.test.ts ]] || fail "missing tests/search.test.ts"
[[ -f src/core/offers.ts ]] || fail "missing src/core/offers.ts"
[[ -f tests/offers.test.ts ]] || fail "missing tests/offers.test.ts"
[[ -f src/adapters/amazon/live.ts ]] || fail "missing src/adapters/amazon/live.ts"
[[ -f src/adapters/amazon/parse.ts ]] || fail "missing src/adapters/amazon/parse.ts"
[[ -f tests/live-adapter.test.ts ]] || fail "missing tests/live-adapter.test.ts"
grep -q 'ASINAPI_ADAPTER' src/config.ts \
  || fail "src/config.ts missing ASINAPI_ADAPTER gate"
grep -q 'ASINAPI_FIXTURE_ONLY' src/config.ts \
  || fail "src/config.ts missing ASINAPI_FIXTURE_ONLY override"
if grep -q 'short-links.json' src/adapters/amazon/live.ts; then
  fail "live adapter must HEAD-follow amzn.to, not read short-links.json"
fi
if grep -E 'fetch\s*\(\s*['\''"]https?://' src/adapters/amazon/live.ts >/dev/null 2>&1; then
  fail "live adapter must not hard-code fetch() URLs"
fi
if grep -E 'GET_OFFERS|list_offers|"offers"' src/mcp/tools.ts >/dev/null 2>&1; then
  fail "src/mcp/tools.ts must not ship offers"
fi
if grep -R --include='*.ts' -E 'fetch\s*\(|https?://www\.amazon\.com/gp/product-api' src/mcp >/dev/null 2>&1; then
  fail "src/mcp must not call live Amazon"
fi

echo "== deploy artifacts (Dockerfile + runbook) =="
[[ -f Dockerfile ]] || fail "missing Dockerfile"
[[ -f .env.example ]] || fail "missing .env.example"
[[ -f deploy/runbook.md ]] || fail "missing deploy/runbook.md"
grep -q 'node:22' Dockerfile || fail "Dockerfile must use Node 22"
grep -qE '^USER[[:space:]]+node$' Dockerfile || fail "Dockerfile must run as non-root USER node"
grep -q 'PORT' Dockerfile || fail "Dockerfile must honor PORT"
grep -q 'src/server.ts' Dockerfile || fail "Dockerfile must start src/server.ts"
if grep -E 'ASINAPI_ADAPTER[[:space:]]*=[[:space:]]*live' Dockerfile >/dev/null; then
  fail "Dockerfile must not set ASINAPI_ADAPTER=live"
fi
if grep -E 'ASINAPI_FIXTURE_ONLY[[:space:]]*=[[:space:]]*0' Dockerfile >/dev/null; then
  fail "Dockerfile must not disable ASINAPI_FIXTURE_ONLY"
fi
grep -q 'ASINAPI_ADAPTER' .env.example || fail ".env.example missing ASINAPI_ADAPTER"
grep -q 'ASINAPI_FIXTURE_ONLY' .env.example || fail ".env.example missing ASINAPI_FIXTURE_ONLY"
grep -q 'ASINAPI_DATABASE' .env.example || fail ".env.example missing ASINAPI_DATABASE"
grep -q 'ASINAPI_BOOTSTRAP_KEY' .env.example || fail ".env.example missing ASINAPI_BOOTSTRAP_KEY"
if grep -E '^[[:space:]]*ASINAPI_ADAPTER=live[[:space:]]*$' .env.example >/dev/null; then
  fail ".env.example must not default ASINAPI_ADAPTER=live"
fi
if grep -E '^[[:space:]]*ASINAPI_BOOTSTRAP_KEY=ak_(live|test)_' .env.example >/dev/null; then
  fail ".env.example must not ship a real bootstrap key"
fi
grep -q '/healthz' deploy/runbook.md || fail "runbook missing /healthz"
grep -q 'ASINAPI_ADAPTER=live' deploy/runbook.md || fail "runbook missing how to enable live"
grep -q 'docker build' deploy/runbook.md || fail "runbook missing docker build"
grep -q 'docker run' deploy/runbook.md || fail "runbook missing docker run"
if grep -qE 'docker-compose|compose\.ya?ml' Dockerfile deploy/runbook.md >/dev/null 2>&1; then
  fail "one-box deploy is Dockerfile only; do not add docker-compose"
fi

echo "== HTTP/MCP do not import adapters/amazon =="
for dir in src/http src/mcp; do
  if [[ -d "$dir" ]] && grep -R --include='*.ts' -l 'adapters/amazon' "$dir" >/dev/null 2>&1; then
    fail "$dir imported adapters/amazon"
  fi
done

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  # Fixture adapter only — never hit live Amazon. Live adapter tests inject fetch.
  export ASINAPI_FIXTURE_ONLY=1
  unset ASINAPI_ADAPTER
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
