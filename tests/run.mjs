/**
 * Run every test file in one process.
 *
 * `node --test tests/` gives each file its own child process, which is the
 * preferred runner on a normal machine. Some restricted environments deny that
 * spawn; this entry keeps `node tests/run.mjs` usable there. The suites isolate
 * themselves with temporary data directories, so sharing a process is safe.
 *
 * Use the standard runner with: node --test tests/
 */

import './v2-runtime.test.mjs';
import './v2-plugin.test.mjs';
import './definition.test.mjs';
import './store.test.mjs';
import './lock.test.mjs';
import './scheduler.test.mjs';
import './engine.test.mjs';
import './status.test.mjs';
import './board.test.mjs';
import './web-api.test.mjs';
import './client-bundle.test.mjs';
import './plugin.test.mjs';
import './cli.test.mjs';
