import { createRuntime, type RunEvent, type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { WorkerSettings } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus, MODELS_BASE_URL } from '../../server/core/wire.ts';
import { providers } from '../../server/db/tables/providers.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { Role } from '../../server/db/tables/users.ts';
import { workers } from '../../server/db/tables/workers.ts';
import type { RunAssignment, RunOutcome, RunPorts } from '../../server/runner/assignment.ts';
import { executeRun } from '../../server/runner/execute.ts';
import {
  type ChannelMessage,
  ChannelMessageType,
  type LocalServer,
  type RouterToolAnswer,
  RUN_NOT_FOUND,
  runDoorPath,
  WORKERS_PATH,
  WorkerDoor,
} from '../../server/runner/protocol.ts';
import { createWorkerRegistry } from '../../server/workers/registry.ts';
import { createRemoteWorkers, restartedWithout, wentAway } from '../../server/workers/remote.ts';
import {
  ECHO,
  expectInOrder,
  lastMessage,
  QUESTION,
  SERVER,
  sentMessages,
  sentToolNames,
  until,
  useRunHarness,
} from '../agents/run-harness.ts';
import { createClient, createUser } from '../helpers.ts';

const CREATE_WORKER = 'mutation ($name: String!) { createWorker(name: $name) { secret worker { id } } }';
const SET_WORKER = `mutation ($workspaceId: UUID!, $workerId: UUID) {
  setWorkspaceWorker(workspaceId: $workspaceId, workerId: $workerId) { id }
}`;
const WORKERS = '{ workers { id name online localServers } }';
const SET_SECRET = `mutation ($serverId: UUID!, $kind: String!, $name: String!, $value: String) {
  setServerSecret(serverId: $serverId, kind: $kind, name: $name, value: $value) { id }
}`;
/** The machine the fake worker says it runs on. */
const HOST = 'test-box';
/** The fake worker's own server, and the name its tool takes for the model. */
const LOCAL: LocalServer = {
  name: 'box',
  tools: [{ name: 'uname', description: 'Names the machine.', inputSchema: { type: 'object', properties: {} } }],
};
const LOCAL_TOOL = 'box__uname';
/** Short grace periods, so a test sees a run end without its worker. */
const QUICK = { reconnectGraceMs: 100, cancelGraceMs: 100 };

/** What a fake worker does with a stretch it is assigned. */
type OnAssign = (assignment: RunAssignment) => void;

/**
 * A worker program as the protocol describes it, over real HTTP: it holds the channel open, says hello, and runs or
 * holds each stretch it is assigned.
 */
class FakeWorker {
  readonly messages: ChannelMessage[] = [];
  readonly assignments: RunAssignment[] = [];
  /** The local tool calls it answered: server, tool and args. */
  readonly localCalls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  private readonly channel = new AbortController();
  private readonly cancels = new Map<string, AbortController>();
  onAssign: OnAssign = (assignment) => void this.run(assignment);
  readonly base: string;
  readonly secret: string;

  /**
   * Builds the worker.
   *
   * @param base - The router.
   * @param secret - Its worker key.
   */
  constructor(base: string, secret: string) {
    this.base = base;
    this.secret = secret;
  }

