#!/bin/sh
# Checks, inside the real image as the router's user, that an MCP server started through
# run-as-child is a different user who can't get back, can't read the router's data, and holds
# no capability, and that servers' folders keep each server to its own. CI runs it with
# `docker compose exec ai-router sh scripts/check-children.sh`.
set -u
HELPER=${RUN_AS_CHILD:-/usr/local/bin/run-as-child}
CHILD=10000
OTHER_CHILD=10001
SERVERS=${SERVERS_DIR:-${DATA_DIR:-/data}/servers}
FOLDER="$SERVERS/$CHILD-check-$$"
failures=0

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }

# expect_output <label> <expected> <command...>
expect_output() {
  label=$1; expected=$2; shift 2
  actual=$("$@" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then pass "$label"; else fail "$label (got: $actual)"; fi
}

# expect_ok <label> <command...>
expect_ok() {
  label=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
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

# Servers' folders: the router owns $SERVERS with mode 1733, and each server makes its own, 0700.
expect_refused "a child cannot list the servers' folders" "$HELPER" "$CHILD" ls "$SERVERS"
expect_ok "a child can create its own folder there" "$HELPER" "$CHILD" mkdir -m 0700 "$FOLDER"
expect_ok "a child can write in its own folder" "$HELPER" "$CHILD" touch "$FOLDER/file"
expect_refused "another child cannot read that folder" "$HELPER" "$OTHER_CHILD" ls "$FOLDER"
expect_refused "another child cannot read a file in it" "$HELPER" "$OTHER_CHILD" cat "$FOLDER/file"
expect_refused "another child cannot delete that folder" "$HELPER" "$OTHER_CHILD" rm -rf "$FOLDER"
expect_ok "the folder is still there" test -d "$FOLDER"
expect_refused "the router cannot read that folder" ls "$FOLDER"
expect_ok "a child can delete its own folder" "$HELPER" "$CHILD" rm -rf "$FOLDER"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "every check passed"
