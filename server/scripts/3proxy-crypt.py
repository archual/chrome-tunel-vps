#!/usr/bin/env python3
"""Generate 3proxy CR:$3$ (BLAKE2b-crypt) password hashes.

3proxy 0.9.9 LTS accepts CR:$3$<salt>$<hash> entries in its users file.
The official 3proxy/3proxy:lts-busybox image ships only /bin/3proxy and
does not include the 3proxy_crypt helper, so user scripts use this file to
produce byte-identical hashes on the host.

Algorithm (see src/3proxy_crypt.c in 3proxy 0.9.9):
    digest = BLAKE2b-128(password || NUL || salt)
    hash   = crypt-base64(digest) using "./0-9A-Za-z"

Usage:
    3proxy-crypt.py <salt> <password>
    3proxy-crypt.py --password-stdin <salt>
    3proxy-crypt.py --self-test

The password is never written to a file or log by this helper.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sys

ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
SALT_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# Vectors produced by the reference 3proxy_crypt from 3proxy 0.9.9.
SELF_TEST_VECTORS = (
    ("testsalt", "testpass", "CR:$3$testsalt$rLpPSsFiEZbWom3uj3E.40"),
    (
        "abcdefgh12345678",
        "spikeuserpass123",
        "CR:$3$abcdefgh12345678$dm1YsEIvPs2Z280yw3fmv0",
    ),
)


def _crypt_to64(value: int, count: int) -> str:
    out = []
    for _ in range(count):
        out.append(ALPHABET[value & 0x3F])
        value >>= 6
    return "".join(out)


def hash_password(password: bytes, salt: str) -> str:
    """Return the 3proxy CR:$3$ representation for ``password``."""
    if not SALT_RE.fullmatch(salt):
        raise ValueError(
            "salt must be 1-64 characters from [A-Za-z0-9._-]"
        )
    digest = hashlib.blake2b(
        password + b"\x00" + salt.encode("utf-8"), digest_size=16
    ).digest()
    encoded = "".join(
        _crypt_to64((digest[a] << 16) | (digest[b] << 8) | digest[c], 4)
        for a, b, c in ((0, 6, 12), (1, 7, 13), (2, 8, 14), (3, 9, 15))
    )
    encoded += _crypt_to64((digest[4] << 16) | (digest[10] << 8) | digest[5], 4)
    encoded += _crypt_to64(digest[11], 2)
    return f"CR:$3${salt}${encoded}"


def generate_salt() -> str:
    """Return a random 16-character salt (64 bits of entropy)."""
    return secrets.token_hex(8)


def _self_test() -> int:
    failures = 0
    for salt, password, expected in SELF_TEST_VECTORS:
        actual = hash_password(password.encode("utf-8"), salt)
        status = "ok" if actual == expected else "FAIL"
        if actual != expected:
            failures += 1
        print(f"{status} salt={salt} expected={expected} actual={actual}")
    return 1 if failures else 0


def _usage() -> None:
    print(__doc__.strip(), file=sys.stderr)


def main(argv: list[str]) -> int:
    args = argv[1:]
    if args == ["--self-test"]:
        return _self_test()
    password_stdin = False
    if "--password-stdin" in args:
        password_stdin = True
        args = [a for a in args if a != "--password-stdin"]
    if len(args) == 1:
        salt = args[0]
        if password_stdin:
            password = sys.stdin.buffer.readline().rstrip(b"\r\n")
        else:
            print("password argument is required", file=sys.stderr)
            _usage()
            return 2
    elif len(args) == 2:
        if password_stdin:
            print("do not pass both --password-stdin and a password", file=sys.stderr)
            return 2
        salt, password_text = args
        password = password_text.encode("utf-8")
    else:
        _usage()
        return 2
    if not password:
        print("password must not be empty", file=sys.stderr)
        return 2
    try:
        print(hash_password(password, salt))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
