import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WORKDIR_DEFAULTS, type WorkdirSettings } from '../../../worker/defaults.ts';
import type { GitResult, GitRunner, GitRunOptions } from '../../../worker/workdir/git.ts';
import { createWorkdirServer } from '../../../worker/workdir/server.ts';

/** The sha the fake git reports for HEAD. */
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
/** The branch the fake git reports. */
const BRANCH = 'main';

/** One git command the fake was asked to run. */
interface GitCall {
  args: readonly string[];
  options: GitRunOptions;
}

/** A fake git and the calls it saw. */
interface FakeGit {
  run: GitRunner;
  calls: GitCall[];
}

/**
 * Builds a git stand-in: a clone makes the folder with a `.git` in it, and HEAD is on `main`.
 *
 * @param [cloneResult] - What a clone answers; a failing one makes nothing.
 * @returns The runner and its calls.
 */
function fakeGit(cloneResult: GitResult = { exitCode: 0, stdout: '', stderr: '' }): FakeGit {
  const calls: GitCall[] = [];
  const run: GitRunner = async (args, options) => {
    calls.push({ args, options });
    const [command] = args;
    if (command === 'clone') {
      const target = args.at(-1) ?? '';
      if (cloneResult.exitCode === 0) {
        await mkdir(join(target, '.git'), { recursive: true });
      }
      return cloneResult;
    }
    const stdout = command === 'symbolic-ref' ? `${BRANCH}\n` : `${HEAD_SHA}\n`;
    return { exitCode: 0, stdout, stderr: '' };
  };
  return { run, calls };
}

/** What one tool call answered. */
interface ToolAnswer {
  isError: boolean;
  text: string;
}

/** A client connected in memory to a workdir server. */
interface Harness {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  close: () => Promise<void>;
}

/**
 * Connects a client to a workdir server over the SDK's in-memory transport.
 *
 * @param root - The server's root.
 * @param git - The runner it uses.
 * @param [overrides] - Settings for this server.
 * @returns A way to call its tools.
 */
async function connect(root: string, git: GitRunner, overrides: Partial<WorkdirSettings> = {}): Promise<Harness> {
  const server = createWorkdirServer({ root, git }, overrides);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  const call: Harness['call'] = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks.map((block: { text?: string }) => block.text ?? '').join('');
    return { isError: result.isError === true, text };
  };
  return { call, close: () => client.close() };
}

