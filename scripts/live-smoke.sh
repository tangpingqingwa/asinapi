#!/usr/bin/env bash
# Opt-in live Amazon.com smoke. Not called from scripts/test.sh or CI.
# Starts a local process with ASINAPI_ADAPTER=live and ASINAPI_FIXTURE_ONLY unset,
# then walks product, reviews, search, non-US host, and offers against real Amazon.
# Never invents a title or review. Empty parsed lists are honest.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  fail "live-smoke is opt-in and must not run in CI"
fi

if [[ "${ASINAPI_FIXTURE_ONLY:-}" == "1" ]]; then
  fail "ASINAPI_FIXTURE_ONLY=1 is set; unset it so the live adapter can fetch Amazon.com"
fi

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

command -v curl >/dev/null || fail "curl is required"
command -v node >/dev/null || fail "node is required"

ASIN="${ASINAPI_LIVE_SMOKE_ASIN:-B07FZ8S74R}"
SEARCH_Q="${ASINAPI_LIVE_SMOKE_Q:-echo dot}"
UK_URL="${ASINAPI_LIVE_SMOKE_UK_URL:-https://www.amazon.co.uk/dp/${ASIN}}"
KEY="${ASINAPI_LIVE_SMOKE_KEY:-ak_live_smoke_local}"
[[ "$KEY" == ak_live_* || "$KEY" == ak_test_* ]] || fail "bootstrap key must start with ak_live_ or ak_test_"

if [[ -n "${ASINAPI_LIVE_SMOKE_PORT:-}" ]]; then
  PORT="$ASINAPI_LIVE_SMOKE_PORT"
else
  PORT="$(node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") process.exit(1);
      process.stdout.write(String(addr.port));
      server.close();
    });
  ')"
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/asinapi-live-smoke.XXXXXX")"
db="$workdir/asinapi.sqlite"
log="$workdir/server.log"
pid=""

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

json_get() {
  ASINAPI_JSON_FILE="$1" ASINAPI_JSON_PATH="$2" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const file = process.env.ASINAPI_JSON_FILE;
    const path = process.env.ASINAPI_JSON_PATH;
    if (!file || !path) process.exit(2);
    const obj = JSON.parse(readFileSync(file, "utf8"));
    let cur = obj;
    for (const key of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") process.exit(2);
      cur = cur[key];
    }
    if (cur === undefined || cur === null) process.exit(2);
    if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
    else process.stdout.write(String(cur));
  '
}

json_len() {
  ASINAPI_JSON_FILE="$1" ASINAPI_JSON_PATH="$2" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const file = process.env.ASINAPI_JSON_FILE;
    const path = process.env.ASINAPI_JSON_PATH;
    if (!file || !path) process.exit(2);
    const obj = JSON.parse(readFileSync(file, "utf8"));
    let cur = obj;
    for (const key of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") process.exit(2);
      cur = cur[key];
    }
    if (!Array.isArray(cur)) process.exit(2);
    process.stdout.write(String(cur.length));
  '
}

encode_query() {
  ASINAPI_Q="$1" node --input-type=module -e '
    process.stdout.write(encodeURIComponent(process.env.ASINAPI_Q ?? ""));
  '
}

request() {
  local out="$1" method="$2" path="$3"
  local url="http://127.0.0.1:${PORT}${path}"
  local http
  http="$(
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${KEY}" \
      -H "Accept: application/json" \
      -o "$out" -w "%{http_code}" \
      --connect-timeout 10 \
      --max-time 45 \
      "$url"
  )" || fail "curl failed for ${method} ${path}"
  printf "%s" "$http"
}

echo "== live-smoke (Amazon.com) =="
echo "adapter=live fixture_only=unset asin=${ASIN} q=${SEARCH_Q} port=${PORT}"

unset ASINAPI_FIXTURE_ONLY
export ASINAPI_ADAPTER=live
export PORT
export ASINAPI_DATABASE="$db"
export ASINAPI_BOOTSTRAP_KEY="$KEY"
export NODE_ENV="${NODE_ENV:-development}"

if [[ "${ASINAPI_ADAPTER}" != "live" ]]; then
  fail "ASINAPI_ADAPTER must be live"
fi
if [[ -n "${ASINAPI_FIXTURE_ONLY:-}" ]]; then
  fail "ASINAPI_FIXTURE_ONLY must be unset"
fi

node --import tsx src/server.ts >"$log" 2>&1 &
pid=$!

ready=0
for _ in $(seq 1 80); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "---- server log ----" >&2
    cat "$log" >&2 || true
    fail "server exited before /healthz"
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" -eq 1 ]] || fail "server did not become ready on port ${PORT}"

health="$(curl -sS -o "$workdir/health.json" -w "%{http_code}" --max-time 5 \
  "http://127.0.0.1:${PORT}/healthz")"
