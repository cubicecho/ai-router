// run-as-child <uid> <command> [args...]
// Switches to a child user in the fixed range, forbids regaining privileges, and runs the command.
// It holds only CAP_SETUID and CAP_SETGID, and the only ids it will switch to are CHILD_ID_MIN..MAX.
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define CHILD_ID_MIN 10000
#define CHILD_ID_MAX 19999

static int fail(const char *what) {
  fprintf(stderr, "run-as-child: %s\n", what);
  return 126;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    return fail("usage: run-as-child <uid> <command> [args...]");
  }
  char *end = NULL;
  long id = strtol(argv[1], &end, 10);
  if (*argv[1] == '\0' || *end != '\0' || id < CHILD_ID_MIN || id > CHILD_ID_MAX) {
    return fail("uid outside the child range");
  }
  if (setgroups(0, NULL) != 0) return fail("setgroups failed");
  if (setresgid((gid_t)id, (gid_t)id, (gid_t)id) != 0) return fail("setresgid failed");
  if (setresuid((uid_t)id, (uid_t)id, (uid_t)id) != 0) return fail("setresuid failed");
  // Switching between two non-root ids keeps capabilities, so drop every one explicitly.
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct none[_LINUX_CAPABILITY_U32S_3] = { { 0, 0, 0 } };
  if (syscall(SYS_capset, &header, none) != 0) return fail("dropping capabilities failed");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("no_new_privs failed");
  // Belt and braces: there must be no way back.
  if (setuid(0) == 0 || getuid() != (uid_t)id || geteuid() != (uid_t)id) return fail("could still switch back");
  execvp(argv[2], &argv[2]);
  return fail("exec failed");
}
