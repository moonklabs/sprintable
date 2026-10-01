#!/usr/bin/env python3
"""story #4445 — the web must read the answer shape the backend (through the BFF) really sends.

Two things were silently wrong for months because the web read a shape no one sends and its test mocks used that same wrong
shape: the settings block list read `json.data` from a bare array (empty for everyone since #2349), and the doc tree rename
read `{ data }` from a bare DocResponse (a saved rename showed «이름 바꾸기 실패»). This guard joins three facts:

  1. the backend's success shape per (method, path) — scripts/web_api_route_shapes.json, generated from the running app by
     backend/scripts/dump_web_route_shapes.py and kept fresh by backend/tests/test_4445_web_route_shapes_snapshot.py;
  2. what the BFF handler (apps/web/src/app/api/**/route.ts) does with it — `return proxyToFastapi(...)` passes the body
     through as is; `apiSuccess(await r.json())` / `proxyToFastapiWrapped` wrap it in `{ data }`;
  3. how each web call site reads its own response — `.data`, array operations, fields.

RED (no baseline — a new one fails at once):
  - a bare array read as `{ data }`            (e.g. `json.data ?? []` on a pass-through list)
  - a bare object read as `{ data }`           (e.g. `const { data } = await res.json()` on a pass-through model)
  - a `{ data }` envelope read as an array     (e.g. `Array.isArray(json)` / `.map` on a wrapped answer, no `.data`)
Lenient reads that accept either shape (`Array.isArray(x) ? x : x.data`, `x?.data ?? x`, `'data' in x ? x.data : x`) work
today but hide a future mismatch: their count per file is frozen in scripts/web_api_lenient_reads_baseline.json — a file whose
count grows is RED; a file whose count shrinks must lower its baseline (two-way ratchet: `--update-baseline`).

What this guard does NOT see (declared — story #4445 AC0):
  1. call sites whose path is a variable or built by a helper (`fetch(path)`, `ORG_NAMES_URL`, billing `path`, …);
  2. answers inside `Promise.all([...])` arrays or handed to another function before being read (only a response bound to
     its own variable and read in the next ~40 lines is judged);
  3. custom BFF handlers (fetchCall / their own logic) without `apiSuccess` — their shape is not derived;
  4. backend handlers returning a `dict` / no model without a `{"data"` literal — «unknown», not judged;
  5. a read hidden behind a cast or a generic helper the regexes don't recognise;
  6. consumers outside apps/web (desktop app, MCP, plugins) and SSE / websocket payloads;
  7. test mocks themselves — a mock can still use a shape no one sends; the guard checks the component's read, not the mock.

Usage:  python3 scripts/verify_web_api_response_shapes.py [--self-test | --update-baseline | --report]
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEB_SRC = REPO / "apps" / "web" / "src"
SNAPSHOT = REPO / "scripts" / "web_api_route_shapes.json"
BASELINE = REPO / "scripts" / "web_api_lenient_reads_baseline.json"

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
CALL = re.compile(r"\b(?:fetch|fetchWithAuth|apiFetch|authFetch)\s*\(\s*(['\"`])(/api/[^'\"`]*)\1")
LENIENT = {
    "isArray-or-data": re.compile(r"Array\.isArray\((\w+)\)\s*\?\s*\(?\1\b[^:\n]{0,40}:\s*\(?\(?\1\b[^;\n]{0,40}\.data"),
    "data-or-self": re.compile(r"\b(\w+)\??\.data\s*\?\?\s*\1\b(?!\.)"),
    "data-in": re.compile(r"['\"]data['\"]\s+in\s+(\w+)\s*\?\s*\1\.data\s*:\s*\1"),
    "key-in-self-or-data": re.compile(r"['\"]\w+['\"]\s+in\s+(\w+)\s*\?\s*\1\s*:\s*\1\??\.data"),
    "field-or-data-field": re.compile(r"\b(\w+)\??\.(\w+)\s*\?\?\s*\1\??\.data\??\.\2\b"),
}


def call_args(src: str, open_paren: int) -> str:
    """The text of one call's argument list (from its `(` to the matching `)`), so a later call's options don't leak in."""
    depth, i, quote = 0, open_paren, None
    while i < len(src) and i < open_paren + 2000:
        ch = src[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return src[open_paren: i + 1]
        i += 1
    return src[open_paren: open_paren + 300]


def norm_path(p: str) -> str:
    p = p.split("?")[0]
    p = re.sub(r"(?<![/{])\$\{[^}]*\}$", "", p)  # a trailing `${qs}` glued to a segment is a query string
    p = re.sub(r"\$\{[^}]*\}", "{}", p)
    p = re.sub(r"\[[^\]]+\]", "{}", p)
    p = re.sub(r"\{[^}]*\}", "{}", p)
    return p.rstrip("/") or "/"


# ── 2. BFF handlers ──────────────────────────────────────────────────────────────────────────────────────────────────────
def scan_bff(api_root: Path) -> list[dict]:
    out = []
    for dp, _, fs in os.walk(api_root):
        if "route.ts" not in fs:
            continue
        f = Path(dp) / "route.ts"
        src = f.read_text(encoding="utf-8")
        web = "/api/" + str(Path(dp).relative_to(api_root)).replace(os.sep, "/")
        marks = [(m.start(), m.group(1)) for m in re.finditer(r"export\s+(?:async\s+)?(?:function|const)\s+(" + "|".join(METHODS) + r")\b", src)]
        for i, (pos, meth) in enumerate(marks):
            block = src[pos: marks[i + 1][0] if i + 1 < len(marks) else len(src)]
            calls = re.findall(r"(proxyToFastapiWrapped|proxyToFastapiWithParams|proxyToFastapi)\s*\(\s*\w+\s*,\s*(['\"`])(.*?)\2", block, re.S)
            wraps = "apiSuccess(" in block
            if not calls:
                out.append({"web": norm_path(web), "method": meth, "be": None, "mode": "custom-envelope" if wraps else "custom", "file": str(f)})
                continue
            fn, _, p = calls[0]
            if fn == "proxyToFastapiWrapped":
                mode = "wrapped"
            else:
                direct = re.search(r"return\s+(?:await\s+)?" + fn + r"\s*\(", block) is not None
                assigned = re.search(r"=\s*(?:await\s+)?" + fn + r"\s*\(", block) is not None
                mode = "pass" if direct and not (assigned and wraps) else ("wrapped" if assigned and wraps else "transform")
            out.append({"web": norm_path(web), "method": meth, "be": norm_path(p), "mode": mode, "file": str(f)})
    return out


def match_bff(bff: list[dict], path: str, meth: str) -> dict | None:
    best = None
    for b in bff:
        if b["method"] != meth:
            continue
        pat = "^" + re.escape(b["web"]).replace(re.escape("{}"), "[^/]+") + "$"
        if b["web"] == path or re.match(pat, path):
            if best is None or b["web"].count("{}") < best["web"].count("{}"):
                best = b
    return best


def effective_shape(b: dict | None, meth: str, shapes: dict) -> str | None:
    """array / object / envelope, or None (not judged)."""
    if b is None:
        return None
    if b["mode"] in ("wrapped", "custom-envelope"):
        return "envelope"
    if b["mode"] != "pass":
        return None
    kind = shapes.get((meth, b["be"]))
    return kind if kind in ("array", "object", "envelope") else None


# ── 3. call sites: the response bound to its own variable, and how its JSON is read ─────────────────────────────────────
def read_of(src: str, call_start: int, call_end: int) -> dict | None:
    head = src[max(0, call_start - 160): call_start]
    tail = src[call_end: call_end + 4000]
    reads: set[str] = set()
    # `.then((r) => r.json()).then((j) => …)` / `.then((r) => (r.ok ? r.json() : X)).then(...)` straight after the call
    then = re.match(r"[^;]{0,200}?\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(?\s*(?:\1\.ok\s*\?\s*\(?\s*)?\1\.json\(\)[^;]{0,120}?\)\s*\.then\(\s*\(?\s*(\w+)", tail, re.S)
    if then:
        jv = then.group(2)
        seg = tail[then.end(): then.end() + 900]
        return classify(jv, seg, cast=None)
    bind = re.search(r"(?:const|let)\s+(\w+)\s*(?::[^=]{1,80})?=\s*(?:\(\s*)?await\s*$", head)
    if not bind:
        return None  # not bound to its own variable (Promise.all · returned · passed on): not judged
    rv = bind.group(1)
    j = re.search(r"(?:const|let)\s+(\{[^}]*\}|\w+)\s*(?::[^=]{1,120})?=\s*\(?\s*await\s+" + rv + r"\.json\(\)\s*\)?\s*(?:\.catch\([^)]*\)\s*\)?)?\s*(as\s+[^;\n]+)?", tail[:2500])
    if not j:
        return None
    v, cast = j.group(1), j.group(2) or ""
    if v.startswith("{"):
        reads.add("data" if re.search(r"(^|[{,\s])data\s*[,}:]", v + ",") else "fields")
        return {"reads": reads, "lenient": False}
    return classify(v, tail[j.start(): j.start() + 1500], cast=cast)


def classify(v: str, seg: str, cast: str | None) -> dict:
    reads: set[str] = set()
    if re.search(rf"\b{v}\??\.data\b", seg):
        reads.add("data")
    if re.search(rf"Array\.isArray\(\s*{v}\s*\)", seg):
        reads.add("isArray")
    if re.search(rf"\b{v}\??\.(?:map|filter|forEach|length|find|slice|some|every|reduce)\b", seg):
        reads.add("array-ops")
    if cast and re.search(r"as\s+[\w.<>]+\[\]\s*(?:;|\)|$)|as\s+Array<", cast) and "|" not in cast:
        reads.add("array-cast")
    lenient = any(p.search(seg) for p in LENIENT.values()) or bool(re.search(rf"\b{v}\??\.data\s*\?\?\s*{v}\b", seg))
    return {"reads": reads, "lenient": lenient}


def verdict(shape: str | None, r: dict | None) -> str | None:
    if shape is None or r is None or r["lenient"]:
        return None
    rd = r["reads"]
    if shape == "array" and "data" in rd and "isArray" not in rd:
        return "a bare array read as { data }"
    if shape == "object" and "data" in rd:
        return "a bare object read as { data }"
    if shape == "envelope" and rd & {"isArray", "array-ops", "array-cast"} and "data" not in rd:
        return "a { data } envelope read as an array"
    return None


def scan(web_src: Path, shapes: dict) -> tuple[list[dict], dict[str, dict[str, int]], int]:
    bff = scan_bff(web_src / "app" / "api")
    mismatches, lenient_counts, judged = [], {}, 0
    for dp, _, fs in os.walk(web_src):
        if "node_modules" in dp or os.sep + os.path.join("app", "api") in dp + os.sep and dp.startswith(str(web_src / "app" / "api")):
            continue
        for fn in fs:
            if not fn.endswith((".ts", ".tsx")) or ".test." in fn or fn.endswith(".d.ts"):
                continue
            f = Path(dp) / fn
            rel = str(f.relative_to(web_src))
            src = f.read_text(encoding="utf-8")
            counts = {k: len(p.findall(src)) for k, p in LENIENT.items()}
            if any(counts.values()):
                lenient_counts[rel] = {k: n for k, n in counts.items() if n}
            for m in CALL.finditer(src):
                path = norm_path(m.group(2))
                args = call_args(src, src.index("(", m.start()))
                mm = re.search(r"method\s*:\s*['\"](\w+)['\"]", args)
                meth = mm.group(1).upper() if mm else "GET"
                shape = effective_shape(match_bff(bff, path, meth), meth, shapes)
                r = read_of(src, m.start(), m.end())
                if shape and r:
                    judged += 1
                why = verdict(shape, r)
                if why:
                    mismatches.append({"site": f"{rel}:{src[: m.start()].count(chr(10)) + 1}", "call": f"{meth} {path}", "shape": shape, "why": why})
    return mismatches, lenient_counts, judged


def load_shapes(path: Path) -> dict:
    return {(r["method"], r["path"]): r["kind"] for r in json.loads(path.read_text(encoding="utf-8"))}


def check(web_src: Path, shapes: dict, baseline: dict[str, dict[str, int]], out=print) -> int:
    mismatches, counts, judged = scan(web_src, shapes)
    rc = 0
    for x in mismatches:
        out(f"RED  {x['site']}  {x['call']}  — {x['why']} (the answer is {x['shape']})")
        rc = 1
    for f in sorted(set(counts) | set(baseline)):
        for k in LENIENT:
            now, was = counts.get(f, {}).get(k, 0), baseline.get(f, {}).get(k, 0)
            if now > was:
                out(f"RED  {f}  lenient read «{k}» grew {was} → {now} — read the contract's one shape (and fail visibly otherwise)")
                rc = 1
            elif now < was:
                out(f"RED  {f}  lenient read «{k}» shrank {was} → {now} — lower the baseline: python3 scripts/verify_web_api_response_shapes.py --update-baseline")
                rc = 1
    if rc == 0:
        out(f"OK: {judged} call sites judged against the backend's shapes · 0 mismatches · lenient reads at baseline "
            f"({sum(sum(v.values()) for v in counts.values())} in {len(counts)} files)")
    return rc


# ── self-test: seeded fixtures the guard must catch, and fine ones it must pass ─────────────────────────────────────────
def self_test() -> int:
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        api = src / "app" / "api"
        def w(rel: str, text: str) -> None:
            p = src / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        w("app/api/blocks/route.ts", "export async function GET(request: Request) {\n  return proxyToFastapi(request, '/api/v2/blocks');\n}\n")
        w("app/api/docs/[id]/route.ts", "export async function PATCH(request: Request) {\n  return proxyToFastapi(request, `/api/v2/docs/${id}`);\n}\n")
        w("app/api/teams/route.ts", "export async function GET(request: Request) {\n  const _r = await proxyToFastapi(request, '/api/v2/teams');\n  return apiSuccess(await _r.json());\n}\n")
        shapes = {("GET", "/api/v2/blocks"): "array", ("PATCH", "/api/v2/docs/{}"): "object", ("GET", "/api/v2/teams"): "array"}
        w("components/bad.tsx", "\n".join([
            "async function a() {",
            "  const res = await fetchWithAuth('/api/blocks');",
            "  const json = await res.json() as { data?: Row[] };",
            "  setRows(json.data ?? []);",
            "}",
            "async function b(id: string) {",
            "  const res = await fetch(`/api/docs/${id}`, { method: 'PATCH', body: '{}' });",
            "  const { data } = await res.json() as { data: { updated_at: string } };",
            "}",
            "async function c() {",
            "  const res = await fetchWithAuth('/api/teams');",
            "  const list = await res.json() as Team[];",
            "  setTeams(list.map((t) => t));",
            "}",
        ]))
        w("components/good.tsx", "\n".join([
            "async function a() {",
            "  const res = await fetchWithAuth('/api/blocks');",
            "  const json: unknown = await res.json();",
            "  if (!Array.isArray(json)) return;",
            "}",
            "async function b(id: string) {",
            "  const res = await fetch(`/api/docs/${id}`, { method: 'PATCH', body: '{}' });",
            "  const saved = await res.json() as { updated_at?: string };",
            "  use(saved.updated_at);",
            "}",
            "async function c() {",
            "  const res = await fetchWithAuth('/api/teams');",
            "  const json = await res.json() as { data: Team[] };",
            "  setTeams(json.data);",
            "}",
        ]))
        mismatches, counts, _ = scan(src, shapes)
        sites = sorted(x["site"] for x in mismatches)
        ok = sites == sorted(["components/bad.tsx:2", "components/bad.tsx:7", "components/bad.tsx:11"])
        # lenient read growth is caught (baseline 0 → 1) and a shrink must lower the baseline
        w("components/lenient.tsx", "async function d() {\n  const res = await fetchWithAuth('/api/teams');\n  const j = await res.json();\n  setTeams(Array.isArray(j) ? j : j.data);\n}\n")
        msgs: list[str] = []
        rc_grow = check(src, shapes, {}, out=msgs.append)
        grew = rc_grow == 1 and any("lenient.tsx" in m and "grew" in m for m in msgs)
        msgs.clear()
        rc_shrink = check(src, shapes, {"components/lenient.tsx": {"isArray-or-data": 2}}, out=msgs.append)
        shrank = rc_shrink == 1 and any("shrank" in m for m in msgs)
        print(f"self-test: mismatches {sites} → {'ok' if ok else 'FAIL'} · lenient growth {'ok' if grew else 'FAIL'} · shrink {'ok' if shrank else 'FAIL'}")
        return 0 if ok and grew and shrank else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    shapes = load_shapes(SNAPSHOT)
    if "--update-baseline" in argv:
        _, counts, _ = scan(WEB_SRC, shapes)
        BASELINE.write_text(json.dumps(dict(sorted(counts.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"baseline written: {sum(sum(v.values()) for v in counts.values())} lenient reads in {len(counts)} files")
        return 0
    if "--report" in argv:
        mismatches, counts, judged = scan(WEB_SRC, shapes)
        print(json.dumps({"judged": judged, "mismatches": mismatches, "lenient": Counter(k for v in counts.values() for k, n in v.items() for _ in range(n))}, ensure_ascii=False, indent=1))
        return 0
    baseline = json.loads(BASELINE.read_text(encoding="utf-8")) if BASELINE.exists() else {}
    return check(WEB_SRC, shapes, baseline)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
