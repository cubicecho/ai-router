import { useCallback, useEffect, useRef, useState } from 'react';
import { RunEventsDocument, type RunEventsSubscription } from '@/__generated__/graphql';
import { subscribe } from '@/lib/subscribe';

/** One live event, as the subscription sends it. */
export type LiveRunEvent = RunEventsSubscription['runEvents'];

/** Where following a run stands. */
export const FollowState = {
  /** Connected, and the run may still say more. */
  Following: 'following',
  /** The server ended the stream: the run is done, or it ended before the page opened. */
  Ended: 'ended',
  /** The stream broke or was refused. */
  Failed: 'failed',
} as const;
export type FollowState = (typeof FollowState)[keyof typeof FollowState];

/** What following a run gives the page. */
export interface RunEvents {
  /** Every event received, in the order they arrived. */
  events: readonly LiveRunEvent[];
  state: FollowState;
  /** Why it failed, while `state` is failed. */
  error: unknown;
  /** Follows it again after a failure. */
  retry: () => void;
}

/**
 * Follows a run's live events through the `runEvents` subscription. A run that ended a while ago gives none, since
 * events are not stored yet.
 *
 * @param runId - The run.
 * @param onEnd - Hears that the stream ended, so the page can read the run's final row.
 * @returns The events and where following stands.
 *
 * @remarks
 * Events arrive once per streamed token, so they are gathered and handed to React once a frame rather than one
 * render each.
 */
export function useRunEvents(runId: string, onEnd: () => void): RunEvents {
  const [events, setEvents] = useState<readonly LiveRunEvent[]>([]);
  const [state, setState] = useState<FollowState>(FollowState.Following);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    // `attempt` is read so a retry follows again.
    void attempt;
    let pending: LiveRunEvent[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const arrived = pending;
      pending = [];
      setEvents((held) => [...held, ...arrived]);
    };
    setEvents([]);
    setState(FollowState.Following);
    setError(null);
    const stop = subscribe(
      RunEventsDocument,
      { runId },
      {
        onNext: (data) => {
          pending.push(data.runEvents);
          frame ??= requestAnimationFrame(flush);
        },
        onError: (failure) => {
          if (frame !== null) {
            cancelAnimationFrame(frame);
          }
          flush();
          setError(failure);
          setState(FollowState.Failed);
        },
        onComplete: () => {
          if (frame !== null) {
            cancelAnimationFrame(frame);
          }
          flush();
          setState(FollowState.Ended);
          onEndRef.current();
        },
      },
    );
    return () => {
      stop();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [runId, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { events, state, error, retry };
}