[[ "$health" == "200" ]] || fail "/healthz returned HTTP ${health}"

me_http="$(request "$workdir/me.json" GET /v1/me)"
[[ "$me_http" == "200" ]] || fail "/v1/me returned HTTP ${me_http}"

product_http="$(request "$workdir/product.json" GET "/v1/products/${ASIN}")"
reviews_http="$(request "$workdir/reviews.json" GET "/v1/products/${ASIN}/reviews?page=1")"
search_http="$(request "$workdir/search.json" GET "/v1/search?q=$(encode_query "$SEARCH_Q")")"
uk_http="$(request "$workdir/uk.json" GET "/v1/products/by-url?url=$(encode_query "$UK_URL")")"
offers_http="$(request "$workdir/offers.json" GET "/v1/products/${ASIN}/offers")"

verdict="PASS"
note() {
  echo "$*"
}

# Product: 200 + real non-empty title, or honest SPEC error. Never invent.
product_status="FAIL"
if [[ "$product_http" == "200" ]]; then
  product_asin="$(json_get "$workdir/product.json" data.asin || true)"
  product_title="$(json_get "$workdir/product.json" data.title || true)"
  product_market="$(json_get "$workdir/product.json" data.marketplace || true)"
  if [[ "$product_asin" != "$ASIN" ]]; then
    note "product: FAIL — expected asin ${ASIN}, got ${product_asin:-<missing>}"
    verdict="FAIL"
  elif [[ -z "$product_title" ]]; then
    note "product: FAIL — empty title (would be invented if we filled it)"
    verdict="FAIL"
  elif [[ "$product_title" == *"Recorded Echo Dot fixture"* ]]; then
    note "product: FAIL — fixture title leaked; live adapter is not on"
    verdict="FAIL"
  elif [[ "$product_market" != "US" ]]; then
    note "product: FAIL — marketplace ${product_market}"
    verdict="FAIL"
  else
    product_status="PASS"
    note "product: PASS — HTTP 200 asin=${product_asin} title_len=${#product_title}"
  fi
elif [[ "$product_http" == "503" ]]; then
  code="$(json_get "$workdir/product.json" error.code || true)"
  charged="$(json_get "$workdir/product.json" meta.creditsCharged || true)"
  if [[ "$code" == "upstream_blocked" && "$charged" == "0" ]]; then
    product_status="PASS-ERROR"
    note "product: PASS-ERROR — HTTP 503 upstream_blocked, 0 credits (Amazon blocked; title not invented)"
  else
    note "product: FAIL — HTTP 503 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
elif [[ "$product_http" == "404" ]]; then
  code="$(json_get "$workdir/product.json" error.code || true)"
  charged="$(json_get "$workdir/product.json" meta.creditsCharged || true)"
  if [[ "$code" == "product_unavailable" && "$charged" == "0" ]]; then
    product_status="PASS-ERROR"
    note "product: PASS-ERROR — HTTP 404 product_unavailable, 0 credits (no title invented)"
  else
    note "product: FAIL — HTTP 404 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
else
  note "product: FAIL — unexpected HTTP ${product_http}"
  verdict="FAIL"
fi

# Reviews: 200 with an array (empty allowed). Never invent rows.
reviews_status="FAIL"
if [[ "$reviews_http" == "200" ]]; then
  n="$(json_len "$workdir/reviews.json" data.reviews || true)"
  if [[ -z "$n" ]]; then
    note "reviews: FAIL — data.reviews is not an array"
    verdict="FAIL"
  else
    fixture_leak="$(
      ASINAPI_JSON_FILE="$workdir/reviews.json" node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const file = process.env.ASINAPI_JSON_FILE;
        if (!file) process.exit(2);
        const body = JSON.parse(readFileSync(file, "utf8"));
        const reviews = body?.data?.reviews;
        if (!Array.isArray(reviews)) process.exit(2);
        const banned = new Set(["R10BESTHELP", "R11BESTHELP", "R12BESTHELP"]);
        for (const review of reviews) {
          if (review == null || typeof review !== "object") process.exit(3);
          if (typeof review.body !== "string") process.exit(4);
          if (typeof review.stars !== "number" || review.stars < 1 || review.stars > 5) process.exit(5);
          if (typeof review.id === "string" && banned.has(review.id)) process.exit(6);
        }
      ' && echo ok || echo bad
    )"
    if [[ "$fixture_leak" != "ok" ]]; then
      note "reviews: FAIL — invented, fixture, or malformed review row"
      verdict="FAIL"
    else
      reviews_status="PASS"
      note "reviews: PASS — HTTP 200 reviews=${n} (empty is honest; none invented)"
    fi
  fi
