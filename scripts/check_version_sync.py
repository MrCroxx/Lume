#!/usr/bin/env python3

import re
import sys
import tomllib
from pathlib import Path


PACKAGE_NAME = "lume-server"
STABLE_SEMVER = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$"
)


def load_toml(path: Path) -> dict:
    with path.open("rb") as source:
        return tomllib.load(source)


def fail(message: str) -> None:
    print(f"version check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    version = (repository / "VERSION").read_text(encoding="utf-8").strip()

    if not STABLE_SEMVER.fullmatch(version):
        fail(f"VERSION must contain a stable SemVer version, got {version!r}")

    manifest = load_toml(repository / "backend" / "Cargo.toml")
    manifest_version = manifest.get("package", {}).get("version")
    if manifest_version != version:
        fail(
            f"backend/Cargo.toml contains {manifest_version!r}, expected {version!r}"
        )

    lockfile = load_toml(repository / "Cargo.lock")
    lock_versions = [
        package.get("version")
        for package in lockfile.get("package", [])
        if package.get("name") == PACKAGE_NAME
    ]
    if lock_versions != [version]:
        fail(
            f"Cargo.lock contains {lock_versions!r} for {PACKAGE_NAME}, "
            f"expected [{version!r}]"
        )

    print(f"version check passed: {PACKAGE_NAME} {version}")


if __name__ == "__main__":
    main()
