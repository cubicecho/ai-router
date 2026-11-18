import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';
import { RequestError } from './gql.ts';
import { sessionToken } from './session.ts';
import { readFrames } from './sse.ts';

/** Where subscriptions go: the same endpoint as every other operation. */
const ENDPOINT = '/graphql';

/** What Yoga names a frame that carries a result. */
const NEXT_EVENT = 'next';
/** What Yoga names the frame that ends the subscription. */
const COMPLETE_EVENT = 'complete';
/** A frame with no `event` field, which older servers send results as. */
const MESSAGE_EVENT = 'message';

/** One result frame, as far as the client reads it. */
interface ResultBody<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string; [key: string]: unknown } }[];
}

/** Who hears a subscription. */
export interface SubscriptionHandlers<TResult> {
  /** Hears each result, in order. */
  onNext: (data: TResult) => void;
  /** Hears why it stopped early. Nothing is heard after it. */
  onError: (error: unknown) => void;
  /** Hears that the server ended it. Nothing is heard after it. */
  onComplete: () => void;
}

/**
 * Reads a result frame, throwing the first error it carries.
 *
 * @typeParam TResult - What the subscription yields.
 * @param data - The frame's data.
 * @returns The result's `data`.
 * @throws {@link RequestError} With the first error's message and code.
 */
function resultOf<TResult>(data: string): TResult {
  const body: ResultBody<TResult> = JSON.parse(data);
  const [first] = body.errors ?? [];
  if (first !== undefined) {
    throw new RequestError(first.message, first.extensions?.code ?? '', first.extensions ?? {});
  }
  if (body.data === undefined || body.data === null) {
    throw new RequestError('The server sent a result with no data.', '');
  }
  return body.data;
}

/**
 * Follows one subscription over server-sent events, as graphql-yoga serves them on `/graphql`, with the session as a
 * bearer token.
 *
 * @typeParam TResult - What each result holds.
 * @typeParam TVariables - What the subscription takes.
 * @param document - The subscription, from codegen.
 * @param variables - Its variables.
 * @param handlers - Who hears its results and its end.
 * @returns A function that stops following. Neither `onError` nor `onComplete` is called after it.
 */
export function subscribe<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  variables: TVariables,
  handlers: SubscriptionHandlers<TResult>,
): () => void {
  const controller = new AbortController();
  const follow = async (): Promise<void> => {
    const token = sessionToken();
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ query: print(document), variables }),
      signal: controller.signal,
    });
    const isStream = response.headers.get('content-type')?.startsWith('text/event-stream') ?? false;
    if (isStream === false || response.body === null) {
      // A refusal before the stream starts, such as a bad document, is a plain GraphQL answer.
      resultOf<TResult>(await response.text());
      throw new RequestError(`The server did not open a stream (HTTP ${response.status}).`, '');
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      const read = readFrames(buffer + value);
      buffer = read.rest;
      for (const frame of read.frames) {
        if (frame.event === COMPLETE_EVENT) {
          await reader.cancel();
          return;
        }
        if (frame.event === NEXT_EVENT || frame.event === MESSAGE_EVENT) {
          handlers.onNext(resultOf<TResult>(frame.data));
        }
      }
    }
  };
  follow()
    .then(
      () => {
        if (controller.signal.aborted === false) {
          handlers.onComplete();
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted === false) {
          handlers.onError(error);
        }
      },
    )
    // Closes the connection whichever way it ended, an error frame included.
    .finally(() => controller.abort());
  return () => controller.abort();
}
