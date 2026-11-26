import { buildWorkerPackage, repoVersion, WORKER_PACKAGE_DIR } from './worker-package.ts';

// `npm run build:worker`: the worker package in dist-worker/, at the repo's version or WORKER_VERSION.
const version = process.env.WORKER_VERSION || (await repoVersion());
const bundle = await buildWorkerPackage({ outDir: WORKER_PACKAGE_DIR, version });
console.log(`[worker] built ${bundle} at ${version}`);
