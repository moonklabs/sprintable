'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS on purpose: copied next to Next's standalone server.js and run by the app without a build step */
// story 4824 (security lens AC7) — the desktop app's own web server answers ONLY requests whose `Host` is the loopback address WITH ITS OWN PORT, decided at the HTTP
// SERVER'S DOOR, before Next routes anything. A page that rebinds its own DNS name to 127.0.0.1 reaches this port with `Host: its-name`; whatever it asks for — a page, a
// route handler that calls the backend, a path a build-time rewrite would hand to the backend, in any spelling (other letter case, encoded separators, dot segments,
// a static-asset extension …) — is refused here. The browser sets `Host` and a page cannot change it. There is no path to disagree about, which is the point: a check
// inside Next's proxy decides on a decoded, case-sensitive form of the path and skips static-asset extensions, so every spelling the proxy and the router read differently
// slips past it.
//
// The same door also keeps out requests that ANOTHER SITE makes through the person's browser (a page may send a request to http://127.0.0.1:<port>/ with the right Host: the browser
// sets `Sec-Fetch-Site` itself and a page cannot forge or remove it) and bounds the memory that request bodies in flight can take, BEFORE Next reads or buffers a byte:
//   - `Sec-Fetch-Site` other than same-origin / none → 403. A browser without that header is judged by `Origin` (anything but this server's own origin, also `null` → 403).
//     A request with neither header (curl, an agent, the app's own main process) passes: it is not a browser acting for some page.
//   - the total of the bodies being received at the same moment has a budget: a declared `Content-Length` is reserved when the headers arrive, a chunked body is counted by the bytes that
//     really arrive; past the budget the request is refused with 503 (a chunked one: also cut off). The reservation is given back when the response is over or the connection closed.
//   - `Expect: 100-continue` is answered by this door too (listeners for checkContinue / checkExpectation are registered here), so a refused request never gets «100 Continue».
//
// It wraps `emit` of http.Server for the request-bearing events — requests, `Expect: 100-continue`, upgrades (websockets), CONNECT — before the app's server is created.
// Plain CommonJS and no dependencies: it is copied next to Next's standalone `server.js` by the app build and started by `embedded-entry.cjs`.
const http = require('node:http');

const GUARDED_EVENTS = new Set(['request', 'checkContinue', 'checkExpectation', 'upgrade', 'connect']);
const BODY_EVENTS = new Set(['request', 'checkContinue']); // the events whose request may carry a body
const INSTALLED = Symbol.for('sprintable.embeddedHostGuard');
const ADMITTED = Symbol('sprintable.embeddedAdmitted');
const BODY = 'Invalid host header';
/** the total of request bodies that may be in flight at once (the attachment limit is 100 MB; three of them at the same time) */
const DEFAULT_BODY_BUDGET = 300 * 1024 * 1024;
const REASONS = { 400: 'Bad Request', 403: 'Forbidden', 503: 'Service Unavailable' };

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

/**
 * Does the browser say this request is made on behalf of another site? `Sec-Fetch-Site` is set by the browser and cannot be changed by a page; a browser that does not send it sends `Origin`
 * on anything but a plain GET. Neither header: not a browser acting for a page (a tool, an agent, the app's own process) — passed.
 */
