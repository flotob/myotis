# Native Node qualification contract

Status: implemented for manual source review; no runtime result is claimed.
Nothing in this document is a runtime result. Execution is restricted to an
explicitly designated disposable host. No addon load or blocked-work fixture may
run on the primary development Mac.

## Source and artifact identities

- PR420 source: `02a183d86474a263cf8e85e5c2c2399672645535`.
- Locked dependency input SHA256:
  `1f0c580d933559bc5f66e60613d53053fe1528c0b1e2dc2b0981295419d25961`.
- Existing Linux debug addon:
  `/tmp/myotis-offline-correction-TwLVLw/run/target/debug/libmyotis_node.so`,
  SHA256 `b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792`.
- Checkpoint-only derivative: `a416cb0ffe779cc85d6124883a809638f013163e`.
  Its existing Mac arm64 debug addon has SHA256
  `8f0cb38605b633491a182e8d1b7655d83e02a0c5a11a7c6aa11dd7d1d5654d77`.
  A Linux artifact for that source requires a separately authorized offline build.

The PR420 checkout's shared target directory was reused for the checkpoint build.
An artifact's path alone does not identify its source. Hash each input before
loading it on a disposable host. Existing compile/link and finite unit-test
results do not establish addon runtime behavior.

## Why separate evidence layers

The production ABI25 exports have no native hold/gate or per-request cancellation
export. Reads enter `scheduler::submit`, but without a running reader they can
return an unavailable result immediately. Exact PR420 checkpoints are stale at
the time of this plan; a fresh-data sync would park at `STALE_ANCHOR`. Neither a
pending Promise nor a JavaScript delay proves native worker occupancy. This plan
never calls `acceptStaleAnchor`, widens the WS bound, or edits a checkpoint.

1. **Unmodified PR420 addon.** ABI25, ordinary created-handle ownership, and idle
   process exit can be checked without network. These checks do not qualify
   active-reader scheduling, network/EVM cancellation, or Running-reader stop.
2. **Explicit scheduler fixture derivative.** Finite native gate jobs exercise
   the production scheduler through test-only exports. This establishes actual
   scheduler worker occupancy and exercises TSFN, admission and cancellation
   ownership. It is not an unmodified-addon result and does not establish reader,
   network, proof or EVM cancellation.
3. **Unmodified checkpoint-only derivative.** An independently hashed `a416`
   artifact can qualify real reads after readiness, using controlled delay on a
   disposable host. A stalled bootstrap or missing occupancy witness produces
   `NOT_EXERCISED`, not a pass. The checkpoint difference remains in every report.

## Proposed deterministic fixture

Keep all production scheduler and admission function bodies unchanged. Build a
separate, explicitly marked derivative with the empty, non-default
`qualification` Cargo feature. The only production scheduler edit is an appended
`#[cfg(feature = "qualification")]` child module. The child module can inspect
existing private state without adding hooks to the production worker loop.
The source and resulting artifact each receive their own hashes. No dependency,
lockfile, production budget, worker limit or admission limit changes are allowed.

The PR420 scheduler source SHA256 is
`7fb67c3715b5322260c7fabcf69315969ba5d7bd80e998b3dc362bfa68b5fa1b`;
the admission source SHA256 is
`e8a512fae5b7ff43b6955049b30e9ed3b66e29724114852bacb11ecac300db50`.
`verify_source.py` mechanically requires the original scheduler bytes followed
by exactly that module declaration, byte-identical admission/lock files, and an
exact empty feature addition to the package manifest. A separately built default
artifact must pass the runner's export-absence check; inspecting ELF symbols alone
does not establish the absence of registered N-API methods. Never label the
feature-enabled source or artifact as exact PR420.

Gate jobs use the real `submit` / `State::worker` / completion path. A gate reports
native entry, exit, thread name, and request ID through a synchronized snapshot.
It checks the actual scheduler request-table cancellation flag, not a substitute
JavaScript token. Under the scheduler mutex it requires an active handle and
selects the minimum outstanding ID for that handle (per-handle FIFO). It checks
that flag is not already cancelled at acquisition. `finish` removes the preceding
request and releases its active slot under the same mutex, so a queued sibling
cannot be selected while this job runs. The source uses this same Arc in the
Job's Submission, but the gate does not retrieve Submission through TLS. Neither
TLS retrieval nor Submission-to-Operation propagation is covered by this layer.
It has its own finite maximum hold even if the host never releases it. This
cooperative check is fixture code, not the reader's Operation implementation.
Per-job identity remains unambiguous when several jobs share one handle.
No fixture job may capture the JS environment or wait for a JS completion during
cancellation. Native status observation must not perform settlement or reenter
JavaScript while holding scheduler locks.

Use real created, not started, engine handles and real Node `stop`. `create`
allocates an owned data directory and lazily initializes the process-global
multi-thread Tokio runtime. It never calls SyncHandle::start. Created-handle stop
removes the handle; its Running-only reader/network shutdown body is skipped.
The executor must deny non-loopback networking and preserve its namespace/audit
evidence; a source statement alone is not a runtime network-attempt audit.
A `pause` call still reaches scheduler cancellation,
but the engine's Created-to-Paused transition is invalid and returns false; this
is only a cancellation-bridge check, never a Running-reader pause check.

## Cases and finite bounds

Each case runs in a separate owned child process with `UV_THREADPOOL_SIZE=1`.
The minimal regression is the first row. Small thresholds are qualification
targets for these finite fixtures, not new API guarantees for arbitrary work.

