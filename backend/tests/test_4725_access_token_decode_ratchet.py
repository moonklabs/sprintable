"""story 4725 (Mirko 6228236239) — the table of every place the backend decodes a JWT by hand, and the rule that an ACCESS token of ours is only ever turned into
claims by `dependencies.auth.verify_access_token` (signature · type · subject · the per-user cut-off). Without it every new hand decode is one more route where an old
token — a reclaimed account's, a revoked person's — keeps working. A new decode anywhere else fails here, so adding one is a deliberate edit of this table."""
from __future__ import annotations

import inspect
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
PATTERN = re.compile(r"\b(?:decode_jwt\w*|jose_jwt\.decode|jwt\.decode|get_unverified_claims)\(")

# file (relative to app/) → (number of decode sites, what they are) — none of them decodes an ACCESS token of ours except the one in verify_access_token
TABLE = {
    "dependencies/auth.py": (1, "verify_access_token — THE access-token decode (type · sub · cut-off)"),
    "routers/auth.py": (3, "two refresh-token decodes (refresh · switch-account: refresh tokens are rows that the reclaim revokes) + the Apple id_token"),
    "core/security.py": (7, "decode_jwt itself + the typed e-mail-verification / password-reset / oauth-state / handoff tokens (own `type` claim each)"),
    "routers/account.py": (1, "decode_jwt_ignore_exp on the REFRESH token of the signing-out session (a row the reclaim revokes), read only"),
    "routers/github_integration.py": (1, "unverified OAuth state of the GitHub install flow"),
    "routers/support_gateway_token.py": (1, "support-gateway delivery token (own secret and audience)"),
    "services/github_app.py": (1, "GitHub app JWT verification"),
    "services/channel_oauth_state.py": (1, "channel OAuth state"),
    "services/firebase_verifier.py": (2, "Firebase ID / session token verification (provider tokens)"),
}


def _count(text: str) -> int:
    # a definition line (`def decode_jwt(`) is not a call
    return sum(1 for line in text.splitlines() if PATTERN.search(line) and not line.lstrip().startswith(("def ", "async def ")))


def test_every_hand_decode_of_a_jwt_is_in_the_table():
    found: dict[str, int] = {}
    for f in APP.rglob("*.py"):
        n = _count(f.read_text(encoding="utf-8"))
        if n:
            found[str(f.relative_to(APP))] = n
    assert found == {k: v[0] for k, v in TABLE.items()}, (
        "a JWT is decoded by hand somewhere new (or a decode moved): if it is an ACCESS token of ours it must go through "
        "dependencies.auth.verify_access_token; otherwise add it to TABLE with the reason. found=%r" % found
    )


def test_the_routes_that_took_an_access_token_by_hand_use_the_one_verifier():
    import app.routers.onboarding as onboarding
    import app.routers.ws_chat as ws_chat
    from app.dependencies import auth as deps

    assert "verify_access_token(" in inspect.getsource(ws_chat._authenticate)
    assert "verify_access_token(" in inspect.getsource(onboarding)
    src = inspect.getsource(deps)
    assert src.count("await verify_access_token(") == 2          # get_current_user + its streaming variant
    assert "_reject_if_before_cutover(user_id, payload.get(\"iat\"), db)" in inspect.getsource(deps.verify_access_token)
