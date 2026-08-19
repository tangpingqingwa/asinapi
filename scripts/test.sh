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
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
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
  tests/fixtures/html/B0BLOCKED0.html
do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done
grep -q '/v1/products/{asin}' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/{asin}"
grep -q '/v1/products/by-url' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/products/by-url"
grep -q 'invalid_asin' openapi/openapi.yaml \
  || fail "openapi.yaml missing invalid_asin"
grep -q 'marketplace_unsupported' openapi/openapi.yaml \
  || fail "openapi.yaml missing marketplace_unsupported"
asin_count="$(grep -c '"asin"' tests/fixtures/asins.json || true)"
[[ "$asin_count" -eq 50 ]] || fail "asins.json must list 50 ASINs, got ${asin_count}"

echo "== HTTP must not import adapters/amazon =="
if [[ -d src/http ]] && grep -R --include='*.ts' -l 'adapters/amazon' src/http >/dev/null 2>&1; then
  fail "src/http imported adapters/amazon"
fi
if [[ -d src/mcp ]] && grep -R --include='*.ts' -l 'adapters/amazon' src/mcp >/dev/null 2>&1; then
  fail "src/mcp imported adapters/amazon"
fi

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
  # Fixture adapter only — never hit live Amazon.
  export ASINAPI_FIXTURE_ONLY=1
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
