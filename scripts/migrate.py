#!/usr/bin/env python3
"""Apply SQLite migrations for ClawBrain."""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = Path("/data/clawbrain/db/clawbrain.sqlite3")
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_NAME_RE = re.compile(r"^(\d+)_.*\.sql$")


class MigrationError(Exception):
    """Raised when migration execution fails."""


def discover_migrations() -> list[tuple[int, Path]]:
    if not MIGRATIONS_DIR.is_dir():
        raise MigrationError(f"migrations directory not found: {MIGRATIONS_DIR}")

    migrations: list[tuple[int, Path]] = []
    seen_versions: set[int] = set()
    for file_path in sorted(MIGRATIONS_DIR.iterdir()):
        if not file_path.is_file():
            continue
        match = MIGRATION_NAME_RE.match(file_path.name)
        if not match:
            continue
        version = int(match.group(1))
        if version in seen_versions:
            raise MigrationError(f"duplicate migration version detected: {version}")
        seen_versions.add(version)
        migrations.append((version, file_path))

    return sorted(migrations, key=lambda item: item[0])


def ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
        """
    )


def get_applied_versions(conn: sqlite3.Connection) -> set[int]:
    rows = conn.execute("SELECT version FROM migrations ORDER BY version ASC").fetchall()
    return {int(row[0]) for row in rows}


def apply_migrations(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    migrations = discover_migrations()

    if not migrations:
        print("[INFO] No migration files found.")
        return

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        ensure_migrations_table(conn)
        applied_versions = get_applied_versions(conn)

        for version, migration_path in migrations:
            if version in applied_versions:
                print(f"[SKIP] Migration v{version:04d} already applied: {migration_path.name}")
                continue

            sql_script = migration_path.read_text(encoding="utf-8")
            applied_at = dt.datetime.now(dt.timezone.utc).isoformat()

            with conn:
                conn.execute("PRAGMA foreign_keys = ON;")
                conn.executescript(sql_script)
                conn.execute(
                    "INSERT INTO migrations(version, applied_at) VALUES (?, ?)",
                    (version, applied_at),
                )

            print(f"[OK] Applied migration v{version:04d}: {migration_path.name}")

        final_versions = sorted(get_applied_versions(conn))
        print(f"[OK] Migration state: {final_versions}")
    except (sqlite3.DatabaseError, OSError) as exc:
        raise MigrationError(f"failed to apply migrations on {db_path}: {exc}") from exc
    finally:
        conn.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply ClawBrain SQLite migrations.")
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help=f"SQLite database path (default: {DEFAULT_DB_PATH})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = Path(args.db_path).expanduser()
    print(f"[STEP] Using database: {db_path}")
    apply_migrations(db_path)
    print("[OK] Migration run finished")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

