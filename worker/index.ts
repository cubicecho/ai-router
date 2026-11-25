import { errorMessage } from '../server/core/errors.ts';
import { readWorkerConfig } from './config.ts';
import { startWorker } from './worker.ts';

/** Exits with this when the worker can't start, or is stopped twice. */
const EXIT_FAILED = 1;

let config: ReturnType<typeof readWorkerConfig>;
try {
  config = readWorkerConfig(process.env);
} catch (error) {
  console.error(`[worker] ${errorMessage(error)}`);
  process.exit(EXIT_FAILED);
}

const worker = await startWorker(config);
console.log(
  `[worker] working in ${config.root}; servers: ${worker.local
    .listing()
    .map(({ name }) => name)
    .join(', ')}`,
);

let isStopping = false;
/**
 * Stops the worker: its runs are finished as failed, its servers closed. A second signal exits at once.
 *
 * @param signal - What arrived.
 */
const stop = async (signal: NodeJS.Signals): Promise<void> => {
  if (isStopping) {
    process.exit(EXIT_FAILED);
  }
  isStopping = true;
  console.log(`[worker] ${signal}: stopping`);
  try {
    await worker.stop();
  } catch (error) {
    console.error(`[worker] stopping failed: ${errorMessage(error)}`);
    process.exit(EXIT_FAILED);
  }
  console.log('[worker] stopped');
  process.exit(0);
};
process.on('SIGTERM', (signal) => void stop(signal));
process.on('SIGINT', (signal) => void stop(signal));
