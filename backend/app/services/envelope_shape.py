"""story 4972 — what the server may check of an envelope it cannot open: its SHAPE and size, nothing else (design ① D5).

The server never holds a key: it cannot verify a signature or read a word. It refuses an envelope that is not the agreed shape (unknown or missing
fields · a base64url field that is not canonical text · a size over the limit · a receiver list that does not match its wraps) so that what it
stores and serves is always the same kind of thing — and returns it unchanged. The host (relay/envelope.ts) and the phone shell (lib/envelope.js)
check everything else: the signature over the whole envelope, the receiver's own wrap, the replay marks.
"""
from __future__ import annotations

import base64
import binascii
import re
import uuid

ENVELOPE_VERSION = 1
# the kinds a header may carry (design ② §4-1)
ENVELOPE_KINDS = frozenset({
    "send_prompt", "approval_card", "approval_record", "changes", "clock_draft", "clock_edit", "chat_line",
    "key_notice", "migrate_approve", "record_handoff", "direct_open", "direct_offer", "direct_close",
    "file_list", "file_result",  # story 4983 (P5): a phone's request to list a folder of a project of its computer, and the computer's answer
    "file_read",  # story 4983 (P6): a phone's request to open one file of a project of its computer (its answer is a `file_result` too)
    "file_download",  # story 4988 (P8): a phone's request to download one file of a project of its computer (its answer is a train of `file_result` chunks)
})
MAX_CT_BYTES = 256 * 1024
# a card's words are a few hundred characters and a preview of at most 2400 — a card envelope is small (the host pads to a fixed width inside this cap)
# story 4976: a phone's instruction into the running turn is at most INSTRUCT_NOW_MAX (400) characters — a few KiB at 4 bytes a character; the phone pads to a fixed width inside this cap
# story 4983: a files request (a list or an open) is a short list of names (the padded frame is at most 4096 bytes, contract `envelope.request.ct_max_bytes` · `envelope.request_read.ct_max_bytes`); its answer is the full cap
HANDOFF_CT_BYTES = 14608  # story 4978: a `record_handoff` body is ONE fixed width (the 14,592-byte frame + the 16-byte tag — 256 key generations and 32 record writers' worth, whatever travels): the server cannot learn how many of either
MAX_CT_BYTES_BY_KIND = {"record_handoff": HANDOFF_CT_BYTES, "approval_card": 16 * 1024, "send_prompt": 8 * 1024, "file_list": 4 * 1024, "file_read": 4 * 1024, "file_download": 4 * 1024, "direct_open": 1024, "direct_offer": 1024}  # story 4993: an ask is a short canonical text padded to 256 B; an answer is padded to whole 512 B buckets (an address, a port, a ticket — or a refusal)
MAX_TO = 16
MAX_TEXT = 256
MAX_SAFE_INT = 2**53 - 1
_HEADER_KEYS = {"v", "kind", "setup_id", "session_key", "command_id", "expires_at", "from", "to", "epoch", "ctr", "ts", "nonce", "rec", "wraps", "ct", "sig"}
_REQUIRED = _HEADER_KEYS - {"rec"}
_B64URL = re.compile(r"[A-Za-z0-9_-]+")  # used with fullmatch — `$` would let a trailing newline through


def _b64(value: object, *, exact_bytes: int | None = None, min_bytes: int = 1, max_bytes: int | None = None, what: str) -> int:
    """a canonical base64url text (no padding) → the number of bytes it holds"""
    if isinstance(value, str) and max_bytes is not None and len(value) > (max_bytes * 4 + 2) // 3 + 4:
        raise ValueError(f"envelope: {what} is too long")  # judged on the TEXT, before anything is decoded
    if not isinstance(value, str) or not value or not _B64URL.fullmatch(value) or len(value) % 4 == 1:
        raise ValueError(f"envelope: {what} is not base64url")
    try:  # canonical: the text must be the ONE spelling of its bytes (no spare bits set)
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError):
        raise ValueError(f"envelope: {what} is not base64url") from None
    if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != value:
        raise ValueError(f"envelope: {what} is not canonical base64url")
    n = len(raw)
    if exact_bytes is not None and n != exact_bytes:
        raise ValueError(f"envelope: {what} is {n} bytes, not {exact_bytes}")
    if n < min_bytes or (max_bytes is not None and n > max_bytes):
        raise ValueError(f"envelope: {what} is {n} bytes, outside {min_bytes}..{max_bytes}")
    return n


