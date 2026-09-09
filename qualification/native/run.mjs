// Linux disposable-host parent. No addon is loaded in this process.
// There are deliberately NO PID signals/ChildProcess.kill calls. An external
// owned pidfd/namespace watchdog must enclose this runner and all descendants.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname, platform, arch, release } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(key?.startsWith('--') && value && !value.startsWith('--'));
  assert.ok(!Object.hasOwn(options, key), `duplicate option ${key}`);
  options[key] = value;
}
const keys = ['--addon', '--sha256', '--kind', '--case', '--output', '--executor-manifest', '--source-proof'];
assert.deepEqual(Object.keys(options).sort(), keys.sort());
assert.equal(platform(), 'linux', 'this reviewed runner supports disposable Linux only');
assert.equal(process.env.MYOTIS_QUALIFICATION_DISPOSABLE, '1');
assert.match(options['--sha256'], /^[a-f0-9]{64}$/);
const kind = options['--kind'];
const caseName = options['--case'];
assert.ok(['fixture', 'production', 'default-build'].includes(kind));
const fixtureCases = ['b-dns-file-responsive', 'b-queued-cancel', 'b-handle-capacity', 'b-active-stop-drain', 'b-tsfn-natural-exit', 'b-worker-terminate-reuse'];
assert.ok((kind === 'fixture' ? fixtureCases : ['a-idle-owner-exit']).includes(caseName));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(options['--source-proof']);
assert.ok(sourceBytes.length <= 65_536);
const sourceProof = JSON.parse(sourceBytes);
assert.equal(sourceProof.result, 'PASS');
assert.equal(sourceProof.base, '02a183d86474a263cf8e85e5c2c2399672645535');
assert.equal(sourceProof.dirtyTracked, false);
assert.deepEqual(sourceProof.untracked, []);
assert.match(sourceProof.head, /^[a-f0-9]{40}$/);
for (const name of ['run.mjs', 'child.mjs']) {
  const path = `qualification/native/${name}`;
  assert.equal(sha(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)))), sourceProof.files[path]);
}
const addon = resolve(options['--addon']);
assert.equal(sha(readFileSync(addon)), options['--sha256']);
if (kind === 'production') {
  assert.equal(options['--sha256'], 'b20a93ef75af038813609ecb854f97441b62345a7ceb8dc1625e95de7f9a9792',
    'production layer is pinned to the existing exact 02a Linux artifact');
}
const manifestBytes = readFileSync(options['--executor-manifest']);
assert.ok(manifestBytes.length <= 65_536);
const executor = JSON.parse(manifestBytes);
assert.equal(executor.schema, 1);
assert.equal(executor.disposable, true);
assert.equal(executor.hostname, hostname());
assert.equal(executor.case, caseName);
assert.equal(executor.network, 'deny-all-except-loopback');
assert.equal(executor.watchdog, 'linux-pidfd-namespace');
assert.equal(executor.timeoutSeconds, 15);
assert.equal(executor.outerTimeoutSeconds, 30);
assert.equal(typeof executor.evidence, 'string');
assert.ok(executor.evidence.length > 0);

const output = resolve(options['--output']);
mkdirSync(output); // New owned output only; never overwrite/delete prior evidence.
const save = (name, data) => writeFileSync(join(output, name), data, { flag: 'wx' });
const childScript = fileURLToPath(new URL('./child.mjs', import.meta.url));
const config = { disposable: true, addon, sha256: options['--sha256'], source: sourceProof.head, kind, case: caseName, dataDir: join(output, 'data') };
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: 'C',
  UV_THREADPOOL_SIZE: '1', // Before the child's first use of libuv.
  MYOTIS_QUALIFICATION_DISPOSABLE: '1',
};
// NODE_OPTIONS and all unrelated host/provider environment variables are omitted.
const command = [process.execPath, childScript, JSON.stringify(config)];
save('executor-manifest.json', manifestBytes);
save('source-proof.json', sourceBytes);
save('provenance.json', `${JSON.stringify({
  baseSource: '02a183d86474a263cf8e85e5c2c2399672645535',
  source: sourceProof.head,
  layer: kind === 'fixture' ? 'test-only scheduler derivative' : kind === 'production' ? 'unmodified addon idle/ownership only' : 'default build of harness source, gate exports absent',
  artifact: addon, artifactSha256: config.sha256,
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  childSha256: sha(readFileSync(childScript)),
  nodeSha256: sha(readFileSync(process.execPath)),
  executorManifestSha256: sha(manifestBytes),
  executorEvidence: executor.evidence,
  platform: platform(), arch: arch(), release: release(), hostname: hostname(),
  versions: process.versions, command, environment: env,
  claims: kind === 'fixture' ? ['scheduler', 'TSFN', 'request-table cancellation flag', 'environment cleanup'] : ['ABI25', 'created-handle ownership', 'natural idle exit'],
  excluded: ['TLS-to-Operation propagation', 'reader cancellation', 'network cancellation', 'EVM cancellation', '90-second budget', 'hard-stop guarantee'],
}, null, 2)}\n`);

const started = performance.now();
const child = spawn(command[0], command.slice(1), { env, cwd: output, stdio: ['ignore', 'pipe', 'pipe'] });
const chunks = { stdout: [], stderr: [] };
const sizes = { stdout: 0, stderr: 0 };
let overflow = false;
let deadline = false;
let spawnError;
for (const name of ['stdout', 'stderr']) {
  child[name].on('data', bytes => {
    sizes[name] += bytes.length;
    if (sizes[name] <= 65_536) chunks[name].push(bytes);
    else overflow = true; // Continue draining, never accumulate unbounded output.
  });
}
child.once('error', error => { spawnError = String(error); });
const timer = setTimeout(() => {
  deadline = true;
  save('deadline.json', `${JSON.stringify({ status: 'FAIL', elapsedMs: performance.now() - started,
    reason: 'runner observation deadline; awaiting external owned containment, no signal sent' })}\n`);
}, 12_000);
const outcome = await new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })));
clearTimeout(timer);
const stdout = Buffer.concat(chunks.stdout).toString('utf8');
const stderr = Buffer.concat(chunks.stderr).toString('utf8');
save('stdout.jsonl', stdout);
save('stderr.txt', stderr);
let events = [];
let parseError;
try {
  events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
} catch (error) { parseError = String(error); }
const passed = events.filter(event => event.type === 'case-pass');
const failed = events.filter(event => event.type === 'case-fail');
const loaded = events.filter(event => event.type === 'loaded');
const clean = kind !== 'fixture' || events.some(event => event.type === 'accounting-zero' && event.pending === 0);
const ok = outcome.code === 0 && outcome.signal === null && !deadline && !overflow && !spawnError &&
  !parseError && stderr === '' && failed.length === 0 && passed.length === 1 &&
  passed[0].case === caseName && passed[0].kind === kind && loaded.length === 1 && clean;
const result = { status: ok ? 'PASS' : 'FAIL', case: caseName, kind, ...outcome,
  elapsedMs: performance.now() - started, deadline, overflow, spawnError, parseError,
  stderrBytes: sizes.stderr, eventCount: events.length,
  containment: outcome.signal ? 'external signal observed; never cooperative success' : 'no signal observed by runner',
  externalWatchdogEvidenceRequired: true,
};
save('result.json', `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...result, output })}\n`);
process.exitCode = ok ? 0 : 1;
