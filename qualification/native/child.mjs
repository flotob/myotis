// Disposable-host runtime ONLY. Imports are all Node built-ins.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const config = isMainThread ? JSON.parse(process.argv[2]) : workerData;
assert.equal(config.disposable, true);
assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
assert.equal(process.env.MYOTIS_QUALIFICATION_DISPOSABLE, '1');
const bytes = readFileSync(config.addon);
assert.equal(createHash('sha256').update(bytes).digest('hex'), config.sha256);
const loaded = { exports: {} };
process.dlopen(loaded, config.addon);
const addon = loaded.exports;
const fixtureExports = ['qualificationInfo', 'qualificationGate', 'qualificationSnapshot', 'qualificationRelease'];
assert.equal(addon.init(), 25);
for (const name of fixtureExports) {
  assert.equal(typeof addon[name], config.kind === 'fixture' ? 'function' : 'undefined', name);
}

const event = (type, value = {}) => writeSync(1, `${JSON.stringify({ type, atMs: performance.now(), ...value })}\n`);
const info = () => JSON.parse(addon.qualificationInfo());
const snapshot = id => JSON.parse(addon.qualificationSnapshot(id));
const handles = [];
const calls = [];
let handleSequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function create() {
  const dataDir = join(config.dataDir, `handle-${++handleSequence}`);
  const h = addon.create('mainnet', dataDir);
  assert.ok(Number.isSafeInteger(h) && h > 0, `create failed: ${h}`);
  handles.push(h);
  event('created', { handle: h, dataDir, status: JSON.parse(addon.statusJson(h)) });
  return h;
}

function gate(handle, id, finite = false, holdMs = 10_000) {
  const call = { id, handle, count: 0, settled: false, result: undefined };
  call.promise = addon.qualificationGate(handle, id, holdMs, finite).then(raw => {
    call.count++;
    call.settled = true;
    call.result = JSON.parse(raw);
    event('settlement', { id, count: call.count, result: call.result });
    return call.result;
  });
  calls.push(call);
  return call;
}

async function entered(call) {
  const end = performance.now() + 1_000;
  while (performance.now() < end) {
    const s = snapshot(call.id);
    if (s.entries === 1) {
      assert.equal(s.exits, 0);
      assert.match(s.thread, /^myotis-node-[01]$/);
      assert.ok(s.requestId > 0);
      event('native-entered', s);
      return s;
    }
    assert.equal(call.settled, false, 'gate completed before positive native entry');
    await delay(5);
  }
  throw new Error(`native entry not witnessed: ${call.id}`);
}

function held(call) {
  const s = snapshot(call.id);
  assert.equal(s.entries, 1);
  assert.equal(s.exits, 0);
  assert.equal(s.released, false);
  assert.equal(s.terminal, 'active');
  assert.equal(call.settled, false);
  return s;
}

async function finishReleased(call) {
  addon.qualificationRelease(call.id);
  assert.deepEqual(await call.promise, { qualification: 'released' });
  assert.equal(snapshot(call.id).exits, 1);
}

function stop(handle, boundMs = 200) {
  event('stop-enter', { handle });
  const before = performance.now();
  addon.stop(handle);
  const durationMs = performance.now() - before;
  event('stop-return', { handle, durationMs });
  assert.ok(durationMs < boundMs, `stop took ${durationMs} ms (bound ${boundMs})`);
  assert.deepEqual(JSON.parse(addon.statusJson(handle)), {});
}

async function settledCancelled(call, enteredExpected) {
  assert.deepEqual(await call.promise, { error: 'request cancelled' });
  assert.equal(call.count, 1);
  const s = snapshot(call.id);
  assert.equal(s.entries, enteredExpected);
  assert.equal(s.exits, enteredExpected);
  if (enteredExpected) assert.equal(s.terminal, 'cancelled');
}

async function assertClean() {
  await Promise.all(calls.map(call => call.promise));
  await new Promise(resolve => setImmediate(resolve));
  for (const call of calls) assert.equal(call.count, 1, call.id);
  const state = info();
  assert.equal(state.pending, 0);
  assert.equal(state.requests, 0);
  assert.equal(state.active, 0);
  assert.equal(state.queued, 0);
  assert.equal(state.poisoned, false);
  assert.equal(state.closing, false);
  event('accounting-zero', state);
}

