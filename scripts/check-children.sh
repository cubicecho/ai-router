#!/bin/sh
# Checks, inside the real image as the router's user, that an MCP server started through
# run-as-child is a different user who can't get back, can't read the router's data, and holds
# no capability, that servers' folders keep each server to its own, that extra groups reach a shared
# folder and nothing else, and that a workspace instance can read its server's folder but not write
# it, nor read another instance's environment. CI runs it with
# `docker compose exec ai-router sh scripts/check-children.sh`.
set -u
HELPER=${RUN_AS_CHILD:-/usr/local/bin/run-as-child}
CHILD=10000
OTHER_CHILD=10001
# Two workspace instances of server $CHILD: their own uids, with $CHILD's group.
INSTANCE=10002
OTHER_INSTANCE=10003
# A mounted folder's group: `users`, on most hosts.
SHARED_GROUP=100
ROUTER_GID=$(id -g)
SERVERS=${SERVERS_DIR:-${DATA_DIR:-/data}/servers}
FOLDER="$SERVERS/$CHILD-check-$$"
SHARED="$SERVERS/$CHILD-shared-$$"
INSTANCE_HOME="$SERVERS/$INSTANCE-check-$$"
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

# The helper's options, refused in the helper itself whatever the router asks for.
expect_refused "the helper refuses primary gid 0" "$HELPER" "$CHILD" -g 0 id
expect_refused "the helper refuses the router's gid as the primary gid" "$HELPER" "$CHILD" -g "$ROUTER_GID" id
expect_refused "the helper refuses a primary gid past the range" "$HELPER" "$CHILD" -g 20000 id
expect_refused "the helper refuses extra group 0" "$HELPER" "$CHILD" -G 0 id
expect_refused "the helper refuses extra group shadow (42)" "$HELPER" "$CHILD" -G 42 id
expect_refused "the helper refuses a system group below 100" "$HELPER" "$CHILD" -G 6 id
expect_refused "the helper refuses the router's gid as an extra group" "$HELPER" "$CHILD" -G "$ROUTER_GID" id
expect_refused "the helper refuses a child-range extra group" "$HELPER" "$CHILD" -G 100,"$OTHER_CHILD" id
expect_refused "the helper refuses more than 8 extra groups" "$HELPER" "$CHILD" -G 101,102,103,104,105,106,107,108,109 id
expect_refused "the helper refuses a malformed group list" "$HELPER" "$CHILD" -G 100, id
expect_refused "the helper refuses a group with a sign" "$HELPER" "$CHILD" -G +100 id
expect_refused "the helper refuses a repeated group" "$HELPER" "$CHILD" -G 100,100 id
expect_refused "the helper refuses a repeated option" "$HELPER" "$CHILD" -G 100 -G 101 id
expect_refused "the helper refuses an unknown option" "$HELPER" "$CHILD" -u 0 id
expect_refused "the helper refuses options with no command" "$HELPER" "$CHILD" -G 100 --
expect_output "a child with -G has exactly those extra groups" "$CHILD $SHARED_GROUP" "$HELPER" "$CHILD" -G "$SHARED_GROUP" -- id -G
expect_output "a child with -g has that primary group" "$CHILD" "$HELPER" "$INSTANCE" -g "$CHILD" id -g
expect_output "a child with -g has no other group" "$CHILD" "$HELPER" "$INSTANCE" -g "$CHILD" id -G
expect_output "a child with groups still holds no capability" "CapEff:	0000000000000000" "$HELPER" "$CHILD" -G "$SHARED_GROUP" grep CapEff /proc/self/status
expect_refused "a child with groups cannot run the helper again" "$HELPER" "$CHILD" -G "$SHARED_GROUP" "$HELPER" "$CHILD" id
expect_output "a child creates files 0644 whatever the router's umask" "644" \
  sh -c 'umask 000; exec "$0" "$1" sh -c "touch /tmp/umask-\$\$; stat -c %a /tmp/umask-\$\$; rm /tmp/umask-\$\$"' "$HELPER" "$CHILD"

# A mounted folder: on the host it is chgrp'd to the shared group, g+rwX and g+s. A child holding the
# group sets one up here the same way, since the router itself may not hand out that group.
expect_ok "a child with the shared group can set up a shared folder" \
  "$HELPER" "$CHILD" -G "$SHARED_GROUP" sh -c "mkdir -m 0770 '$SHARED' && chgrp $SHARED_GROUP '$SHARED' && chmod 2770 '$SHARED'"
