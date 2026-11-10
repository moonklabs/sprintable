'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS on purpose: copied next to Next's standalone server.js and run by the app without a build step */
// story 4824 — what the desktop app starts instead of Next's `server.js`: the Host guard first (so it is on the http server before Next creates it), then the real server.
// story 4844 — the `/api/v2/*` relay (embedded-api-relay.cjs) is installed FIRST on purpose: the Host guard installed next wraps it, so every request is judged by the guard before the relay sees it. An older app
// build that does not carry the relay file starts as before (only «that file is not there» is let through; any other failure is a real one).
try {
  require('./embedded-api-relay.cjs').install();
} catch (e) {
  // the FIRST line of the message names the module that was not found (the lines after it are the require stack, which names the relay file even when the relay itself failed to load something else)
  if (!e || e.code !== 'MODULE_NOT_FOUND' || !/^Cannot find module '\.\/embedded-api-relay\.cjs'/.test(String(e.message).split('\n')[0])) throw e;
}
require('./embedded-host-guard.cjs').install();
require('./server.js');
