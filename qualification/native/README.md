# Running the bounded native qualification

Read [PLAN.md](PLAN.md) for the evidence contract and exclusions. This directory
adds no JavaScript package dependencies. The production scheduler's only change
is the cfg-gated child module at the end of `scheduler.rs`; its function bodies
and `admission.rs` remain identical to PR420 `02a183d8`.

[Recorded Linux A/B results](RESULTS-linux-bb963e00.md) cover the reviewed
`c8cc1554` harness and exact listed artifacts; real-reader layer C remains
unqualified.

Do not run either JS file on the primary Mac. The parent refuses non-Linux hosts
and requires an executor manifest plus `MYOTIS_QUALIFICATION_DISPOSABLE=1`.
These checks are explicit operator interlocks, not proof that a caller-created
manifest is truthful. The coordinator's disposable Linux executor must create
and retain actual watchdog/namespace evidence before invoking the runner.

## Source review and static checks

From the isolated harness worktree:

```sh
python3 qualification/native/verify_source.py
git diff --check
node --check qualification/native/run.mjs
node --check qualification/native/child.mjs
```

The Python command only reads source and Git objects and prints JSON; it neither
builds nor loads an addon. Node `--check` parses without executing these files.
For qualification, run the verifier on the reviewed clean commit and redirect
its output outside the source worktree. The runner requires a clean source proof
and matches its own and the child script's hashes against that proof.

## Offline build instructions for the remote author

The remote executor supplies existing absolute `DIRECT_CARGO` and `DIRECT_RUSTC`
paths. Do not invoke a rustup shim, fetch, install, retry online, or change a lock.
Inventory compiler ownership before reusing any target directory. Use an owned
target with no concurrent compiler. `EVIDENCE` is a new owned directory outside
the source checkout, and `OWNED_TARGET` is an existing approved target or a new
owned target; never clean/delete either. Capture tool versions and commands.

```sh
python3 qualification/native/verify_source.py > "$EVIDENCE/source-proof.json"
git rev-parse HEAD > "$EVIDENCE/source-head.txt"
sha256sum rust/Cargo.lock > "$EVIDENCE/lock-before.txt"
"$DIRECT_CARGO" --version > "$EVIDENCE/cargo-version.txt"
"$DIRECT_RUSTC" --version --verbose > "$EVIDENCE/rustc-version.txt"
```

Build the ordinary default configuration first, preserve its artifact, then
build the explicit fixture. The commands contain no test execution.

```sh
env RUSTC="$DIRECT_RUSTC" CARGO_TARGET_DIR="$OWNED_TARGET" CARGO_NET_OFFLINE=true \
  "$DIRECT_CARGO" build --offline --locked --manifest-path rust/Cargo.toml \
  -p myotis-node -j 2 > "$EVIDENCE/default-build.log" 2>&1
cp -n "$OWNED_TARGET/debug/libmyotis_node.so" "$EVIDENCE/default.node"
sha256sum "$EVIDENCE/default.node" > "$EVIDENCE/default.sha256"

env RUSTC="$DIRECT_RUSTC" CARGO_TARGET_DIR="$OWNED_TARGET" CARGO_NET_OFFLINE=true \
  MYOTIS_QUALIFICATION_SOURCE="$(git rev-parse HEAD)" \
  "$DIRECT_CARGO" build --offline --locked --manifest-path rust/Cargo.toml \
  -p myotis-node --features qualification -j 2 > "$EVIDENCE/fixture-build.log" 2>&1
cp -n "$OWNED_TARGET/debug/libmyotis_node.so" "$EVIDENCE/fixture.node"
sha256sum "$EVIDENCE/fixture.node" > "$EVIDENCE/fixture.sha256"
sha256sum rust/Cargo.lock > "$EVIDENCE/lock-after.txt"
python3 qualification/native/verify_source.py > "$EVIDENCE/source-proof-after.json"
```

