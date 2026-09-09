# Linux A/B qualification checkpoint: campaign bb963e00

**Eight cases passed once each, sequentially, on disposable Linux.** The
coordinator independently verified all 160 exported payload hashes, all eight
raw results, and the original owner/native exit records. No deadline, signal,
containment intervention, retry, build or acquisition occurred during this
runtime campaign. This is supporting test-branch evidence for PR420, not a
release qualification or a separate product change.

## Tested identities

Production source was `02a183d86474a263cf8e85e5c2c2399672645535`. The default
build and opt-in scheduler fixture used harness commit
`c8cc1554506ffedda862195be4434000bc21bf26` (tree
`7ccc7b6d4aee5d4b850d2996f441898c51d40698`). Its source-only review found no
blocking issue. Production scheduler/admission bodies are byte-identical to
`02a`; test exports require the non-default `qualification` feature. The fixture
is explicitly a derivative, not the unmodified production addon.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| P: original `02a` debug addon | 280699328 | `b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792` |
| D: ordinary default build of `c8cc` | 280732048 | `d17ec962415e7b50e0a716916ddbd7fbd76453d7cec2739af98c98f43acd750a` |
| F: `c8cc` with qualification feature | 281268880 | `da405856fe69f6aad7ca7c6b0f078195db89f9af1bcd2bf57b95083e0c7e7d8f` |
| Node 24.15.0 runtime | 122889056 | `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c` |

Loaded ABI was 25; Node reported libuv 1.51.0, modules 137 and N-API 10 on
Linux x64, kernel 6.8.0-90-generic. Artifact hashes matched before and after;
the reviewed source stayed clean. Cargo.lock SHA256 remained
`1f0c580d933559bc5f66e60613d53053fe1528c0b1e2dc2b0981295419d25961`.
Existing cache acquisition provenance is recorded in the [build notes](README.md).

## Observed results

| Case | Artifact | Passing evidence |
| --- | --- | --- |
| `a-idle-owner-exit`, production | P | ABI25; foreign Worker read denied and stop preserves owner; owner stop and natural process exit. |
| `a-idle-owner-exit`, default-build | D | Same ownership checks; qualification exports absent from ordinary build. |
| `b-dns-file-responsive` | F | DNS plus file read completed together in **7.996468 ms** with `UV_THREADPOOL_SIZE=1`; raw native snapshot still had entries=1, exits=0, active, unreleased, on `myotis-node-0`. Later released settlement occurred once. |
| `b-queued-cancel` | F | Target stop took **0.081180 ms** while two unrelated native gates stayed active. Both target requests settled cancelled without entry; unrelated gates settled later. |
| `b-handle-capacity` | F | Fifth same-handle call returned busy; before/after counters stayed pending=requests=4, active=1, queued=3, nextId=5. |
| `b-active-stop-drain` | F | Stop took **5.029557 ms**, with native exit asserted before return and settlement after return. Created-handle pause cancelled its gate in **4.941588 ms** and correctly returned false. |
| `b-tsfn-natural-exit` | F | Entered finite gate with no JS timer/IPC keepalive; native duration ≥1 s and exit were asserted; settlement preceded natural process exit. |
| `b-worker-terminate-reuse` | F | Two explicit Worker terminations took **24.851630 / 24.136715 ms**. Both raw snapshots showed one entered/exited cancelled gate; worker slots returned 2→0 and were reused by the next environment. |

The DNS result was localhost `127.0.0.1`; file contents matched. Individual DNS
and file durations were not recorded. Some native terminal counts are passing
harness assertions rather than separately emitted raw snapshots; the retained
settlement events and final accounting are complementary evidence.

All six B cases emitted pending=requests=active=queued=0, unpoisoned and not
closing. Dedicated live workers remained 2 before natural environment exit in
cases 3–7; the explicit Worker-cleanup case observed 0 after each termination.
Worker exit 1 was the deliberate `Worker.terminate()` stimulus; every enclosing
Node parent/child exited naturally with code 0, no signal and empty stderr.
Parent `statusJson(foreignHandle)=={}` establishes environment scoping, not
engine-stop completion.

## Containment and limits

The external owner used private namespaces, UID/GID1001, no capabilities, a
read-only root and loopback-only networking with localhost hosts/files-first
resolution. Node had a 15 s envelope and the owner a 30 s outer bound. Original
root/native terminal records showed status 0; signal authority retired before
the sole reap with status 0. No intervention was needed. Outer containment was
not counted as cooperative native completion. No extra AppArmor-enforcement or
general descendant-teardown guarantee follows from these records.

Handles were **Created, never started**: creation initialized the engine runtime
and owned data directory, but no sync reader/network was started. The gates
observed the actual scheduler request-table cancellation flag, not a
Submission-to-Operation bridge. These results qualify the tested scheduler,
admission, TSFN, flag cancellation and environment cleanup under finite gate
work. They do **not** qualify reader/EVM/network cancellation (layer C), live
blockchain/provider behavior, the 90 s operation budget, indivisible-work stop
bounds, stress/fatal paths, release builds, or Freedom integration. No addon or
fixture was executed on the primary Mac for this campaign or documentation.

## Reproduction and retained evidence

Use the **tested `c8cc1554` checkout**, its [source verifier](verify_source.py),
[runner](run.mjs), [machine-readable contract](contract.json) and
[offline build/execution instructions](README.md). This later documentation
commit does not change the tested artifact identity: do not regenerate a proof
at the documentation HEAD and pair it with a fixture bound to `c8cc1554`.

The actual DNS case was launched by the external owner as:

```sh
/usr/bin/python3 -B /tmp/myotis-native-short-0SZ7dPsA/root_launcher.py \
  --run b-dns-file-responsive req-ad3609fefef044a4b0c81ea5caaf48fd
```

This records the historical command, not permission to replay its consumed
one-use execution ID. A rerun requires a fresh owned binding/ID and namespace
watchdog. Exact commands, environment, per-case activation diffs and owner
outcomes are retained in `campaign-bb963e00/run-summary.json` and `01..08/`.

The compact evidence archive is `native-campaign-bb963e00-compact.tar.gz`,
206750 bytes, SHA256
`5815661501e2b2a670134f738fa806f7b6340668c231cf091044f8d6ba3b62e8`.
Its `MEMBERS.json` has SHA256
`ed0fc1316ceb6b6d717c12bca7f73c58b4401db9e7f292665eb6e2e858a3c8d7`;
the archive contains that manifest plus 160 verified payloads. The coordinator
retains the extraction and `ROOT-VERIFICATION.json` at
`/private/tmp/linux-native-runtime-review-bb963e00`, and the complete reply at
`/private/tmp/linux-runtime-reply.txt`. Original private records remain under
`/tmp/myotis-native-short-0SZ7dPsA` on the disposable host. No evidence binaries,
private data, or runtime files are added to this repository.