  /**
   * Calls one of the worker doors.
   *
   * @param path - The door, under `WORKERS_PATH`.
   * @param [body] - What to post. Left out, the door is read with GET.
   * @returns The answer.
   */
  door(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${WORKERS_PATH}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /**
   * Opens the channel, says hello, and reads the channel until it closes.
   *
   * @param servers - The local servers it offers.
   * @param [runs] - The runs its hello says it holds. Left out, the hello doesn't say, as an older worker's.
   */
  async dialIn(servers: LocalServer[] = [LOCAL], runs?: string[]): Promise<void> {
    const response = await fetch(`${this.base}${WORKERS_PATH}${WorkerDoor.Channel}`, {
      headers: { authorization: `Bearer ${this.secret}` },
      signal: this.channel.signal,
    });
    expect(response.status).toBe(HttpStatus.Ok);
    void this.read(response);
    const hello = await this.door(WorkerDoor.Hello, { host: HOST, version: '0.0.0-test', servers, runs });
    expect(hello.status).toBe(HttpStatus.Ok);
  }

  /** Drops the channel, as a worker that lost its network does. */
  hangUp(): void {
    this.channel.abort();
  }

  /**
   * Reads the channel's server-sent events.
   *
   * @param response - The channel.
   */
  private async read(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (let read = await reader?.read(); read !== undefined && read.done === false; read = await reader?.read()) {
        buffered += decoder.decode(read.value, { stream: true });
        let end = buffered.indexOf('\n\n');
        while (end >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = block
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length);
          if (data !== undefined) {
            this.hear(JSON.parse(data));
          }
          end = buffered.indexOf('\n\n');
        }
      }
    } catch {
      // Hung up.
    }
  }

  /**
   * Acts on one channel message.
   *
   * @param message - The message.
   */
  private hear(message: ChannelMessage): void {
    this.messages.push(message);
    if (message.type === ChannelMessageType.Assign) {
      this.assignments.push(message.assignment);
      this.cancels.set(message.assignment.runId, new AbortController());
      this.onAssign(message.assignment);
    } else if (message.type === ChannelMessageType.Cancel) {
      this.cancels.get(message.runId)?.abort(message.reason);
    }
  }

  /**
   * Posts a stretch's outcome.
   *
   * @param runId - The run.
   * @param outcome - How it ended.
   * @returns The answer.
   */
  finish(runId: string, outcome: RunOutcome): Promise<Response> {
    return this.door(runDoorPath(runId, WorkerDoor.Finish), outcome);
  }

  /**
   * Waits until the router has said something on the channel.
   *
   * @param type - What it says.
   * @returns The first such message.
   */
  async heard(type: ChannelMessage['type']): Promise<ChannelMessage> {
    await until(() => this.messages.some((message) => message.type === type), `a ${type} message`);
    const found = this.messages.find((message) => message.type === type);
    if (found === undefined) {
      throw new Error(`No ${type} message.`);
    }
    return found;
  }

  /**
   * Runs a stretch with agent-core's loop, every port a call to one of the run's doors.
   *
   * @param assignment - The stretch.
   */
  async run(assignment: RunAssignment): Promise<void> {
    const { runId } = assignment;
    const signal = this.cancels.get(runId)?.signal ?? new AbortController().signal;
    let posting = Promise.resolve();
    const ports: RunPorts = {
      modelFetch: async (input, init) => {
        const request = new Request(input, init);
        const path = `${runDoorPath(runId, WorkerDoor.Model)}${request.url.slice(MODELS_BASE_URL.length)}`;
        return this.door(path, request.method === 'GET' ? undefined : await request.json());
      },
      callRouterTool: async (server, tool, args, { call }) => {
        const response = await this.door(runDoorPath(runId, WorkerDoor.Tools), { server, tool, args, call });
        const answer: RouterToolAnswer = await response.json();
        if (answer.ok === false) {
          throw new Error(answer.error);
        }
        return answer.text;
      },
      callLocalTool: async (server, tool, args) => {
        this.localCalls.push({ server, tool, args });
        return `${server} says ${HOST}`;
      },
      publish: (event: RunEventInput): RunEvent => {
        posting = posting.then(async () => {
          await this.door(runDoorPath(runId, WorkerDoor.Events), { events: [event] });
        });
        // The router numbers the event; the worker's loop never reads what this returns.
        return { runId, seq: 0, at: 0, text: '', name: '', ...event } as RunEvent;
      },
      signal,
    };
    const outcome = await executeRun(assignment, ports, createRuntime());
    await posting;
    await this.finish(runId, outcome);
  }
}

