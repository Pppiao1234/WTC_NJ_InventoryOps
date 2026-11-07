"""Build the public v1.7 Apps Script artifact from an explicit source list."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "nj_load_sync"
DIST = ROOT / "dist"
PARTS = [
    "engine.js", "unload_engine.js", "operations_engine.js", "forecast_engine.js",
    "loading_portal_core.js", "photo_intake_core.js", "adapter.gs",
    "photo_adapter.gs", "photo_ui.gs", "table_inventory_core.js",
    "table_source_reader.gs", "table_inventory_adapter.gs", "table_inventory_ui.gs",
]


def main():
    node = os.environ.get("WTC_NODE_BINARY") or shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required to run the test suite before building.")
    tests = sorted(path.name for path in SOURCE.glob("*.test.js"))
    if not tests:
        raise SystemExit("No tests found; refusing to build an unverified artifact.")
    run = subprocess.run(
        [node, "--test", "--test-reporter=tap", *tests], cwd=SOURCE,
        capture_output=True, text=True,
    )
    DIST.mkdir(exist_ok=True)
    (DIST / "test-results.txt").write_text(run.stdout + run.stderr, encoding="utf-8")
    if run.returncode:
        raise SystemExit(run.stdout + run.stderr)
    count_match = re.search(r"^# tests (\d+)$", run.stdout, re.M)
    failure_match = re.search(r"^# fail (\d+)$", run.stdout, re.M)
    if not count_match or not failure_match or int(failure_match.group(1)):
        raise SystemExit("Test summary could not be verified.")

    header = """/*
WINGTAT NJ InventoryOps v1.7.0 — public configurable source build.
Set deployment bindings in Apps Script Properties before use; see docs/DEPLOYMENT.md.
This artifact contains no production table binding or inventory snapshot.
Existing WTC installations only: pause, back up, configure, upgrade, verify, resume.
Building this file does not deploy it or change any Google Sheets data.
*/
"""
    code = header + "\n\n".join((SOURCE / name).read_text(encoding="utf-8") for name in PARTS)
    (DIST / "WTC_LoadSync.gs").write_text(code, encoding="utf-8")
    manifest = {
        "version": "1.7.0",
        "distribution": "public-configurable",
        "tests_passed": int(count_match.group(1)),
        "failures": 0,
        "deployment_performed_by_build": False,
        "compiled_sha256": hashlib.sha256(code.encode("utf-8")).hexdigest(),
        "source_order": PARTS,
        "source_sha256": {
            name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()
            for name in PARTS
        },
    }
    (DIST / "release-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    print(json.dumps({"artifact": "dist/WTC_LoadSync.gs", "tests": manifest["tests_passed"],
                      "sha256": manifest["compiled_sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
