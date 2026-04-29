from jose import JWTError, jwt

from app.core.config import settings


def decode_jwt(token: str) -> dict:
    """Decode Supabase GoTrue-compatible JWT. Raises JWTError on failure."""
    return jwt.decode(
        token,
        settings.supabase_jwt_secret,
        algorithms=["HS256"],
        options={"verify_aud": False},
    )


__all__ = ["decode_jwt", "JWTError"]
