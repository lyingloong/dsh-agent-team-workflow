/**
 * Run every v2 test file in one process.
 *
 * The suites isolate themselves with temporary data directories, so sharing a
 * process is safe. The standard runner also works: `node --test tests/`.
 */

import './v2-runtime.test.mjs';
import './v2-plugin.test.mjs';
import './v2-web-api.test.mjs';
import './client-bundle.test.mjs';
import './examples.test.mjs';

import './v2-executors-lifecycle.test.mjs';
import './v2-runtime-safety.test.mjs';
import './v2-runner.test.mjs';
import './v2-api-lifecycle.test.mjs';
import './v2-board-status.test.mjs';
import './v2-model-fallback.test.mjs';
