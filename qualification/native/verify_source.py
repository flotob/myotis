#!/usr/bin/env python3
"""Pure source contract check. No compilation, addon load, network or mutation."""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = "02a183d86474a263cf8e85e5c2c2399672645535"
SUFFIX = b'\n#[cfg(feature = "qualification")]\n#[path = "qualification.rs"]\nmod qualification;\n'


def base(path):
    return subprocess.check_output(["git", "show", f"{BASE}:{path}"], cwd=ROOT)


def current(path):
    return (ROOT / path).read_bytes()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def verify():
    scheduler = "rust/myotis-node/src/scheduler.rs"
    admission = "rust/myotis-node/src/admission.rs"
    manifest = "rust/myotis-node/Cargo.toml"
    lock = "rust/Cargo.lock"
    assert current(scheduler) == base(scheduler) + SUFFIX, "scheduler changed beyond exact guarded suffix"
    assert current(admission) == base(admission), "admission changed"
    assert current(manifest) == base(manifest) + b"\n[features]\nqualification = []\n", "manifest/default/dependency change"
    assert current(lock) == base(lock), "lock changed"
    changed = subprocess.check_output(["git", "diff", "--name-only", BASE], cwd=ROOT, text=True).splitlines()
    allowed = {scheduler, manifest, "rust/myotis-node/src/qualification.rs"}
    assert all(path in allowed or path.startswith("qualification/native/") for path in changed), changed
    # Untracked additions are checked too; they are not permission to ignore
    # a generated artifact accidentally placed in the harness source worktree.
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, text=True).splitlines()
    assert all(path in allowed or path.startswith("qualification/native/") for path in untracked), untracked
    files = ["qualification/native/run.mjs", "qualification/native/child.mjs", "qualification/native/contract.json",
             "qualification/native/verify_source.py", "rust/myotis-node/src/qualification.rs"]
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=ROOT).returncode
    assert dirty in (0, 1)
    return {"base": BASE, "head": head, "dirtyTracked": bool(dirty), "untracked": untracked,
            "files": {path: digest(current(path)) for path in files},
            "result": "PASS", "schedulerOriginalSha256": digest(base(scheduler)),
            "admissionSha256": digest(current(admission)), "lockSha256": digest(current(lock)),
            "feature": "qualification", "defaultEnabled": False,
            "runtimeEvidence": False}


if __name__ == "__main__":
    print(json.dumps(verify(), sort_keys=True))