describe('workdir server', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ai-router-workdir-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'ai-router-outside-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe('open_repo', () => {
    it('returns a checkout that is already there, without cloning', async () => {
      const checkout = join(root, 'github.com', 'acme', 'widgets');
      await mkdir(join(checkout, '.git'), { recursive: true });
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo: 'acme/widgets' });

      expect(answer.isError).toBe(false);
      expect(JSON.parse(answer.text)).toEqual({ path: checkout, cloned: false, branch: BRANCH, head: HEAD_SHA });
      expect(git.calls.map((call) => call.args[0])).not.toContain('clone');
      await harness.close();
    });

    it('clones `owner/name` from GitHub with an argument array, after `--`', async () => {
      const git = fakeGit();
      const harness = await connect(root, git.run, { cloneTimeoutMs: 1234 });

      const answer = await harness.call('open_repo', { repo: 'acme/widgets' });

      const checkout = join(root, 'github.com', 'acme', 'widgets');
      expect(JSON.parse(answer.text)).toEqual({ path: checkout, cloned: true, branch: BRANCH, head: HEAD_SHA });
      const clone = git.calls.find((call) => call.args[0] === 'clone');
      expect(clone?.args).toEqual(['clone', '--', 'https://github.com/acme/widgets.git', checkout]);
      expect(clone?.options.timeoutMs).toBe(1234);
      await harness.close();
    });

    it('uses the clone timeout from the defaults when none is given', async () => {
      const git = fakeGit();
      const harness = await connect(root, git.run);

      await harness.call('open_repo', { repo: 'acme/widgets' });

      const clone = git.calls.find((call) => call.args[0] === 'clone');
      expect(clone?.options.timeoutMs).toBe(WORKDIR_DEFAULTS.cloneTimeoutMs);
      await harness.close();
    });

    it.each([
      ['https://GitHub.com/acme/widgets.git', 'https://github.com/acme/widgets.git', 'github.com/acme/widgets'],
      ['https://git.example.com/team/app', 'https://git.example.com/team/app.git', 'git.example.com/team/app'],
      ['git@gitlab.example.com:team/app.git', 'git@gitlab.example.com:team/app.git', 'gitlab.example.com/team/app'],
    ])('clones %s from %s into %s', async (repo, cloneUrl, folder) => {
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo });

      const clone = git.calls.find((call) => call.args[0] === 'clone');
      expect(clone?.args[2]).toBe(cloneUrl);
      expect(JSON.parse(answer.text).path).toBe(join(root, folder));
      await harness.close();
    });

    it('answers a failed clone as a tool error with what git said', async () => {
      const git = fakeGit({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found\n' });
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo: 'acme/missing' });

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('repository not found');
      await harness.close();
    });

    it.each([
      '../x',
      '/etc',
      'acme/..',
      '../acme/widgets',
      'acme/../widgets',
      '-acme/widgets',
      'acme/.hidden',
      'acme/wid gets',
      'acme/widgets;rm',
      'acme/widgets/extra',
      '',
      'https://user:secret@github.com/acme/widgets.git',
      'https://github.com:8443/acme/widgets.git',
      'https://github.com/acme/widgets/tree/main',
      'https://github.com/acme/widgets?x=1',
      'http://github.com/acme/widgets.git',
      'file:///etc/passwd',
      'ext::sh -c touch% /tmp/pwned',
      'git@evil_host:acme/widgets.git',
      'git@github.com:../widgets.git',
    ])('refuses %j without running git', async (repo) => {
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo });

      expect(answer.isError).toBe(true);
      expect(git.calls).toEqual([]);
      await harness.close();
    });

    it('refuses a host folder that is a symlink out of the root, and makes nothing there', async () => {
      await symlink(outside, join(root, 'github.com'));
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo: 'acme/widgets' });

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('outside the work root');
      expect(git.calls).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
      await harness.close();
    });

    it('refuses a checkout that is a symlink out of the root', async () => {
      await mkdir(join(outside, '.git'));
      await mkdir(join(root, 'github.com', 'acme'), { recursive: true });
      await symlink(outside, join(root, 'github.com', 'acme', 'widgets'));
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo: 'acme/widgets' });

      expect(answer.isError).toBe(true);
      expect(git.calls).toEqual([]);
      await harness.close();
    });

    it('refuses a folder that is there but is not a git checkout', async () => {
      await mkdir(join(root, 'github.com', 'acme', 'widgets'), { recursive: true });
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answer = await harness.call('open_repo', { repo: 'acme/widgets' });

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('not a git checkout');
      expect(git.calls).toEqual([]);
      await harness.close();
    });

    it('clones once when two calls open the same repo at the same time', async () => {
      const git = fakeGit();
      const harness = await connect(root, git.run);

      const answers = await Promise.all([
        harness.call('open_repo', { repo: 'acme/widgets' }),
        harness.call('open_repo', { repo: 'git@github.com:acme/widgets.git' }),
      ]);

      expect(answers.map((answer) => answer.isError)).toEqual([false, false]);
      expect(git.calls.filter((call) => call.args[0] === 'clone')).toHaveLength(1);
      await harness.close();
    });
  });

  describe('list_dir', () => {
    beforeEach(async () => {
      const checkout = join(root, 'repo');
      await mkdir(join(checkout, '.git', 'objects'), { recursive: true });
      await mkdir(join(checkout, 'src', 'deep'), { recursive: true });
      await writeFile(join(checkout, 'README.md'), 'hello');
      await writeFile(join(checkout, 'src', 'index.ts'), 'export {};');
      await writeFile(join(checkout, 'src', 'deep', 'leaf.ts'), '');
      await symlink(outside, join(checkout, 'escape'));
    });

    it("lists a directory's own entries with their type and size", async () => {
      const harness = await connect(root, fakeGit().run);

      const answer = await harness.call('list_dir', { path: 'repo' });

      expect(answer.isError).toBe(false);
      expect(JSON.parse(answer.text)).toEqual({
        path: join(root, 'repo'),
        depth: 1,
        depthCapped: false,
        truncated: false,
        entries: [
          { path: '.git', type: 'dir', size: null },
          { path: 'src', type: 'dir', size: null },
          { path: 'escape', type: 'symlink', size: null },
          { path: 'README.md', type: 'file', size: 'hello'.length },
        ],
      });
      await harness.close();
    });

    it('descends to the asked depth, but never into .git or a symlink', async () => {
      const harness = await connect(root, fakeGit().run);

      const answer = await harness.call('list_dir', { path: join(root, 'repo'), depth: 3 });

      const paths = JSON.parse(answer.text).entries.map((entry: { path: string }) => entry.path);
      expect(paths).toEqual(['.git', 'src', 'src/deep', 'src/deep/leaf.ts', 'src/index.ts', 'escape', 'README.md']);
      await harness.close();
    });

    it('stops at maxEntries and says it was truncated', async () => {
      const harness = await connect(root, fakeGit().run, { maxEntries: 2 });

      const answer = await harness.call('list_dir', { path: 'repo', depth: 3 });

      const listing = JSON.parse(answer.text);
      expect(listing.entries).toHaveLength(2);
      expect(listing.truncated).toBe(true);
      await harness.close();
    });

    it('caps the depth at maxDepth and says so', async () => {
      const harness = await connect(root, fakeGit().run);

      const answer = await harness.call('list_dir', { path: '.', depth: WORKDIR_DEFAULTS.maxDepth + 1 });

      const listing = JSON.parse(answer.text);
      expect(listing.depth).toBe(WORKDIR_DEFAULTS.maxDepth);
      expect(listing.depthCapped).toBe(true);
      await harness.close();
    });

    it.each(['..', '../x', '/etc', 'repo/../..', 'repo/escape', 'repo/missing', 'repo/README.md'])(
      'refuses %j',
      async (path) => {
        const harness = await connect(root, fakeGit().run);

        const answer = await harness.call('list_dir', { path });

        expect(answer.isError).toBe(true);
        await harness.close();
      },
    );

    it('says a symlink out of the root is outside it', async () => {
      const harness = await connect(root, fakeGit().run);

      const answer = await harness.call('list_dir', { path: 'repo/escape' });

      expect(answer.text).toContain('outside the work root');
      await harness.close();
    });
  });
});
