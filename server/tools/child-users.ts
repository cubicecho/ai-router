import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { isProduction, runAsChildPath } from '../core/config.ts';
import { CHILD_DEFAULTS, type ChildSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';

const run = promisify(execFile);

/** How MCP servers started over stdio will run, decided once at boot. */
export const ChildMode = {
  /** Each server as its own user, through `run-as-child`. */
  Isolated: 'isolated',
  /** As the router's own user, because the helper isn't installed. Development only. */
  Shared: 'shared',
  /** Not at all: the helper is missing in production, or present and unable to switch users. */
  Refused: 'refused',
} as const;
export type ChildMode = (typeof ChildMode)[keyof typeof ChildMode];

/** What the boot check found. */
export interface ChildIsolation {
  mode: ChildMode;
  /** Why, as a sentence, for the boot log and for every refused server. Empty when isolated. */
  reason: string;
}

/** What the check needs, so a test can stand in for the helper. */
export interface ChildCheckOptions {
  /** The helper's path. */
  helperPath?: string;
  /** Whether this is a production router, where running as the router's own user is refused. */
  production?: boolean;
  /** Settings that differ from `CHILD_DEFAULTS`. */
  overrides?: Partial<ChildSettings>;
}

/**
 * Whether a file can be executed by this process.
 *
 * @param file - The path.
 * @returns true when it exists and this user may run it.
 */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks, once at boot, whether stdio MCP servers can run as their own users.
 *
 * @param [options] - The helper's path, the mode and settings, for tests.
 * @returns The mode, and why.
 *
 * @remarks
 * Runs `id -u` through the helper as the lowest child uid. `--security-opt no-new-privileges` turns
 * the helper's file capabilities off, and that shows up here as a refusal, not at a server's first start.
 */
export async function checkChildIsolation({
  helperPath = runAsChildPath(),
  production = isProduction(),
  overrides = {},
}: ChildCheckOptions = {}): Promise<ChildIsolation> {
  const { uidMin, checkTimeoutMs } = { ...CHILD_DEFAULTS, ...overrides };
  if (isExecutable(helperPath) === false) {
    if (production) {
      return {
        mode: ChildMode.Refused,
        reason: `${helperPath} is missing or not executable by the router, so stdio servers cannot run as their own users. Use the published image, or set RUN_AS_CHILD to where the helper is.`,
      };
    }
    return {
      mode: ChildMode.Shared,
      reason: `${helperPath} is not installed, so stdio servers will run as the router's own user and can read its secrets. Fine on a laptop; refused when NODE_ENV=production.`,
    };
  }
  try {
    const { stdout } = await run(helperPath, [String(uidMin), 'id', '-u'], { timeout: checkTimeoutMs, env: {} });
    const isSwitched = stdout.trim() === String(uidMin);
    if (isSwitched) {
      return { mode: ChildMode.Isolated, reason: '' };
    }
    return { mode: ChildMode.Refused, reason: `${helperPath} ran, but as uid ${stdout.trim()}, not ${uidMin}.` };
  } catch (error) {
    return {
      mode: ChildMode.Refused,
      reason: `${helperPath} cannot switch users (${errorMessage(error).trim()}). A container started with no-new-privileges turns its capabilities off; start it without that option.`,
    };
  }
}
