// run-as-child <uid> [-g <gid>] [-G <gid>[,<gid>...]] [--] <command> [args...]
// Switches to a child user in the fixed range, forbids regaining privileges, and runs the command.
// It holds only CAP_SETUID and CAP_SETGID, and the only ids it will switch to are CHILD_ID_MIN..MAX.
//
//   -g <gid>   The primary group, also in the child range. The uid's own group when absent. A
//              workspace instance runs as its own uid with its server's group, so it may read
//              that server's install folder and nothing else of it.
//   -G <list>  Extra groups, such as a mounted folder's, comma-separated, at most MAX_EXTRA_GROUPS.
//              None may be a system group (below FIRST_EXTRA_GID), in the child range (another
//              server's), or one the caller holds (the router's own). The child has exactly these.
//   --         Ends the options, so a command may start with "-".
//
// Each option may be given once, ids are plain decimal digits, and anything else is refused.
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define CHILD_ID_MIN 10000
#define CHILD_ID_MAX 19999
// Below this are the system's groups: root, shadow (42), disk, kmem, adm, sudo and the like.
#define FIRST_EXTRA_GID 100
// The highest id taken: a positive 32-bit signed number, so (gid_t)-1 can never be asked for.
#define ID_MAX 2147483647L
// Digits in ID_MAX.
#define ID_MAX_DIGITS 10
#define MAX_EXTRA_GROUPS 8
// What a child creates is never writable by its group or anyone else unless it says so, whatever
// the router's own umask is, so a workspace instance can't write into its server's install folder.
#define CHILD_UMASK 022
#define DECIMAL 10

static int fail(const char *what) {
  fprintf(stderr, "run-as-child: %s\n", what);
  return 126;
}

// Reads one id of `len` characters: decimal digits only, no sign, space or leading zero, at most
// ID_MAX. Returns -1 for anything else.
static long parse_id(const char *text, size_t len) {
  if (len == 0 || len > ID_MAX_DIGITS || (len > 1 && text[0] == '0')) return -1;
  long value = 0;
  for (size_t i = 0; i < len; i++) {
    if (text[i] < '0' || text[i] > '9') return -1;
    value = value * DECIMAL + (text[i] - '0');
  }
  return value > ID_MAX ? -1 : value;
}

static int is_child_id(long id) {
  return id >= CHILD_ID_MIN && id <= CHILD_ID_MAX;
}

// Whether the caller holds a group, as its real, effective or supplementary group.
static int caller_holds(gid_t gid) {
  if (gid == getgid() || gid == getegid()) return 1;
  int count = getgroups(0, NULL);
  if (count < 0) return 1;
  if (count == 0) return 0;
  gid_t *held = calloc((size_t)count, sizeof(gid_t));
  if (held == NULL) return 1;
  int got = getgroups(count, held);
  int found = got < 0;
  for (int i = 0; i < got && found == 0; i++) {
    found = held[i] == gid;
  }
  free(held);
  return found;
}

// Reads -G's list into `groups`. Returns NULL when it is good, or why it isn't.
static const char *parse_groups(const char *list, gid_t *groups, size_t *count) {
  const char *start = list;
  for (;;) {
    const char *comma = strchr(start, ',');
    size_t len = comma == NULL ? strlen(start) : (size_t)(comma - start);
    long gid = parse_id(start, len);
    if (gid < 0) return "an extra group is not a group id";
    if (gid < FIRST_EXTRA_GID) return "an extra group is a system group";
    if (is_child_id(gid)) return "an extra group is in the child range";
    if (caller_holds((gid_t)gid)) return "an extra group is one the router holds";
    for (size_t i = 0; i < *count; i++) {
      if (groups[i] == (gid_t)gid) return "an extra group is given twice";
    }
    if (*count == MAX_EXTRA_GROUPS) return "too many extra groups";
    groups[*count] = (gid_t)gid;
    *count += 1;
    if (comma == NULL) return NULL;
    start = comma + 1;
  }
}

// Whether the process now holds exactly `count` supplementary groups, the ones in `groups`. The
// kernel sorts a group list when it is set, so they are compared as sets: no group is given twice.
static int holds_exactly(const gid_t *groups, size_t count) {
  gid_t held[MAX_EXTRA_GROUPS + 1];
  int got = getgroups(MAX_EXTRA_GROUPS + 1, held);
  if (got < 0 || (size_t)got != count) return 0;
  for (size_t i = 0; i < count; i++) {
    int found = 0;
    for (size_t j = 0; j < count && found == 0; j++) {
      found = held[j] == groups[i];
    }
    if (found == 0) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    return fail("usage: run-as-child <uid> [-g <gid>] [-G <gid>[,<gid>...]] [--] <command> [args...]");
  }
  long uid = parse_id(argv[1], strlen(argv[1]));
  if (is_child_id(uid) == 0) return fail("uid outside the child range");
  long gid = uid;
  gid_t groups[MAX_EXTRA_GROUPS];
  size_t group_count = 0;
  int has_gid = 0;
  int has_groups = 0;
  int next = 2;
  while (next < argc && argv[next][0] == '-') {
    const char *option = argv[next];
    if (strcmp(option, "--") == 0) {
      next += 1;
      break;
    }
    if (next + 1 >= argc) return fail("an option has no value");
    const char *value = argv[next + 1];
    if (strcmp(option, "-g") == 0 && has_gid == 0) {
      has_gid = 1;
      gid = parse_id(value, strlen(value));
      if (is_child_id(gid) == 0) return fail("gid outside the child range");
    } else if (strcmp(option, "-G") == 0 && has_groups == 0) {
      has_groups = 1;
      const char *problem = parse_groups(value, groups, &group_count);
      if (problem != NULL) return fail(problem);
    } else {
      return fail("unknown or repeated option");
    }
    next += 2;
  }
  if (next >= argc) return fail("no command");
  if (setgroups(group_count, groups) != 0) return fail("setgroups failed");
  if (setresgid((gid_t)gid, (gid_t)gid, (gid_t)gid) != 0) return fail("setresgid failed");
  if (setresuid((uid_t)uid, (uid_t)uid, (uid_t)uid) != 0) return fail("setresuid failed");
  // Switching between two non-root ids keeps capabilities, so drop every one explicitly.
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct none[_LINUX_CAPABILITY_U32S_3] = { { 0, 0, 0 } };
  if (syscall(SYS_capset, &header, none) != 0) return fail("dropping capabilities failed");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("no_new_privs failed");
  umask(CHILD_UMASK);
  // Belt and braces: there must be no way back, and the ids must be exactly the ones asked for.
  if (setuid(0) == 0 || setgid(0) == 0) return fail("could still switch back");
  if (getuid() != (uid_t)uid || geteuid() != (uid_t)uid) return fail("uid did not switch");
  if (getgid() != (gid_t)gid || getegid() != (gid_t)gid) return fail("gid did not switch");
  if (holds_exactly(groups, group_count) == 0) return fail("groups did not switch");
  execvp(argv[next], &argv[next]);
  return fail("exec failed");
}