def _int(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_SAFE_INT:
        raise ValueError(f"envelope: {what} is not a small non-negative integer")
    return value


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def _text(value: object, what: str) -> str:
    """a short text with no control character (NUL included) and no lone surrogate — jsonb refuses both, which would be a 500, and a lone surrogate is two different texts to the phone and the host"""
    if not isinstance(value, str) or len(value) > MAX_TEXT or _CONTROL.search(value):
        raise ValueError(f"envelope: {what} is not a short text")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError(f"envelope: {what} is not a short text") from None
    return value


def check_envelope(env: object, *, kind: str | None = None) -> dict:
    """The envelope unchanged, or ValueError. `kind`: the one kind this place takes."""
    if not isinstance(env, dict):
        raise ValueError("envelope: not an object")
    # no field NAME of the caller's is echoed back (an error text reaches logs and the response; only our own names may)
    if any(not isinstance(k, str) for k in env) or set(env) - _HEADER_KEYS or _REQUIRED - set(env):
        raise ValueError("envelope: unknown or missing fields")
    if type(env["v"]) is not int or env["v"] != ENVELOPE_VERSION:
        raise ValueError("envelope: unknown version")
    if not isinstance(env["kind"], str) or env["kind"] not in ENVELOPE_KINDS or (kind is not None and env["kind"] != kind):
        raise ValueError("envelope: kind not accepted here")
    for k in ("setup_id", "session_key", "command_id", "from"):
        _text(env[k], k)
    for k in ("expires_at", "epoch", "ctr", "ts"):
        _int(env[k], k)
    to = env["to"]
    if not isinstance(to, list) or not 1 <= len(to) <= MAX_TO or len(set(map(str, to))) != len(to):
        raise ValueError("envelope: `to` is not 1..16 different receivers")
    for t in to:
        _text(t, "to")
        if not t:
            raise ValueError("envelope: an empty receiver id")
    _b64(env["nonce"], exact_bytes=16, what="nonce")
    wraps = env["wraps"]
    if not isinstance(wraps, list) or len(wraps) != len(to):
        raise ValueError("envelope: wraps do not match the receivers")
    for w, t in zip(wraps, to):
        if not isinstance(w, dict) or set(w) != {"to", "enc", "ek"} or w["to"] != t:
            raise ValueError("envelope: a wrap does not match its receiver")
        _b64(w["enc"], exact_bytes=32, what="wrap enc")
        _b64(w["ek"], exact_bytes=48, what="wrap key")  # a 32-byte body key + the 16-byte tag
    _b64(env["ct"], min_bytes=20, max_bytes=MAX_CT_BYTES_BY_KIND.get(env["kind"], MAX_CT_BYTES) + 16, what="body")  # a 4-byte frame + the tag at the least
    _b64(env["sig"], min_bytes=8, max_bytes=80, what="signature")
    rec = env.get("rec")
    if rec is not None:
        if not isinstance(rec, dict) or set(rec) != {"conversation_id", "record_id", "rec_gen"}:
            raise ValueError("envelope: rec is not the agreed shape")
        _text(rec["conversation_id"], "rec.conversation_id")
        _text(rec["record_id"], "rec.record_id")
        _int(rec["rec_gen"], "rec.rec_gen")
    return env


# story 4977 B2: a RECORD envelope (design ② §4-1b) — the person's history, sealed under the record key R_g, not under a receiver's key: no receiver, no wrap, and always a `rec` (the conversation ·
# the record id · the key generation). It is a different shape from a transport envelope (`check_envelope` wants 1..16 receivers), so it has its own check: this one and no other lets a record in.
RECORD_KINDS = frozenset({"chat_line", "approval_record"})
MAX_REC_GEN = 2**31 - 1  # the database column is an Integer
MAX_RECORD_CT_BYTES = 32 * 1024  # an instruction is a few KiB (the phone pads to a fixed width inside this) · an approval's outcome is a few hundred bytes


def check_record_envelope(env: object) -> dict:
    """The record envelope unchanged, or ValueError. The server checks only what it can see: the agreed header, `to` and `wraps` EMPTY, a `rec` of the agreed shape (a conversation id that is a UUID · a
    record id · a generation of 1 or more), canonical base64url fields and a size over the limit refused before anything is decoded. It never opens `ct` and cannot verify `sig` — the readers do, on every read."""
    if not isinstance(env, dict):
        raise ValueError("envelope: not an object")
    if any(not isinstance(k, str) for k in env) or set(env) - _HEADER_KEYS or _HEADER_KEYS - set(env):  # `rec` is NOT optional here
        raise ValueError("envelope: unknown or missing fields")
    if type(env["v"]) is not int or env["v"] != ENVELOPE_VERSION:
        raise ValueError("envelope: unknown version")
    if not isinstance(env["kind"], str) or env["kind"] not in RECORD_KINDS:
        raise ValueError("envelope: kind not accepted here")
    for k in ("setup_id", "session_key", "command_id", "from"):
        _text(env[k], k)
    if not env["from"]:
        raise ValueError("envelope: an empty writer id")
    for k in ("expires_at", "epoch", "ctr", "ts"):
        _int(env[k], k)
    if env["to"] != [] or env["wraps"] != []:
        raise ValueError("envelope: a record has no receivers")
    _b64(env["nonce"], exact_bytes=16, what="nonce")
    _b64(env["ct"], min_bytes=20, max_bytes=MAX_RECORD_CT_BYTES + 16, what="body")
    _b64(env["sig"], min_bytes=8, max_bytes=80, what="signature")
    rec = env["rec"]
    if not isinstance(rec, dict) or set(rec) != {"conversation_id", "record_id", "rec_gen"}:
        raise ValueError("envelope: rec is not the agreed shape")
    cid = _text(rec["conversation_id"], "rec.conversation_id")
    try:
        if str(uuid.UUID(cid)) != cid:
            raise ValueError
    except ValueError:
        raise ValueError("envelope: rec.conversation_id is not a conversation id") from None
    if not _text(rec["record_id"], "rec.record_id"):
        raise ValueError("envelope: an empty record id")
    if not 1 <= _int(rec["rec_gen"], "rec.rec_gen") <= MAX_REC_GEN:
        raise ValueError("envelope: a record key generation is 1 or more and fits the column")
    return env


def check_record_handoff(env: object, *, setup_id: str) -> dict:
    """story 4978 (C2): a `record_handoff` envelope as the server may judge it — SHAPE and size, nothing it would need a key for: the agreed shape of every envelope, then this kind's own: ONE receiver, no `rec`, no session key, the body at exactly
    the fixed width (so its size tells nothing), and the pairing it names is the one the request is for. Returned unchanged, or ValueError (never a word of the envelope in the message)."""
    check_envelope(env, kind="record_handoff")
    assert isinstance(env, dict)
    if len(env["to"]) != 1 or "rec" in env or env["session_key"] != "":  # `rec` ABSENT (a null is a field too)
        raise ValueError("envelope: not the shape of a record handoff")
    _b64(env["command_id"], exact_bytes=16, what="command_id")  # the envelope's one-time id: the base64url of the body's 16-byte nonce (so it also fits the table's 64-character column)
    if _b64(env["ct"], what="body") != HANDOFF_CT_BYTES:
        raise ValueError("envelope: a record handoff body has one fixed width")
    if env["setup_id"] != setup_id:
        raise ValueError("envelope: it names another pairing")
    return env
