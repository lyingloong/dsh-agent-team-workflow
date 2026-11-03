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