elif [[ "$reviews_http" == "503" ]]; then
  code="$(json_get "$workdir/reviews.json" error.code || true)"
  charged="$(json_get "$workdir/reviews.json" meta.creditsCharged || true)"
  if [[ "$code" == "upstream_blocked" && "$charged" == "0" ]]; then
    reviews_status="PASS-ERROR"
    note "reviews: PASS-ERROR — HTTP 503 upstream_blocked, 0 credits (no reviews invented)"
  else
    note "reviews: FAIL — HTTP 503 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
else
  note "reviews: FAIL — unexpected HTTP ${reviews_http}"
  verdict="FAIL"
fi

# Search: 200 with a results array (empty allowed). Never invent hits.
search_status="FAIL"
if [[ "$search_http" == "200" ]]; then
  n="$(json_len "$workdir/search.json" data.results || true)"
  if [[ -z "$n" ]]; then
    note "search: FAIL — data.results is not an array"
    verdict="FAIL"
  else
    search_ok="$(
      ASINAPI_JSON_FILE="$workdir/search.json" node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const file = process.env.ASINAPI_JSON_FILE;
        if (!file) process.exit(2);
        const body = JSON.parse(readFileSync(file, "utf8"));
        const results = body?.data?.results;
        if (!Array.isArray(results)) process.exit(2);
        const bannedAsins = new Set(["B0BESTSELL", "B0VARIATN1", "B0BOOK0001"]);
        for (const item of results) {
          if (item == null || typeof item !== "object") process.exit(3);
          if (typeof item.asin !== "string" || !/^[A-Z0-9]{10}$/.test(item.asin)) process.exit(4);
          if (typeof item.title !== "string" || item.title.trim() === "") process.exit(5);
          if (bannedAsins.has(item.asin)) process.exit(6);
          if (/Recorded Echo Dot fixture/i.test(item.title)) process.exit(7);
        }
      ' && echo ok || echo bad
    )"
    if [[ "$search_ok" != "ok" ]]; then
      note "search: FAIL — invented, fixture, or malformed result"
      verdict="FAIL"
    else
      search_status="PASS"
      note "search: PASS — HTTP 200 results=${n} (empty is honest; none invented)"
    fi
  fi
elif [[ "$search_http" == "503" ]]; then
  code="$(json_get "$workdir/search.json" error.code || true)"
  charged="$(json_get "$workdir/search.json" meta.creditsCharged || true)"
  if [[ "$code" == "upstream_blocked" && "$charged" == "0" ]]; then
    search_status="PASS-ERROR"
    note "search: PASS-ERROR — HTTP 503 upstream_blocked, 0 credits (no hits invented)"
  else
    note "search: FAIL — HTTP 503 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
else
  note "search: FAIL — unexpected HTTP ${search_http}"
  verdict="FAIL"
fi

# Non-US host must 422 before fetch.
uk_status="FAIL"
if [[ "$uk_http" == "422" ]]; then
  code="$(json_get "$workdir/uk.json" error.code || true)"
  charged="$(json_get "$workdir/uk.json" meta.creditsCharged || true)"
  if [[ "$code" == "marketplace_unsupported" && "$charged" == "0" ]]; then
    uk_status="PASS"
    note "non-us: PASS — HTTP 422 marketplace_unsupported, 0 credits"
  else
    note "non-us: FAIL — HTTP 422 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
else
  note "non-us: FAIL — expected HTTP 422, got ${uk_http}"
  verdict="FAIL"
fi

# Offers stay 501 / 0 credits even with the live adapter.
offers_status="FAIL"
if [[ "$offers_http" == "501" ]]; then
  code="$(json_get "$workdir/offers.json" error.code || true)"
  charged="$(json_get "$workdir/offers.json" meta.creditsCharged || true)"
  if [[ "$code" == "not_implemented" && "$charged" == "0" ]]; then
    offers_status="PASS"
    note "offers: PASS — HTTP 501 not_implemented, 0 credits"
  else
    note "offers: FAIL — HTTP 501 code=${code:-?} credits=${charged:-?}"
    verdict="FAIL"
  fi
else
  note "offers: FAIL — expected HTTP 501, got ${offers_http}"
  verdict="FAIL"
fi

echo "== summary =="
echo "product=${product_status} reviews=${reviews_status} search=${search_status} non-us=${uk_status} offers=${offers_status} verdict=${verdict}"

if [[ "$verdict" != "PASS" ]]; then
  echo "---- product body ----" >&2
  cat "$workdir/product.json" >&2 || true
  echo "---- reviews body ----" >&2
  cat "$workdir/reviews.json" >&2 || true
  echo "---- search body ----" >&2
  cat "$workdir/search.json" >&2 || true
  echo "---- uk body ----" >&2
  cat "$workdir/uk.json" >&2 || true
  echo "---- offers body ----" >&2
  cat "$workdir/offers.json" >&2 || true
  fail "live-smoke verdict=${verdict}"
fi

echo "OK: live flags on; every required flow walked against real Amazon.com"