describe('the worker doors', () => {
  const h = useRunHarness();

  /**
   * Makes a worker and puts the harness's workspace on it.
   *
   * @param [name] - The worker's name.
   * @returns Its id and key.
   */
  const placeOnWorker = async (name = 'gpu-box'): Promise<{ id: string; secret: string }> => {
    const { createWorker } = await h.asUser.expectOk(CREATE_WORKER, { name });
    await h.asUser.expectOk(SET_WORKER, { workspaceId: h.workspaceId, workerId: createWorker.worker.id });
    return { id: createWorker.worker.id, secret: createWorker.secret };
  };

  /**
   * Starts the router with remote workers of its own.
   *
   * @param [overrides] - Worker settings that differ from `QUICK`.
   * @returns The router's address.
   */
  const startWithWorkers = async (overrides: Partial<WorkerSettings> = {}): Promise<string> => {
    // Short graces, so a run held by a worker that never finishes it ends quickly when the router stops.
    const remote = createRemoteWorkers(
      createWorkerRegistry(h.db),
      { ...QUICK, ...overrides },
      (workerId) => h.snapshot.current().workers.get(workerId)?.name ?? workerId,
    );
    const { base } = await h.startRouter({}, remote);
    return base;
  };

  /**
   * Asks for a completion whose answer the test doesn't read: the router's stopping may cut it.
   *
   * @param base - The router.
   * @param body - The request body.
   */
  const inBackground = (base: string, body: Record<string, unknown>): void => {
    h.complete(base, body).catch(() => {});
  };

  /**
   * Reads a run's events through `/runs`.
   *
   * @param base - The router.
   * @param runId - The run.
   * @returns Its events.
   */
  const eventsOf = async (base: string, runId: string): Promise<RunEvent[]> => {
    const response = await h.get(`${base}/runs/${runId}/events`);
    return (await response.json()).events;
  };

  it('runs a run on its workspace worker, through the doors, with the router numbering its events', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    await fake.dialIn();
    h.script = (body) => {
      const toolTurns = sentMessages(body).filter((message) => message.role === 'tool').length;
      if (toolTurns === 0) {
        return { call: { name: ECHO, args: { text: 'from the router' } } };
      }
      if (toolTurns === 1) {
        return { call: { name: LOCAL_TOOL, args: {} } };
      }
      return { content: `The box said: ${lastMessage(body).content}` };
    };

    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });

    expect(response.status).toBe(HttpStatus.Ok);
    const answer = await response.json();
    expect(answer.choices[0].message.content).toBe(`The box said: box says ${HOST}`);
    expect(sentToolNames(h.received[0])).toEqual(expect.arrayContaining([ECHO, LOCAL_TOOL]));
    expect(fake.localCalls).toEqual([{ server: 'box', tool: 'uname', args: {} }]);
    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ status: RunStatus.Completed, workerId: worker.id });
    const events = await eventsOf(base, row.id);
    expectInOrder(events);
    expect(events[0]).toMatchObject({ kind: RunEventKind.Notice, text: `Running on worker gpu-box (${HOST})` });
    const results = events.filter((event) => event.kind === RunEventKind.ToolResult);
    expect(results.map((event) => event.name)).toEqual([ECHO, LOCAL_TOOL]);
    expect(results.every((event) => event.ok === true)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: RunEventKind.Done, ok: true });
  });

  it('records when the worker said hello, and serves it online with its local servers', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const [router] = h.started;
    const asUser = createClient(h.db, h.user, { snapshot: h.snapshot, tools: h.tools, runs: router?.runs });
    const before = (await asUser.expectOk(WORKERS)).workers.find((found: { id: string }) => found.id === worker.id);
    expect(before).toMatchObject({ online: false, localServers: [] });

    await new FakeWorker(base, worker.secret).dialIn();

    const { workers: listed } = await asUser.expectOk(WORKERS);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'local', online: true, localServers: [] }),
        expect.objectContaining({ id: worker.id, online: true, localServers: [LOCAL.name] }),
      ]),
    );
    const [row] = await h.db.select().from(workers).where(eq(workers.id, worker.id));
    expect(row).toMatchObject({ host: HOST, version: '0.0.0-test' });
    expect(row?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('refuses a run whose worker is offline with 503 worker_offline, recording nothing', async () => {
    await placeOnWorker();
    const base = await startWithWorkers();

    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });

    expect(response.status).toBe(HttpStatus.ServiceUnavailable);
    expect((await response.json()).error.code).toBe('worker_offline');
    const [{ value }] = await h.db.select({ value: count() }).from(runs);
    expect(value).toBe(0);
  });

  it('refuses a run past the worker’s runs at once with 503 worker_busy', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers({ maxRunsAtOnce: 1 });
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn();
    inBackground(base, { model: 'helper', messages: [QUESTION] });
    await fake.heard(ChannelMessageType.Assign);

    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });

    expect(response.status).toBe(HttpStatus.ServiceUnavailable);
    expect((await response.json()).error.code).toBe('worker_busy');
  });

  it("answers a worker's door for another worker's run, or none, with 404", async () => {
    const busy = await placeOnWorker('worker-b');
    const { createWorker: other } = await h.asUser.expectOk(CREATE_WORKER, { name: 'worker-a' });
    const base = await startWithWorkers();
    const b = new FakeWorker(base, busy.secret);
    b.onAssign = () => {};
    await b.dialIn();
    inBackground(base, { model: 'helper', messages: [QUESTION] });
    await b.heard(ChannelMessageType.Assign);
    const [assignment] = b.assignments;
    const a = new FakeWorker(base, other.secret);

    const wrongWorker = await a.door(runDoorPath(assignment.runId, WorkerDoor.Events), { events: [] });
    const noRun = await b.door(runDoorPath(crypto.randomUUID(), WorkerDoor.Events), { events: [] });
    const ownRun = await b.door(runDoorPath(assignment.runId, WorkerDoor.Events), { events: [] });

    expect(wrongWorker.status).toBe(HttpStatus.NotFound);
    expect(await wrongWorker.json()).toMatchObject({ code: RUN_NOT_FOUND });
    expect(noRun.status).toBe(HttpStatus.NotFound);
    expect(ownRun.status).toBe(HttpStatus.Ok);
  });

  it('refuses a workspace key on the worker doors with 401', async () => {
    const base = await startWithWorkers();

    const response = await h.get(`${base}${WORKERS_PATH}${WorkerDoor.Channel}`);

    expect(response.status).toBe(HttpStatus.Unauthorized);
    expect(await response.json()).toMatchObject({ code: ErrorCode.Unauthenticated });
  });

  it('sends a cancel down the channel, and ends the run with what the worker finishes', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers({ cancelGraceMs: 5_000 });
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn();
    const answer = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await fake.heard(ChannelMessageType.Assign);
    const [assignment] = fake.assignments;

    // Answered once the run has ended, so not awaited until the worker has finished it.
    const cancelling = fetch(`${base}/runs/${assignment.runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'enough' }),
    });
    expect(await fake.heard(ChannelMessageType.Cancel)).toEqual({
      type: ChannelMessageType.Cancel,
      runId: assignment.runId,
      reason: 'enough',
    });
    const finished = await fake.finish(assignment.runId, { ok: false, error: 'stopped', usage: undefined });

    expect(finished.status).toBe(HttpStatus.Ok);
    expect((await cancelling).status).toBe(HttpStatus.Ok);
    expect((await answer).status).toBe(HttpStatus.Conflict);
    const row = await h.runReaches(assignment.runId, RunStatus.Cancelled);
    expect(row.error).toBe('enough');
  });

  it('fails the runs of a worker whose channel drops and stays away past the grace', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn();
    const answer = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await fake.heard(ChannelMessageType.Assign);
    const [assignment] = fake.assignments;

    fake.hangUp();

    expect((await answer).status).toBe(HttpStatus.InternalServerError);
    const row = await h.runReaches(assignment.runId, RunStatus.Failed);
    expect(row.error).toBe(wentAway('gpu-box'));
  });

  it('fails at once the runs a worker that dials in again no longer holds', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers({ reconnectGraceMs: 60_000 });
    const before = new FakeWorker(base, worker.secret);
    before.onAssign = () => {};
    await before.dialIn();
    const answer = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await before.heard(ChannelMessageType.Assign);
    const [assignment] = before.assignments;

    before.hangUp();
    // A worker that restarted: a new process, holding nothing, well inside the grace.
    await new FakeWorker(base, worker.secret).dialIn([LOCAL], []);

    expect((await answer).status).toBe(HttpStatus.InternalServerError);
    const row = await h.runReaches(assignment.runId, RunStatus.Failed);
    expect(row.error).toBe(restartedWithout('gpu-box'));
    const record = await fetch(`${base}/runs/${assignment.runId}`, {
      headers: { authorization: `Bearer ${h.keySecret}` },
    });
    expect(await record.json()).toMatchObject({ worker: 'gpu-box', error: restartedWithout('gpu-box') });
  });

  it('keeps the runs a worker that dials in again says it holds, and those an older worker says nothing of', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers({ reconnectGraceMs: 60_000 });
    const first = new FakeWorker(base, worker.secret);
    first.onAssign = () => {};
    await first.dialIn();
    const answer = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await first.heard(ChannelMessageType.Assign);
    const [assignment] = first.assignments;

    first.hangUp();
    const holding = new FakeWorker(base, worker.secret);
    await holding.dialIn([LOCAL], [assignment.runId]);
    holding.hangUp();
    const older = new FakeWorker(base, worker.secret);
    await older.dialIn();
    const finished = await older.finish(assignment.runId, {
      ok: false,
      error: 'finished by the worker',
      usage: undefined,
    });

    // Ended by the worker's own finish, so the router kept the run until then.
    expect(finished.status).toBe(HttpStatus.Ok);
    expect((await answer).status).toBe(HttpStatus.InternalServerError);
    const row = await h.runReaches(assignment.runId, RunStatus.Failed);
    expect(row.error).toBe('finished by the worker');
  });

  it('keeps a run sent on the channel the hello comes on, which the worker may not have read yet', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn([LOCAL], []);
    const answer = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await fake.heard(ChannelMessageType.Assign);
    const [assignment] = fake.assignments;

    // Its tools changed, and it says hello again before it has taken the run.
    expect(
      (await fake.door(WorkerDoor.Hello, { host: HOST, version: '0.0.0-test', servers: [], runs: [] })).status,
    ).toBe(HttpStatus.Ok);
    const finished = await fake.finish(assignment.runId, {
      ok: false,
      error: 'finished by the worker',
      usage: undefined,
    });

    // Ended by the worker's own finish, so the router kept the run until then.
    expect(finished.status).toBe(HttpStatus.Ok);
    expect((await answer).status).toBe(HttpStatus.InternalServerError);
    const row = await h.runReaches(assignment.runId, RunStatus.Failed);
    expect(row.error).toBe('finished by the worker');
  });

  it('never forwards the worker key to the models', async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    await new FakeWorker(base, worker.secret).dialIn();
    h.script = () => ({ content: 'hi' });

    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });

    expect(response.status).toBe(HttpStatus.Ok);
    expect(h.receivedHeaders.length).toBeGreaterThan(0);
    for (const [index, headers] of h.receivedHeaders.entries()) {
      expect(JSON.stringify(headers)).not.toContain(worker.secret);
      expect(JSON.stringify(h.received[index])).not.toContain(worker.secret);
    }
  });

  it('sends a worker no provider key or server secret in an assignment', async () => {
    const worker = await placeOnWorker();
    const admin = await createUser(h.db, 'admin@example.com', Role.Admin);
    const asAdmin = createClient(h.db, admin, { snapshot: h.snapshot, tools: h.tools, models: h.models });
    const providerKey = 'sk-planted-provider-key';
    const serverSecret = 'planted-server-secret';
    await h.db.update(providers).set({ apiKey: providerKey });
    const server = h.snapshot.current().servers.get(SERVER);
    await asAdmin.expectOk(SET_SECRET, { serverId: server?.id, kind: 'env', name: 'TOKEN', value: serverSecret });
    await h.snapshot.rebuild();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn();

    inBackground(base, { model: 'helper', messages: [QUESTION] });
    const assign = await fake.heard(ChannelMessageType.Assign);

    const said = JSON.stringify(assign);
    expect(said).not.toContain(providerKey);
    expect(said).not.toContain(serverSecret);
  });

  it("leaves out a worker's server whose name the router's server has, or that breaks the name rule", async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    const clash: LocalServer = { name: SERVER, tools: LOCAL.tools };
    const badName: LocalServer = { name: 'Bad Name', tools: LOCAL.tools };
    await fake.dialIn([LOCAL, clash, badName]);

    inBackground(base, { model: 'helper', messages: [QUESTION] });
    await fake.heard(ChannelMessageType.Assign);

    const [assignment] = fake.assignments;
    expect(Object.values(assignment.targets).filter((target) => target.origin === 'local')).toEqual([
      { origin: 'local', server: 'box', tool: 'uname' },
    ]);
    const notices = (await eventsOf(base, assignment.runId)).map((event) => event.text);
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`"${SERVER}" is left out`),
        expect.stringContaining('"Bad Name" is left out'),
      ]),
    );
  });

  it("narrows a worker's servers by agent_core.servers too", async () => {
    const worker = await placeOnWorker();
    const base = await startWithWorkers();
    const fake = new FakeWorker(base, worker.secret);
    fake.onAssign = () => {};
    await fake.dialIn();

    inBackground(base, { model: 'helper', messages: [QUESTION], agent_core: { servers: [SERVER] } });
    await fake.heard(ChannelMessageType.Assign);

    const [assignment] = fake.assignments;
    expect(Object.keys(assignment.targets)).toContain(ECHO);
    expect(Object.keys(assignment.targets)).not.toContain(LOCAL_TOOL);
  });
});
