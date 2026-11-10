// story 4843 AC3 - READ-ONLY. Run INSIDE the frontend container, after `kill -USR1 1` has opened Node's inspector (127.0.0.1:9229, container-local):
//   sudo docker exec sprintable-frontend-1 kill -USR1 1
//   sudo docker exec -i sprintable-frontend-1 node - < inflight_paths.js
// It asks the running next-server for the HTTP requests it is holding open right now and prints how many there are per method + path
// (query dropped; a path segment that is not a plain lowercase word - digits, capitals, dots, long or mixed text - is replaced by :x. A plain lowercase word IS printed as it is: these are the web server's route names, so read the output as route shapes, and do not run this where a path carries a secret written as a lowercase word), whether a response head has been sent, and the user-agent FAMILY (electron/chrome/safari/python/node/curl/other/none - never the raw header).
// It also prints how many DISTINCT client addresses (X-Forwarded-For first hop - a count only, no address) hold requests and how many carry Last-Event-ID (= the client is re-opening a stream).
// It changes nothing in the process.
const http = require('http');
const EXPR = `(() => {
  const fam = (ua) => {
    if (!ua) return 'none';
    if (/Electron\\//i.test(ua)) return 'electron';
    if (/Edg\\//.test(ua)) return 'edge';
    if (/Firefox\\//.test(ua)) return 'firefox';
    if (/Chrome\\//.test(ua)) return 'chrome';
    if (/Safari\\//.test(ua)) return 'safari';
    if (/python|aiohttp|httpx|requests/i.test(ua)) return 'python';
    if (/undici|node|bun|deno/i.test(ua)) return 'node/bun';
    if (/curl|wget/i.test(ua)) return 'curl';
    return 'other';
  };
  const out = {}; let total = 0; const addrs = new Set(); let withLast = 0;
  const hs = process._getActiveHandles();
  for (const h of hs) {
    const r = h && h._httpMessage; const q = r && r.req;
    if (!q || !q.url) continue;
    total++;
    const hd = q.headers || {};
    const xff = String(hd['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) addrs.add(xff);
    const last = hd['last-event-id'] ? 1 : 0; withLast += last;
    // a path segment is printed only if it is a plain lowercase word (agent, stream, v2 ...); anything else - ids, tokens, names with digits or punctuation - becomes :x. The query is dropped.
    const p = q.url.split('?')[0].split('/').map((seg) => (seg === '' || /^[a-z][a-z-]{0,23}$/.test(seg) || /^v[0-9]{1,2}$/.test(seg) ? seg : ':x')).join('/');
    const k = q.method + ' ' + p + ' | head ' + (r.headersSent ? 'sent' : 'not sent') + ' | ' + (h.destroyed ? 'destroyed' : 'live') + ' | ua ' + fam(hd['user-agent']);
    out[k] = out[k] || { n: 0, lastEventId: 0 };
    out[k].n++; out[k].lastEventId += last;
  }
  return JSON.stringify({ handles: hs.length, holdingRequest: total, distinctClientAddrs: addrs.size, withLastEventId: withLast, top: Object.entries(out).sort((a, b) => b[1].n - a[1].n).slice(0, 30).map(([k, v]) => v.n + '  (last-event-id ' + v.lastEventId + ')  ' + k) }, null, 1);
})()`;
const PORT = process.env.INSPECT_PORT || '9229'; // 9229 = where `kill -USR1` opens Node's inspector; the variable is for the test, which uses a free port
http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    const t = JSON.parse(body)[0];
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) { console.log(d.result && d.result.result ? d.result.result.value : JSON.stringify(d)); ws.close(); process.exit(0); }
    };
    ws.onerror = (e) => { console.log('ws error', e.message || e); process.exit(1); };
  });
}).on('error', (e) => { console.log(`no inspector on ${PORT} - did \`kill -USR1 1\` run?`, e.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