async function liveness() {
  const h = await create();
  const c = gate(h, 'liveness');
  await entered(c);
  const path = join(config.dataDir, 'probe.txt');
  // Owned small file is prepared before the timed liveness window.
  await writeFile(path, 'native-qualification\n');
  held(c);
  const before = performance.now();
  const results = await Promise.all([
    new Promise(resolve => lookup('localhost', (error, address, family) => resolve({
      error: error?.code ?? null, address: address ?? null, family: family ?? null,
    }))),
    readFile(path, 'utf8'),
  ]);
  const durationMs = performance.now() - before;
  assert.ok(durationMs < 2_000, `libuv probes took ${durationMs} ms`);
  assert.equal(results[1], 'native-qualification\n');
  const native = held(c);
  // Any getaddrinfo callback, including an EAI failure, proves pool liveness.
  event('libuv-live', { durationMs, dns: results[0], native });
  await finishReleased(c);
  stop(h);
}

async function queuedStop() {
  const h1 = await create(); const h2 = await create(); const h3 = await create();
  const a = gate(h1, 'held_a'); const b = gate(h2, 'held_b');
  await entered(a); await entered(b);
  const q1 = gate(h3, 'queued_a'); const q2 = gate(h3, 'queued_b');
  assert.equal(info().active, 2);
  assert.equal(info().queued, 2);
  assert.equal(snapshot(q1.id).entries, 0);
  assert.equal(snapshot(q2.id).entries, 0);
  stop(h3);
  assert.equal(q1.settled, false); assert.equal(q2.settled, false);
  held(a); held(b);
  await settledCancelled(q1, 0); await settledCancelled(q2, 0);
  held(a); held(b);
  assert.equal(info().pending, 2);
  await finishReleased(a); await finishReleased(b);
  stop(h1); stop(h2);
}

async function admission() {
  const h = await create();
  const a = gate(h, 'admit_active');
  await entered(a);
  const queued = [1, 2, 3].map(n => gate(h, `admit_queued_${n}`));
  const before = info();
  assert.equal(before.pending, 4);
  assert.equal(before.requests, 4);
  assert.equal(before.active, 1);
  assert.equal(before.queued, 3);
  assert.ok(before.pending < 32, 'must exercise per-handle limit, not total limit');
  const refused = gate(h, 'admit_refused');
  assert.deepEqual(await refused.promise, { error: 'native scheduler busy' });
  const after = info();
  for (const key of ['pending', 'requests', 'active', 'queued', 'nextId']) {
    assert.equal(after[key], before[key], `refusal changed ${key}`);
  }
  event('per-handle-refusal', { before, after });
  for (const c of [...queued, refused]) assert.equal(snapshot(c.id).entries, 0);
  held(a);
  stop(h);
  await settledCancelled(a, 1);
  for (const c of queued) await settledCancelled(c, 0);
}

async function activeStop() {
  const h = await create();
  const c = gate(h, 'active_stop');
  await entered(c);
  stop(h); // 5 ms fixture poll + 195 ms qualification margin.
  assert.equal(c.settled, false, 'TSFN settlement reentered synchronous stop');
  const s = snapshot(c.id);
  assert.equal(s.exits, 1, 'stop returned before actual native gate exit');
  assert.equal(s.terminal, 'cancelled');
  await settledCancelled(c, 1);
  // Also exercise the pause wrapper's cancellation path without claiming a
  // Created handle became Paused or that any reader/network was started.
  const h2 = await create();
  const c2 = gate(h2, 'created_pause');
  await entered(c2);
  const before = performance.now();
  assert.equal(addon.pause(h2), false);
  const durationMs = performance.now() - before;
  assert.ok(durationMs < 200);
  assert.equal(c2.settled, false);
  assert.equal(snapshot(c2.id).exits, 1);
  event('created-pause-return', { durationMs, result: false });
  await settledCancelled(c2, 1);
  stop(h2);
}

async function keepalive() {
  const h = await create();
  const c = gate(h, 'keepalive', true, 1_000);
  await entered(c);
  // All entry-poll timers have fired and been consumed. No timer or IPC is
  // installed below. A Promise and top-level await do not themselves keep Node
  // alive. The only ongoing scheduled work is the real native gate + TSFN ref.
  event('host-idle-no-timers', { native: held(c) });
  assert.deepEqual(await c.promise, { qualification: 'finite' });
  const s = snapshot(c.id);
  assert.equal(s.exits, 1);
  assert.ok(s.exitedUs - s.enteredUs >= 1_000_000);
  // Leave the Created handle for the real env cleanup hook on natural exit.
}

