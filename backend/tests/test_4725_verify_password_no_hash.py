"""story 4725 — a password check against «no usable hash» answers False; it never raises (a provider-made account, or one whose password was cleared, stores "")."""
from app.core.security import hash_password, verify_password


def test_a_real_hash_still_checks():
    h = hash_password("Correct!Passw0rd")
    assert verify_password("Correct!Passw0rd", h) is True
    assert verify_password("wrong", h) is False


def test_no_hash_is_a_refusal_not_an_error():
    assert verify_password("anything", "") is False
    assert verify_password("", "") is False


def test_a_hash_nobody_can_identify_is_a_refusal_not_an_error():
    assert verify_password("anything", "not-a-hash") is False
    assert verify_password("anything", "$unknown$x$y") is False
