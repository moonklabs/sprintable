"""Generate .env from .env.example with auto-generated secrets.

Usage:
    python3 scripts/init-env.py          # creates .env if not present
    python3 scripts/init-env.py --force  # overwrite existing .env
"""
import os
import secrets
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".env")
EXAMPLE_FILE = os.path.join(ROOT, ".env.example")

PLACEHOLDERS = {
    "JWT_SECRET=change-me-in-production-min-32-chars": lambda: f"JWT_SECRET={secrets.token_hex(32)}",
    "SECRET_KEY=change-me-in-production-min-32-chars": lambda: f"SECRET_KEY={secrets.token_hex(32)}",
    "POSTGRES_PASSWORD=change-me-in-production": lambda: f"POSTGRES_PASSWORD={secrets.token_hex(16)}",
}

force = "--force" in sys.argv

if os.path.exists(ENV_FILE) and not force:
    print("[init-env] .env already exists — skipping (use --force to overwrite)")
    sys.exit(0)

with open(EXAMPLE_FILE) as f:
    content = f.read()

for placeholder, generator in PLACEHOLDERS.items():
    content = content.replace(placeholder, generator(), 1)

with open(ENV_FILE, "w") as f:
    f.write(content)

print("[init-env] .env created with auto-generated JWT_SECRET, SECRET_KEY, POSTGRES_PASSWORD")
print("[init-env] Next: docker compose up -d")
