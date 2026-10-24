"""story 4762 — the phone check number is ONE computation on the phone shell, the desktop app and the server (contract §10): the first four bytes of
sha256(SPKI DER) as a big-endian unsigned integer, mod 1,000,000, six digits, «### ###».

The web's «원격 기기» list prints the server's value; the phone app's «설정 › 이 폰» prints the shell's. They are the same number only while both ends compute the
same string, so the two fixed vectors below are shared with the shell's test (sprintable-mobile `lib/phoneCalls.test.js`, `registrationNumber`) and the web's
card test (`components/settings/this-phone-card.4762.test.tsx`). Changing the formula on one end turns that end's copy of this vector red.
"""
from app.services.agent_permissions import confirm_number

# the SPKI is any bytes here (the number is a pure function of them): ASCII text, and 0x00..0x3f (a leading-zero result)
VECTORS = [
    (b"sprintable-4762-check-number-vector", "324 642"),
    (bytes(range(64)), "018 604"),
]


def test_the_server_computes_the_shared_check_number_vectors():
    for der, expected in VECTORS:
        assert confirm_number(der) == expected, der[:16]


def test_a_leading_zero_is_kept_and_the_shape_is_three_three():
    n = confirm_number(bytes(range(64)))
    assert n == "018 604"  # not «18 604» (mod 1e6 is zero-padded to six digits first)
    assert len(n) == 7 and n[3] == " " and n.replace(" ", "").isdigit()