function crossSiteRequest(req, port) {
  const h = req && req.headers ? req.headers : {};
  const site = h['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = h['origin'];
  if (typeof origin === 'string') return !(typeof port === 'number' && origin === `http://127.0.0.1:${port}`);
  return false;
}

function refuse(event, args, status, text) {
  if (event === 'upgrade' || event === 'connect') {
    const socket = args[1];
    if (socket && typeof socket.end === 'function') socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
    return;
  }
  const res = args[1];
  if (res && typeof res.end === 'function') {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Connection', 'close');
    if (status === 503) res.setHeader('Retry-After', '1');
    res.end(text);
  }
}

/** Installs the guard on `target` (default: every http.Server) when the env says this is the app's own server. Returns whether it is installed now. `options.bodyBudget`: bytes (tests). */
function install(env = process.env, target = http.Server.prototype, options = {}) {
  if (env['SPRINTABLE_EMBEDDED'] !== '1') return false;
  if (target[INSTALLED]) return true;
  const budget = Number.isFinite(options.bodyBudget) && options.bodyBudget > 0 ? options.bodyBudget : DEFAULT_BODY_BUDGET;
  const envPort = env['PORT'] ? Number(env['PORT']) : undefined;
  const original = target.emit;
  let inflight = 0; // bytes of request bodies being received / held right now

  /** true = over budget (refuse). Otherwise the body's bytes are reserved until the response is over. */
  function takeBody(req, res) {
    const headers = req.headers;
    let held = 0;
    let done = false; // the response is over (or the connection closed): the bytes still arriving are nobody's to reserve any more
    const release = () => { done = true; inflight -= held; held = 0; };
    const chunked = headers['transfer-encoding'] !== undefined;
    const declared = headers['content-length'] !== undefined ? Number(headers['content-length']) : 0;
    if (!chunked) {
      if (!Number.isFinite(declared) || declared < 0) return false; // the HTTP parser has refused such a request already
      if (declared === 0) return false;
      if (inflight + declared > budget) return true;
      held = declared; inflight += declared;
      res.once('close', release);
      return false;
    }
    // a chunked body declares no length: its bytes are counted as the parser hands them over (the real size, not a claim)
    let cut = false;
    const push = req.push;
    req.push = function countedPush(chunk, encoding) {
      if (cut) return true;
      if (!done && chunk && chunk.length) {
        if (inflight + chunk.length > budget) {
          cut = true;
          if (!res.headersSent) { res.statusCode = 503; res.setHeader('Connection', 'close'); res.setHeader('Retry-After', '1'); res.end('Busy'); }
          if (req.socket && typeof req.socket.destroySoon === 'function') req.socket.destroySoon();
          return true;
        }
        held += chunk.length; inflight += chunk.length;
      }
      return push.call(this, chunk, encoding);
    };
    res.once('close', release);
    return false;
  }

  /** null = let it in; otherwise { status, text } for the refusal */
  function admit(server, event, req, args) {
    const host = req && req.headers ? req.headers.host : undefined;
    // the port this server is REALLY bound to, asked at request time (PORT=0 or a port that was taken makes Next bind another one; the env value would then name a port nobody listens on);
    // the env value is only the fallback for a server that cannot say (none in practice)
    const bound = typeof server.address === 'function' ? server.address() : null;
    const port = bound && typeof bound === 'object' && typeof bound.port === 'number' ? bound.port : envPort;
    if (!isAllowedHost(host, port) || !targetAuthorityAllowed(req && req.url, port)) return { status: 400, text: BODY };
    if (crossSiteRequest(req, port)) return { status: 403, text: 'Forbidden' };
    if (BODY_EVENTS.has(event) && takeBody(req, args[1])) return { status: 503, text: 'Busy' };
    return null;
  }

  // Node writes «100 Continue» itself, BEFORE the 'request' event, when nobody listens for checkContinue — so a door that only sees 'request' is too late for a refused request.
  // With these listeners registered, the event reaches the door first; they do what Node would have done.
  const known = new WeakSet();
  function onCheckContinue(req, res) { res.writeContinue(); this.emit('request', req, res); }
  function onCheckExpectation(req, res) { res.writeHead(417); res.end(); }

  target.emit = function guardedEmit(event, ...args) {
    if (!known.has(this) && typeof this.on === 'function') {
      known.add(this);
      this.on('checkContinue', onCheckContinue);
      this.on('checkExpectation', onCheckExpectation);
    }
    if (typeof event === 'string' && GUARDED_EVENTS.has(event) && args[0] && !args[0][ADMITTED]) {
      const verdict = admit(this, event, args[0], args);
      if (verdict) {
        refuse(event, args, verdict.status, verdict.text);
        return true;
      }
      args[0][ADMITTED] = true; // 'checkContinue' → 'request' of the same message is judged once
    }
    return original.call(this, event, ...args);
  };
  target[INSTALLED] = true;
  return true;
}

module.exports = { install, isAllowedHost, targetAuthorityAllowed, crossSiteRequest };
