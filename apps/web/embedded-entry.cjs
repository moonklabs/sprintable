'use strict';
// story 4824 — what the desktop app starts instead of Next's `server.js`: the Host guard first (so it is on the http server before Next creates it), then the real server.
require('./embedded-host-guard.cjs').install();
require('./server.js');