expect_ok "a child with -G $SHARED_GROUP can write the shared folder" \
  "$HELPER" "$OTHER_CHILD" -G "$SHARED_GROUP" sh -c "echo hi > '$SHARED/note'"
expect_output "a child with -G $SHARED_GROUP can read the shared folder" "hi" \
  "$HELPER" "$CHILD" -G "$SHARED_GROUP" cat "$SHARED/note"
expect_output "a file made there keeps the shared group" "$SHARED_GROUP" "$HELPER" "$CHILD" -G "$SHARED_GROUP" stat -c %g "$SHARED/note"
expect_refused "a child without the group cannot read the shared folder" "$HELPER" "$OTHER_CHILD" ls "$SHARED"
expect_refused "the router cannot read the shared folder" ls "$SHARED"
expect_ok "a child with the group can delete the shared folder" "$HELPER" "$CHILD" -G "$SHARED_GROUP" rm -rf "$SHARED"

# A server's install folder is 0750 with its own group, and its HOME inside is 0700. A workspace
# instance runs as its own uid with the server's group, in a 0700 HOME of its own.
expect_ok "a server makes its install folder 0750 with a 0700 home" \
  "$HELPER" "$CHILD" sh -c "mkdir -m 0700 '$FOLDER' '$FOLDER/home' && chmod 0750 '$FOLDER' && echo code > '$FOLDER/server.js' && echo secret > '$FOLDER/home/token'"
expect_output "a workspace instance can read its server's folder" "code" "$HELPER" "$INSTANCE" -g "$CHILD" cat "$FOLDER/server.js"
expect_refused "a workspace instance cannot write its server's folder" "$HELPER" "$INSTANCE" -g "$CHILD" touch "$FOLDER/new"
expect_refused "a workspace instance cannot change its server's files" \
  "$HELPER" "$INSTANCE" -g "$CHILD" sh -c "echo x >> '$FOLDER/server.js'"
expect_refused "a workspace instance cannot read its server's home" "$HELPER" "$INSTANCE" -g "$CHILD" cat "$FOLDER/home/token"
expect_refused "another server's instance cannot read the folder" "$HELPER" "$OTHER_INSTANCE" ls "$FOLDER"
expect_refused "a server with extra groups cannot read another server's folder" \
  "$HELPER" "$OTHER_CHILD" -G "$SHARED_GROUP" ls "$FOLDER"
expect_ok "a workspace instance can make its own home" "$HELPER" "$INSTANCE" -g "$CHILD" mkdir -m 0700 "$INSTANCE_HOME"
expect_ok "a workspace instance can write its own home" "$HELPER" "$INSTANCE" -g "$CHILD" touch "$INSTANCE_HOME/state"
expect_refused "its server cannot read that home" "$HELPER" "$CHILD" ls "$INSTANCE_HOME"
expect_refused "another instance of the server cannot read that home" "$HELPER" "$OTHER_INSTANCE" -g "$CHILD" ls "$INSTANCE_HOME"

# Two workspace instances of one server hold their workspaces' credentials in their environments.
# The helper execs in place, so the background job's pid is the instance's own.
"$HELPER" "$INSTANCE" -g "$CHILD" env WORKSPACE_SECRET=household-a sleep 60 &
instance_pid=$!
sleep 1
expect_ok "an instance can read its own environment" "$HELPER" "$INSTANCE" -g "$CHILD" grep -q household-a "/proc/$instance_pid/environ"
expect_refused "another instance of the server cannot read it" \
  "$HELPER" "$OTHER_INSTANCE" -g "$CHILD" cat "/proc/$instance_pid/environ"
expect_refused "the server's base instance cannot read it" "$HELPER" "$CHILD" cat "/proc/$instance_pid/environ"
expect_refused "another instance of the server cannot signal it" \
  "$HELPER" "$OTHER_INSTANCE" -g "$CHILD" node -e "process.kill($instance_pid, 'SIGTERM')"
expect_refused "the router cannot read it" cat "/proc/$instance_pid/environ"
expect_ok "the instance's own uid can stop it" "$HELPER" "$INSTANCE" -g "$CHILD" node -e "process.kill($instance_pid, 'SIGTERM')"
wait "$instance_pid" 2>/dev/null
expect_ok "a workspace instance can delete its own home" "$HELPER" "$INSTANCE" -g "$CHILD" rm -rf "$INSTANCE_HOME"
expect_ok "a server can delete its install folder" "$HELPER" "$CHILD" rm -rf "$FOLDER"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "every check passed"
