import { randomUUID } from 'node:crypto';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DECLINED } from './elicit.ts';

/** Puts a question to the client on an open request's stream. */
export type SendQuestion = (id: string, params: ElicitRequest['params']) => void;

/** A question waiting for a client's answer. */
interface Question {
  runId: string;
  workspaceId: string;
  params: ElicitRequest['params'];
  finish: (answer: ElicitResult) => void;
}

/**
 * The questions `/mcp`'s runs are waiting on. `/mcp` is stateless, so a client's answer arrives as a POST of its own,
 * and is matched here by the question's id, within the workspace it was asked for.
 */
export class McpQuestions {
  private readonly questions = new Map<string, Question>();
  private readonly followers = new Map<string, SendQuestion>();

  /**
   * Puts a question to whoever follows the run, now or once one does.
   *
   * @param runId - The run asking.
   * @param workspaceId - Its workspace: only a key of that workspace may answer.
   * @param params - The question.
   * @param signal - Aborted when the answer is no longer wanted.
   * @returns The answer, or a decline once the signal aborts.
   */
  ask(runId: string, workspaceId: string, params: ElicitRequest['params'], signal: AbortSignal): Promise<ElicitResult> {
    if (signal.aborted) {
      return Promise.resolve(DECLINED);
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => finish(DECLINED);
      const finish = (answer: ElicitResult) => {
        this.questions.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.questions.set(id, { runId, workspaceId, params, finish });
      this.followers.get(runId)?.(id, params);
    });
  }

  /**
   * Makes an open request the one a run's questions go out on, and sends those already waiting.
   *
   * @param runId - The run.
   * @param send - Puts a question on the request's stream.
   * @param signal - Aborted when the request ends.
   */
  follow(runId: string, send: SendQuestion, signal: AbortSignal): void {
    if (signal.aborted) {
      return;
    }
    this.followers.set(runId, send);
    signal.addEventListener(
      'abort',
      () => {
        if (this.followers.get(runId) === send) {
          this.followers.delete(runId);
        }
      },
      { once: true },
    );
    for (const [id, question] of this.questions) {
      if (question.runId === runId) {
        send(id, question.params);
      }
    }
  }

  /**
   * Whether a run is waiting for an answer.
   *
   * @param runId - The run.
   * @returns true while one of its questions is open.
   */
  isAsking(runId: string): boolean {
    return [...this.questions.values()].some((question) => question.runId === runId);
  }

  /**
   * Takes a client's JSON-RPC response, if it answers an open question.
   *
   * @param workspaceId - The workspace of the key it came with.
   * @param message - The request's body.
   * @returns true when it was the answer to a question of that workspace. An error or a malformed result declines.
   */
  answer(workspaceId: string, message: { id?: unknown; result?: unknown }): boolean {
    const question = typeof message.id === 'string' ? this.questions.get(message.id) : undefined;
    if (question === undefined || question.workspaceId !== workspaceId) {
      return false;
    }
    const parsed = ElicitResultSchema.safeParse(message.result);
    question.finish(parsed.success ? parsed.data : DECLINED);
    return true;
  }
}
