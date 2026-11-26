import { type Runtime, runAgentLoop } from '@cubicecho/agent-core';
import type { WorkerSettings } from '../server/core/defaults.ts';
import { errorMessage } from '../server/core/errors.ts';
import {
  type ChannelMessage,
  ChannelMessageType,
  WORKERS_PATH,
  WorkerDoor,
  type WorkerHello,
} from '../server/runner/protocol.ts';
import { type Channel, openChannel } from './channel.ts';
import type { WorkerConfig } from './config.ts';
import type { WorkdirSettings, WorkerProgramSettings } from './defaults.ts';
import { createRunHost, type RunHost } from './run.ts';
import { type LocalServers, startLocalServers } from './servers.ts';
import { workerVersion } from './version.ts';
import type { GitRunner } from './workdir/git.ts';

/** What the worker talks to besides its config. Tests pass stand-ins. */
export interface WorkerDeps {
  /**
   * Makes every request to the router.
   *
   * @defaultValue `globalThis.fetch`
   */
  fetch?: typeof globalThis.fetch;
  /**
   * The loop's runtime.
   *
   * @defaultValue agent-core's `runAgentLoop`
   */
  runtime?: Pick<Runtime, 'runAgentLoop'>;
  /**
   * The environment a command server's allowlist reads from.
   *
   * @defaultValue `process.env`
   */
  baseEnv?: NodeJS.ProcessEnv;
  /** Runs git for `workdir`. */
  git?: GitRunner;
  /** Settings that replace the defaults: the channel's, the runs', the local servers'. */
  settings?: Partial<WorkerSettings & WorkerProgramSettings>;
  /** Settings for `workdir`. */
  workdir?: Partial<WorkdirSettings>;
}

/** A worker that is running. */
export interface RunningWorker {
  /** Its own servers. */
  local: LocalServers;
  /** Its runs. */
  runs: RunHost;
  /** Its channel to the router. */
  channel: Channel;
  /**
   * Stops it: drops the channel, stops and finishes every run, closes the local servers.
   *
   * @returns Resolves once all of that is done.
   */
  stop(): Promise<void>;
}

/**
 * Starts a worker: its local servers, then its channel to the router, whose assignments it runs.
 *
 * @param config - The router, the key, the work root, the host and the servers.
 * @param [deps] - Stand-ins for what it talks to, and settings.
 * @returns The running worker.
 */
export async function startWorker(config: WorkerConfig, deps: WorkerDeps = {}): Promise<RunningWorker> {
  const { url, key, root, host, servers } = config;
  const { fetch = globalThis.fetch, runtime = { runAgentLoop }, baseEnv, git, settings = {}, workdir } = deps;
  let channel: Channel | undefined;

  const sayHello = async (): Promise<void> => {
    // Its runs, so a router that sent it runs before it restarted ends those it no longer has.
    const hello: WorkerHello = { host, version: workerVersion(), servers: local.listing(), runs: runs.ids() };
    const response = await fetch(`${url}${WORKERS_PATH}${WorkerDoor.Hello}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(hello),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok === false) {
      throw new Error(`the router refused the hello: ${response.status}`);
    }
  };

  const local = await startLocalServers(
    {
      root,
      servers,
      ...(baseEnv === undefined ? {} : { baseEnv }),
      ...(git === undefined ? {} : { git }),
      ...(workdir === undefined ? {} : { workdir }),
      onChange: () => {
        // A channel that is down says the new tools in the hello it opens with.
        if (channel?.isOpen()) {
          sayHello().catch((error) => console.error(`[worker] could not say the new tools: ${errorMessage(error)}`));
        }
      },
    },
    settings,
  );
  const runs = createRunHost({ url, key, local, runtime, fetch }, settings);
  const onMessage = (message: ChannelMessage): void => {
    if (message.type === ChannelMessageType.Assign) {
      runs.assign(message.assignment);
    }
    if (message.type === ChannelMessageType.Cancel) {
      runs.cancel(message.runId, message.reason);
    }
  };
  const opened = openChannel(
    {
      url,
      key,
      fetch,
      onOpen: async () => {
        await sayHello();
        console.log(`[worker] connected to ${url} as ${host}`);
      },
      onMessage,
    },
    settings,
  );
  channel = opened;

  return {
    local,
    runs,
    channel: opened,
    stop: async () => {
      await opened.close();
      await runs.stop();
      await local.close();
    },
  };
}