| Case | Required witness and assertions | Child safety limit |
| --- | --- | --- |
| Host libuv liveness | One native gate has entered on a `myotis-node-*` worker and remains active while `dns.lookup('localhost')` and asynchronous `fs.readFile` of a small owned file complete within 2 s. Only then release the gate; observe its native exit and Promise settlement. | 15 s; gate maximum 10 s |
| Queued target stop | Both native workers are occupied by different handles. A third handle's two queued jobs have entry count zero. Real `stop(third)` returns within 200 ms while both unrelated gates remain active. Both queued Promises settle cancelled once; entries stay zero. The other jobs settle later. | 15 s; gate maximum 10 s |
| Per-handle admission | One active plus three queued jobs on one handle; the fifth returns `native scheduler busy`. Pending/request/active/queued/next-ID counts are unchanged by refusal, with total pending 4, below global cap 32. Queued jobs never enter. TSFN non-ref on refusal follows the mechanically unchanged branch, not a runtime refcount introspection API. | 15 s; gate maximum 10 s |
| Active stop | After positive native entry, real `stop(handle)` signals its original flag. Native exit is observed before return, within the fixture's 5 ms poll plus 195 ms margin. Promises settle once after return, then pending is zero. Created-handle pause cancellation is also checked; false is its expected engine result. | 15 s; gate maximum 10 s |
| Keepalive and idle exit | Submit a 1 s finite native gate and leave no JS timer, IPC channel, Worker or other referenced host handle. Native elapsed time and completion must precede natural code-0 process exit with empty stderr. | 15 s; gate maximum 1 s |
| Environment cleanup | Terminate a worker_threads environment after native entry. Require termination within 1 s, actual exit 1, native cancelled exit and process-wide LIVE_WORKERS returning from 2 to 0. Repeat once in a fresh Worker to prove slot reuse. Parent observation must not initialize its own scheduler. | 15 s; gate maximum 10 s |

The 90 s case is deferred. These six cases make no deadline qualification claim.

Native entry and exit observations must bracket the liveness probe, not merely
appear somewhere in a run. The finite gate maximum expiring unexpectedly is a
fixture failure, not cooperative cancellation. Keepalive evidence requires an
unreferenced parent-side observation path in the child; do not accidentally keep
the child alive through the harness itself.

The environment-termination case deliberately invokes cleanup. It is distinct
from ordinary natural exit and synchronous stop. It cannot establish hard-stop
boundedness for indivisible precompiles, proof verification, or filesystem calls.
No process-fatal or Node-API failure injection is included.

## Real-reader qualification prerequisites

Use only real ABI25 read exports such as `requestAccountJson` or `ethCallJson`.
Never send transactions. Before introducing delay, require current own-handle
status showing a running, unpaused reader, `SYNCED`, and SNAP availability, plus
a successful verified read. Preserve that result and status as readiness
evidence. Bound bootstrap/warmup separately and stop when its deadline expires.

Use an existing disposable-host network namespace or equivalent owned isolation
to introduce a finite delay to the child's P2P traffic after readiness. No host-
wide network changes, shared firewall mutations, or broad protocol simulator.
Inventory installed traffic-control and native stack-observation tools before
choosing commands; acquire nothing. Existing CL peer/discovery environment
overrides alone do not provide full EL egress isolation. In particular, a comment
mentioning `MYOTIS_EL_BOOT_ENODES` is not proof that a Rust override exists.

A request must still be pending during the host-liveness window and a native
stack observation must place a Myotis scheduler worker inside the real reader's
C-ABI / runtime blocking path. For an EVM-specific claim, additionally require
evidence of the actual EVM/Oracle path. Missing evidence is `NOT_EXERCISED`.
Delayed traffic, readiness, or a pending JS Promise alone is insufficient.

Run cooperative stop, pause, deadline, and environment termination as separate
cases. Inspect real native results, lifecycle returns and normal child exits.
Preserve both permitted cancellation wire shapes (`error` or
`status: unavailable` with a cancellation reason). Reader shutdown may still
wait for indivisible native work. Do not infer a hard wall-clock stop guarantee
from a passing controlled finite request.

## Safety, records and interpretation

The parent records exact source and artifact SHA256, harness/overlay hashes,
Node/libuv/OS/architecture/tool versions, command/environment, monotonic event
timestamps, per-job native entry/exit counts, promise outcomes, raw child output,
and exit code/signal. Identify each evidence layer in every result. Missing or
malformed events fail validation; absence of evidence never means success.

Use only task-owned temporary data and processes on a designated disposable
host, no credentials, no transactions, no public writes and no resource-exhaustion
fixture. The JS parent never uses ChildProcess.kill or PID signals. A separately
owned Linux pidfd/namespace watchdog must enclose the runner and all descendants,
including engine runtime threads. Its 15 s Node deadline and 30 s outer
containment are external to the addon.
The runner records failure at 12 s but keeps draining output without signaling.
A watchdog timeout,
forced signal, unexpected exit or unbounded cleanup is a failure with containment
recorded separately. An outer kill is never proof of cooperative native shutdown.
Keep logs and artifacts; do not delete existing files. No network acquisition,
online Cargo retry, toolchain install or dependency change is authorized.

On the primary Mac, only source inspection, finite pure source checks and
explicitly permitted offline compile-only checks are allowed. No addon is loaded.
Runtime commands are reviewed and executed through the coordinator on designated
disposable hosts. This runner supports Linux only; a Mac supervisor is not
implicitly provided or authorized by its Linux command examples.
