#!/usr/bin/env bash
# End-to-end tests against a scripted mock model. Isolated: uses a throwaway
# PI_CODING_AGENT_DIR and project directory, never ~/.pi/agent.
set -uo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pi-pstack-test.XXXXXX")"
PORT="${PORT:-18765}"
export PI_CODING_AGENT_DIR="$WORK/agent" PI_OFFLINE=1
mkdir -p "$PI_CODING_AGENT_DIR" "$WORK/proj"
cat >"$PI_CODING_AGENT_DIR/models.json" <<EOF
{ "providers": { "mock": {
  "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "mock",
  "compat": { "supportsDeveloperRole": false },
  "models": [ { "id": "mock-a", "name": "mock-a", "contextWindow": 128000 },
              { "id": "mock-b", "name": "mock-b", "contextWindow": 128000, "reasoning": true } ] } } }
EOF
echo '{ "defaultProvider": "mock", "defaultModel": "mock-a" }' >"$PI_CODING_AGENT_DIR/settings.json"

node "$PKG/test/mock-server.mjs" "$PORT" "$WORK/requests.jsonl" >/dev/null &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 0.5

pass=0 fail=0
run() { (cd "$WORK/proj" && pi -e "$PKG" --no-session -p "$1" </dev/null 2>&1); }
check() {
	local name="$1" out="$2"; shift 2
	for pat in "$@"; do
		if ! grep -qE -- "$pat" <<<"$out"; then
			echo "FAIL $name: missing /$pat/"; echo "$out" | sed 's/^/    /' | head -30; fail=$((fail + 1)); return
		fi
	done
	echo "ok   $name"; pass=$((pass + 1))
}

check prompt "$(run TEST_PROMPT)" "pstack=true" "models=false" "Task" "Await" "AskQuestion" "PstackModels"

mkdir -p "$WORK/proj/.pi"
printf 'feature, refactoring: mock/mock-b:high\n' >"$WORK/proj/.pi/pstack-models.md"
check models-file "$(run TEST_PROMPT)" "models=true"
rm -rf "$WORK/proj/.pi"

check sync-fallback "$(run TEST_SYNC)" "child ok" "agent: poteto-agent" "not available in pi" "agent_prompt=true" "poteto_skill=true" "pstack_section=true"
check model-select "$(run TEST_MODEL)" "model: mock/mock-b:low" "child ok"
check parallel "$(run TEST_PARALLEL)" "alpha" "beta" "gamma" "agent: Comment Sicko"
ro="$(run TEST_READONLY)"
check readonly "$ro" "child ok" "tools=[^ ]*read"
if grep -qE 'tools=[^ ]*(\+edit|\+write)' <<<"$ro"; then echo "FAIL readonly: edit/write still enabled"; fail=$((fail + 1)); fi
check background "$(run TEST_BG)" "Background tasks finished" "child ok .*background"
check resume "$(run TEST_RESUME)" "child ok turn=2 .*second turn"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