async function workerBody() {
  const h = await create();
  const c = gate(h, config.gateId);
  await entered(c);
  parentPort.postMessage({ entered: true, native: held(c), handle: h });
  // Parent terminates this environment while the native gate is active.
  await c.promise;
  throw new Error('worker gate completed without environment termination');
}

async function workerCleanup() {
  assert.equal(info().liveWorkers, 0, 'observation initialized parent state');
  for (let generation = 0; generation < 2; generation++) {
    const id = `worker_${generation}`;
    const w = new Worker(new URL(import.meta.url), {
      workerData: { ...config, dataDir: join(config.dataDir, id), gateId: id },
    });
    let actualExit;
    const exit = new Promise((resolve, reject) => {
      w.once('error', reject);
      w.once('exit', code => { actualExit = code; resolve(code); });
    });
    // Attach immediately so errors cannot become an unhandled rejection while
    // waiting for the entry message; Promise.race still carries the failure.
    const entry = new Promise(resolve => w.once('message', resolve));
    const message = await Promise.race([
      entry,
      exit.then(code => { throw new Error(`worker exited before entry: ${code}`); }),
    ]);
    assert.equal(message.entered, true);
    assert.equal(info().liveWorkers, 2);
    assert.equal(snapshot(id).exits, 0);
    const before = performance.now();
    const terminated = await w.terminate(); // Explicit cleanup stimulus ONLY.
    await exit;
    const durationMs = performance.now() - before;
    assert.ok(durationMs < 1_000, `environment termination took ${durationMs} ms`);
    assert.equal(terminated, 1);
    assert.equal(actualExit, 1);
    const native = snapshot(id);
    assert.equal(native.entries, 1);
    assert.equal(native.exits, 1);
    assert.equal(native.terminal, 'cancelled');
    assert.equal(info().liveWorkers, 0, 'dedicated worker slots leaked');
    assert.deepEqual(JSON.parse(addon.statusJson(message.handle)), {});
    event('environment-terminated', { generation, durationMs, actualExit, native, state: info() });
  }
}

async function productionIdleOwnership() {
  const h = await create();
  assert.notDeepEqual(JSON.parse(addon.statusJson(h)), {});
  const w = new Worker(new URL(import.meta.url), {
    workerData: { ...config, foreignHandle: h },
  });
  const message = new Promise(resolve => w.once('message', resolve));
  const exited = new Promise((resolve, reject) => {
    w.once('error', reject);
    w.once('exit', resolve);
  });
  const result = await Promise.race([
    message,
    exited.then(code => { throw new Error(`ownership worker exited before reply: ${code}`); }),
  ]);
  assert.deepEqual(result, { status: '{}', error: 'handle does not belong to this environment' });
  assert.equal(await exited, 0);
  assert.notDeepEqual(JSON.parse(addon.statusJson(h)), {}, 'foreign stop removed owner handle');
  stop(h);
  addon.stop(h); // Real unknown-handle no-op.
}

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  if (!isMainThread) {
    if (config.kind === 'fixture') return workerBody();
    const status = addon.statusJson(config.foreignHandle);
    const result = JSON.parse(await addon.requestAccountJson(config.foreignHandle, '0x0000000000000000000000000000000000000000'));
    addon.stop(config.foreignHandle);
    parentPort.postMessage({ status, error: result.error });
    parentPort.close();
    return;
  }
  event('loaded', { kind: config.kind, abi: 25, sha256: config.sha256, exports: Object.keys(addon).sort(), versions: process.versions });
  if (config.kind !== 'fixture') {
    assert.equal(config.case, 'a-idle-owner-exit');
    await productionIdleOwnership();
  } else {
    const initial = info();
    assert.equal(initial.base, '02a183d86474a263cf8e85e5c2c2399672645535');
    assert.equal(initial.fixtureSource, config.source);
    assert.equal(initial.operationBridge, false);
    assert.equal(initial.liveWorkers, 0);
    const cases = {
      'b-dns-file-responsive': liveness,
      'b-queued-cancel': queuedStop,
      'b-handle-capacity': admission,
      'b-active-stop-drain': activeStop,
      'b-tsfn-natural-exit': keepalive,
      'b-worker-terminate-reuse': workerCleanup,
    };
    assert.ok(Object.hasOwn(cases, config.case));
    await cases[config.case]();
    await assertClean();
  }
  event('case-pass', { case: config.case, kind: config.kind });
}

main().catch(error => {
  event('case-fail', { message: error.message, stack: error.stack });
  // No forced exit, no process signal, no stop in an error path which could
  // conceal a cleanup defect. The external owned watchdog contains failures.
  process.exitCode = 1;
});
