import hashlib
import hmac
import time


def verify_slack_signature(
    signing_secret: str,
    signature: str | None,
    timestamp: str | None,
    raw_body: str,
) -> bool:
    if not signature or not timestamp:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs(time.time() - ts) > 300:
        return False
    expected = "v0=" + hmac.new(
        signing_secret.encode(),
        f"v0:{timestamp}:{raw_body}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
