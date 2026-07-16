#!/usr/bin/env python3

import os
import sys

from ds_store import DSStore
from mac_alias import Alias


def update_background_alias(store_path, background_path):
    with DSStore.open(store_path, "r+") as store:
        settings = store["."]["icvp"]
        settings["backgroundImageAlias"] = Alias.for_file(background_path).to_bytes()
        store["."]["icvp"] = settings


def verify_background_alias(store_path, background_path):
    with DSStore.open(store_path, "r") as store:
        settings = store["."]["icvp"]
        alias = Alias.from_bytes(settings["backgroundImageAlias"])

    expected_suffix = (
        "/Libre WebUI Frontend.app/Contents/Resources/"
        + os.path.basename(background_path)
    )
    if alias.target.filename != os.path.basename(background_path):
        raise RuntimeError(
            f"Finder background filename is {alias.target.filename!r}, "
            f"expected {os.path.basename(background_path)!r}"
        )
    if not alias.target.posix_path.endswith(expected_suffix):
        raise RuntimeError(
            f"Finder background alias points to {alias.target.posix_path!r}, "
            f"expected a path ending in {expected_suffix!r}"
        )


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in {"update", "verify"}:
        raise SystemExit(
            "Usage: macos-dmg-finder.py <update|verify> "
            "<.DS_Store path> <background path>"
        )

    mode, store_path, background_path = sys.argv[1:]
    if mode == "update":
        update_background_alias(store_path, background_path)
    else:
        verify_background_alias(store_path, background_path)


if __name__ == "__main__":
    main()
