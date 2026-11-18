#!/bin/sh
# Checks, inside the real image as the router's user, that an MCP server started through
# run-as-child is a different user who can't get back, can't read the router's data, and holds
# no capability. CI runs it with `docker compose exec ai-router sh scripts/check-children.sh`.
set -u
HELPER=${RUN_AS_CHILD:-/usr/local/bin/run-as-child}
CHILD=10000
failures=0

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }

# expect_output <label> <expected> <command...>
expect_output() {
  label=$1; expected=$2; shift 2
  actual=$("$@" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (got: $actual)"; fi
}

# expect_refused <label> <command...>
expect_refused() {
  label=$1; shift
  if "$@" >/dev/null 2>&1; then fail "$label"; else pass "$label"; fi
}

expect_output "the router itself is uid 1000" "1000" id -u
expect_output "the router holds no capability" "CapEff:	0000000000000000" grep CapEff /proc/self/status
expect_output "a child runs as its uid" "$CHILD" "$HELPER" "$CHILD" id -u
expect_output "a child has only its own group" "$CHILD" "$HELPER" "$CHILD" id -G
expect_output "a child holds no capability" "CapEff:	0000000000000000" "$HELPER" "$CHILD" grep CapEff /proc/self/status
expect_refused "the helper refuses root" "$HELPER" 0 id
expect_refused "the helper refuses the router's uid" "$HELPER" 1000 id
expect_refused "the helper refuses a uid past the range" "$HELPER" 20000 id
expect_refused "a child cannot read the router's data" "$HELPER" "$CHILD" ls "${DATA_DIR:-/data}"
expect_refused "a child cannot read the router's environment" "$HELPER" "$CHILD" cat /proc/1/environ
expect_refused "a child cannot run the helper again" "$HELPER" "$CHILD" "$HELPER" 10001 id

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "every check passed"
