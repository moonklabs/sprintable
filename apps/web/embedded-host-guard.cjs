'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS on purpose: copied next to Next's standalone server.js and run by the app without a build step */
// story 4824 (security lens AC7) — the desktop app's own web server answers ONLY requests whose `Host` is the loopback address WITH ITS OWN PORT, decided at the HTTP
// SERVER'S DOOR, before Next routes anything. A page that rebinds its own DNS name to 127.0.0.1 reaches this port with `Host: its-name`; whatever it asks for — a page, a
// route handler that calls the backend, a path a build-time rewrite would hand to the backend, in any spelling (other letter case, encoded separators, dot segments,
// a static-asset extension …) — is refused here. The browser sets `Host` and a page cannot change it. There is no path to disagree about, which is the point: a check
// inside Next's proxy decides on a decoded, case-sensitive form of the path and skips static-asset extensions, so every spelling the proxy and the router read differently
// slips past it.
//
// It wraps `emit` of http.Server for the request-bearing events — requests, `Expect: 100-continue`, upgrades (websockets), CONNECT — before the app's server is created.
// Plain CommonJS and no dependencies: it is copied next to Next's standalone `server.js` by the app build and started by `embedded-entry.cjs`.
const http = require('node:http');

const GUARDED_EVENTS = new Set(['request', 'checkContinue', 'checkExpectation', 'upgrade', 'connect']);
const INSTALLED = Symbol.for('sprintable.embeddedHostGuard');
const BODY = 'Invalid host header';

/** `127.0.0.1:<port>` — exactly this server's port, and no other spelling of the loopback (localhost · [::1] · 127.1 · 0x7f… · a trailing dot · userinfo). With no port to compare with (nothing known) nothing is allowed. */
function isAllowedHost(host, port) {
  if (typeof host !== 'string') return false;
  const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(host);
  if (!m) return false;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && Number(m[1]) === port; // closed when the port is not known
}

/** an absolute-form request target (`GET http://evil/ HTTP/1.1`) names its own authority, which takes precedence over `Host` — it must be the loopback too */
function targetAuthorityAllowed(url, port) {
  if (typeof url !== 'string') return true;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (!m) return true; // origin-form (`/path`) or asterisk-form: no authority of its own
  return isAllowedHost(m[1], port);
}

function refuse(event, args) {
  if (event === 'upgrade' || event === 'connect') {
    const socket = args[1];
    if (socket && typeof socket.end === 'function') socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`);
    return;
  }
  const res = args[1];
  if (res && typeof res.end === 'function') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Connection', 'close');
    res.end(BODY);
  }
}

/** Installs the guard on `target` (default: every http.Server) when the env says this is the app's own server. Returns whether it is installed now. */
function install(env = process.env, target = http.Server.prototype) {
  if (env['SPRINTABLE_EMBEDDED'] !== '1') return false;
  if (target[INSTALLED]) return true;
  const envPort = env['PORT'] ? Number(env['PORT']) : undefined;
  const original = target.emit;
  target.emit = function guardedEmit(event, ...args) {
    if (typeof event === 'string' && GUARDED_EVENTS.has(event)) {
      const req = args[0];
      const host = req && req.headers ? req.headers.host : undefined;
      // the port this server is REALLY bound to, asked at request time (PORT=0 or a port that was taken makes Next bind another one; the env value would then name a port nobody listens on);
      // the env value is only the fallback for a server that cannot say (none in practice)
      const bound = typeof this.address === 'function' ? this.address() : null;
      const port = bound && typeof bound === 'object' && typeof bound.port === 'number' ? bound.port : envPort;
      if (!isAllowedHost(host, port) || !targetAuthorityAllowed(req && req.url, port)) {
        refuse(event, args);
        return true;
      }
    }
    return original.call(this, event, ...args);
  };
  target[INSTALLED] = true;
  return true;
}

module.exports = { install, isAllowedHost, targetAuthorityAllowed };