Stop on any failure. Missing cached inputs are a blocker, not permission to
acquire them. Preserve the complete output and independently verify source/lock
unchanged and artifact size/hash/ELF architecture/dynamic links. Existing exact
dependency caches include five crates acquired earlier by a reviewer subagent
outside its authorization; that provenance must not become a team-wide
no-download claim. This task authorizes no further acquisition.

`MYOTIS_QUALIFICATION_SOURCE` is mandatory when the feature is enabled and is
reported by the fixture export. It is absent from the ordinary build. Neither
newly built artifact is the historical exact `02a` artifact; the default build
checks that the added feature remains opt-in. The unchanged original artifact
is separately pinned by `--kind production` to SHA256
`b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792`.

## Disposable execution contract

The executor provides one manifest per case, with these literal policy fields
and its actual hostname/evidence reference:

```json
{
  "schema": 1,
  "disposable": true,
  "hostname": "ACTUAL_DISPOSABLE_HOSTNAME",
  "case": "b-dns-file-responsive",
  "network": "deny-all-except-loopback",
  "watchdog": "linux-pidfd-namespace",
  "timeoutSeconds": 15,
  "outerTimeoutSeconds": 30,
  "evidence": "ABSOLUTE_OWNED_WATCHDOG_AND_NAMESPACE_RECORD"
}
```

The namespace must deny external networking and contain only owned processes.
The external 15 s Node deadline and 30 s outer containment must cover runner,
child, Workers and Tokio/native threads. The runner issues no POSIX signal,
even on failure. It records a 12 s
observation deadline while continuing to drain output. Missing supervisor final
evidence, an outer kill, a signal, stderr output, output truncation, a malformed
event or an unexpected exit all prevent a qualified pass. If external containment
kills the runner before `result.json` is written, preserve the partial evidence
and classify that as failure; absence of a result is not success.

Run each case under that already-established wrapper. For example, the wrapped
payload for one case is:

```sh
MYOTIS_QUALIFICATION_DISPOSABLE=1 "$EXISTING_NODE" qualification/native/run.mjs \
  --addon "$EVIDENCE/fixture.node" --sha256 "$FIXTURE_SHA256" \
  --kind fixture --case b-dns-file-responsive --output "$EVIDENCE/run-liveness" \
  --executor-manifest "$EVIDENCE/executor-liveness.json" \
  --source-proof "$EVIDENCE/source-proof.json"
```

Repeat as separate supervised invocations for `b-queued-cancel`, `b-handle-capacity`,
`b-active-stop-drain`, `b-tsfn-natural-exit`, and `b-worker-terminate-reuse`, each with its own manifest and
new output directory. Do not run them in parallel: the goal is a small finite
qualification, not contention or resource-exhaustion testing.

Run `a-idle-owner-exit` with `--kind default-build` against `default.node` to check
gate-export absence, then `--kind production` against the pinned historical
artifact. Both use their actual hashes and separate output/manifest files. These
real-export cases test ABI/Created ownership and natural idle exit only.

The child uses only built-ins and `process.dlopen`. The parent sets
`UV_THREADPOOL_SIZE=1` before spawn and omits NODE_OPTIONS and unrelated host
environment variables. A DNS callback error still establishes getaddrinfo pool
liveness; the probe does not require DNS success. No start/resume, transaction,
WS override, provider credential or engine network fixture is used in this layer.

## Results

Every output directory contains source/executor proofs, provenance, raw stdout
JSONL, stderr, and a result after natural child exit. Pair those with the external
supervisor's final record. Test-only source and artifact identity must remain in
the final report. A passing fixture establishes scheduler admission, request-
table flag observation, TSFN lifecycle and cleanup under finite cooperative gate
work. It does not establish submitted() TLS/Operation propagation, real reader,
EVM/network cancellation, the 90 s whole-operation budget, or hard-stop boundedness.

The `a416` real-reader layer remains a separate prerequisite-gated plan. Existing
network control and native stack-observation capability must be inventoried by
the coordinator on a disposable host. No protocol simulator or tool acquisition
is part of this harness.
