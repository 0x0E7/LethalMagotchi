#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080/api/v1}"
USERNAME="${1:-smoke_$RANDOM}"
PASSWORD="correct-horse-battery"
JAR="$(mktemp)"

say() { printf '\n=== %s ===\n' "$1"; }

say "reference"
curl -s "$BASE/reference" | head -c 200; echo

say "username availability (free)"
curl -s "$BASE/auth/username-available?username=$USERNAME"; echo

say "register $USERNAME"
REGISTER=$(curl -s -c "$JAR" -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
echo "$REGISTER" | head -c 300; echo
TOKEN=$(echo "$REGISTER" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

say "username availability (taken)"
curl -s "$BASE/auth/username-available?username=$USERNAME"; echo

say "duplicate register -> expect 409"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}"

say "me (no character yet)"
curl -s "$BASE/me" -H "Authorization: Bearer $TOKEN"; echo

say "create character"
curl -s -X POST "$BASE/characters" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speciesId":"otter","nickname":"Miso","bio":"Collects river rocks.","originCountry":"JP","originCity":"Kyoto","occupationId":"chef","personalityId":"daydreamer"}'; echo

say "second create -> expect 409 CHARACTER_EXISTS"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/characters" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speciesId":"crow","nickname":"Second","bio":"","originCountry":"FR","originCity":null,"occupationId":"miner","personalityId":"grump"}'

say "invalid payload -> expect 422"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/characters" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speciesId":"dragon","nickname":"x","bio":"","originCountry":"ZZ","occupationId":"chef","personalityId":"grump"}'

say "patch character"
curl -s -X PATCH "$BASE/characters/me" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"nickname":"Miso Prime"}' | head -c 200; echo

say "login"
curl -s -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" | head -c 200; echo

say "login wrong password -> expect 401 generic"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"totally-wrong-pass\"}"

say "refresh (cookie)"
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/auth/refresh" | head -c 120; echo

say "logout"
curl -s -o /dev/null -w '%{http_code}\n' -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout"

say "refresh after logout -> expect 401"
curl -s -o /dev/null -w '%{http_code}\n' -b "$JAR" -X POST "$BASE/auth/refresh"

rm -f "$JAR"
