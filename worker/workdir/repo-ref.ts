import { WorkdirRefusal } from './refusal.ts';

/** A repo `open_repo` can check out, and where its checkout goes under the root. */
export interface RepoRef {
  /** Lowercase host name, the checkout's first folder. */
  host: string;
  owner: string;
  /** The repo's name, without `.git`. */
  name: string;
  /** What `git clone` is given. */
  cloneUrl: string;
}

/** The host a bare `owner/name` means. */
const DEFAULT_HOST = 'github.com';
/** The suffix a clone URL may carry after the repo's name. */
const GIT_SUFFIX = '.git';
/** An owner or a repo name: starts with a letter, digit or `_`, so never `.`, `..` or an option. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** A DNS host name, in lowercase labels. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** `owner/name`, with an optional `.git`. */
const SHORT_FORM = /^([^/:@]+)\/([^/:@]+)$/;
/** scp-like ssh, `git@host:owner/name.git`. */
const SSH_FORM = /^git@([^/:@]+):([^/:@]+)\/([^/:@]+)$/;
/** A repo cloned over https. */
const CLONE_HTTPS = 'https' as const;
/** A repo cloned over ssh. */
const CLONE_SSH = 'ssh' as const;
/** The URL scheme an https repo is named with. */
const HTTPS_PROTOCOL = 'https:';
/** An https URL's path, `/owner/name`. */
const HTTPS_PATH = /^\/([^/]+)\/([^/]+)$/;

/**
 * Reads a repo string into the repo it names.
 *
 * @param repo - `owner/name` (on GitHub), `https://host/owner/name.git` or `git@host:owner/name.git`.
 * @returns The repo and its clone URL.
 * @throws {@link WorkdirRefusal} If the string is none of those, or a part of it could leave the root.
 */
export function parseRepo(repo: string): RepoRef {
  const trimmed = repo.trim();
  const short = SHORT_FORM.exec(trimmed);
  if (short) {
    const [, owner = '', name = ''] = short;
    return buildRef(DEFAULT_HOST, owner, name, CLONE_HTTPS, repo);
  }
  const ssh = SSH_FORM.exec(trimmed);
  if (ssh) {
    const [, host = '', owner = '', name = ''] = ssh;
    return buildRef(host, owner, name, CLONE_SSH, repo);
  }
  if (trimmed.startsWith(`${HTTPS_PROTOCOL}//`)) {
    return parseHttpsRepo(trimmed, repo);
  }
  throw refuseRepo(repo, 'it is not `owner/name`, an https URL or `git@host:owner/name.git`');
}

/**
 * Reads an https repo URL.
 *
 * @param url - The trimmed string, starting `https://`.
 * @param repo - The string as sent, for the refusal.
 * @returns The repo.
 * @throws {@link WorkdirRefusal} If the URL has a login, a port, a query or a path other than `/owner/name`.
 */
function parseHttpsRepo(url: string, repo: string): RepoRef {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed === null) {
    throw refuseRepo(repo, 'it is not a valid URL');
  }
  const hasExtras = parsed.username !== '' || parsed.password !== '' || parsed.port !== '';
  if (hasExtras || parsed.search !== '' || parsed.hash !== '') {
    throw refuseRepo(repo, 'an https URL may hold only a host and `/owner/name`, with no login, port or query');
  }
  const path = HTTPS_PATH.exec(parsed.pathname);
  if (path === null) {
    throw refuseRepo(repo, 'its path must be exactly `/owner/name`');
  }
  const [, owner = '', name = ''] = path;
  return buildRef(parsed.hostname, owner, name, CLONE_HTTPS, repo);
}

/**
 * Checks each part of a repo and builds its clone URL.
 *
 * @param host - Host name as written.
 * @param owner - Owner as written.
 * @param rawName - Name as written, maybe ending `.git`.
 * @param scheme - How the repo is cloned.
 * @param repo - The string as sent, for the refusal.
 * @returns The repo.
 * @throws {@link WorkdirRefusal} If a part has a character a folder name shouldn't.
 */
function buildRef(
  host: string,
  owner: string,
  rawName: string,
  scheme: typeof CLONE_HTTPS | typeof CLONE_SSH,
  repo: string,
): RepoRef {
  const lowerHost = host.toLowerCase();
  const name = rawName.endsWith(GIT_SUFFIX) ? rawName.slice(0, -GIT_SUFFIX.length) : rawName;
  if (HOST.test(lowerHost) === false) {
    throw refuseRepo(repo, `\`${host}\` is not a host name`);
  }
  for (const segment of [owner, name]) {
    const isUnsafe = SEGMENT.test(segment) === false || segment.includes('..');
    if (isUnsafe) {
      throw refuseRepo(repo, `\`${segment}\` may hold only letters, digits, \`.\`, \`_\` and \`-\`, and not \`..\``);
    }
  }
  const cloneUrl =
    scheme === CLONE_SSH
      ? `git@${lowerHost}:${owner}/${name}${GIT_SUFFIX}`
      : `https://${lowerHost}/${owner}/${name}${GIT_SUFFIX}`;
  return { host: lowerHost, owner, name, cloneUrl };
}

/**
 * Builds the refusal for a repo string.
 *
 * @param repo - The string as sent.
 * @param reason - What is wrong with it.
 * @returns The refusal, for the caller to throw.
 */
function refuseRepo(repo: string, reason: string): WorkdirRefusal {
  return new WorkdirRefusal(`Can't open repo ${JSON.stringify(repo)}: ${reason}.`);
}
