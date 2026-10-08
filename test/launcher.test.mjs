import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { probeRadar, radarInstanceId, STARTUP_TIMEOUT_MS, waitForRadar } from '../scripts/launcher-health.mjs';
import { superviseRadar, watchdogDecision } from '../scripts/supervise.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), port = 3791;
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const healthy = { service: 'meme-radar', execution: false, instanceId: radarInstanceId(root), version };
test('legacy Mac start shortcut uses the detached launcher except for explicit one-shot scans', () => {
  const script = readFileSync(new URL('../start-radar.command', import.meta.url), 'utf8');
  assert.match(script, /if .*--once/);
  assert.match(script, /fi\nexec "\$node_bin" "\$radar_dir\/scripts\/open\.mjs" "\$@"/);
});
function response(value = healthy, { status = 200, interrupted = false } = {}) {
  return (_url, _options, callback) => {
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => {
      const stream = new EventEmitter(); stream.statusCode = status; callback(stream);
      if (interrupted) { stream.emit('aborted'); return; }
      stream.emit('data', typeof value === 'string' ? value : JSON.stringify(value));
      stream.emit('end');
    });
    return request;
  };
}

test('startup waits beyond the old 15-second window and retries interrupted health until 90 seconds', async () => {
  assert.equal(STARTUP_TIMEOUT_MS, 90_000);
  let time = 0, attempts = 0;
  const snapshot = await waitForRadar({ root, port, now: () => time, pause: async ms => { time += ms; },
    probe: async () => { attempts++; return time >= 20_000 ? { status: 'ready', snapshot: healthy }
      : { status: attempts % 2 ? 'starting' : 'absent' }; } });
  assert.equal(snapshot, healthy); assert.ok(time >= 20_000 && time < STARTUP_TIMEOUT_MS);
  time = 0;
  await assert.rejects(waitForRadar({ root, port, now: () => time, pause: async ms => { time += ms; },
    probe: async () => ({ status: 'starting' }) }), { code: 'RADAR_START_TIMEOUT' });
  assert.equal(time, STARTUP_TIMEOUT_MS);
});

test('health retries refused/reset/timed-out/incomplete connections but rejects another instance or service', async () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
    const get = () => {
      const request = new EventEmitter(); request.destroy = () => {};
      queueMicrotask(() => request.emit('error', Object.assign(new Error('synthetic'), { code })));
      return request;
    };
    assert.equal((await probeRadar({ root, port, get })).status, code === 'ECONNREFUSED' ? 'absent' : 'starting');
  }
  assert.equal((await probeRadar({ root, port, get: response(null, { interrupted: true }) })).status, 'starting');
  assert.equal((await probeRadar({ root, port, get: response() })).status, 'ready');
  for (const value of [{ ...healthy, instanceId: 'another-install' }, { ...healthy, execution: true },
    { ...healthy, service: 'unrelated' }, 'not-json', 'x'.repeat(32001)]) {
    await assert.rejects(probeRadar({ root, port, get: response(value) }), { code: 'RADAR_PORT_CONFLICT' });
  }
  await assert.rejects(probeRadar({ root, port, get: response(healthy, { status: 503 }) }), { code: 'RADAR_PORT_CONFLICT' });
});

function unfinishedResponse({ drip = false } = {}) {
  let timer, destroyed = 0, chunks = 0;
  const get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => { destroyed++; clearInterval(timer); };
    queueMicrotask(() => {
      const stream = new EventEmitter(); stream.statusCode = 200; callback(stream);
      stream.emit('data', JSON.stringify(healthy)); chunks++;
      // No idle timeout event and no end event. The interval also models a
      // live socket keeping the process alive while the deadline is unref'ed.
      timer = setInterval(() => {
        if (drip) { stream.emit('data', ' '); chunks++; }
      }, 5);
    });
    return request;
  };
  return { get, stop: () => clearInterval(timer), stats: () => ({ destroyed, chunks }) };
}

test('same-install health must match the installed version before a launcher reuses it', async () => {
  for (const version of [undefined, '0.1.6', '2.0.0', 'invalid']) {
    await assert.rejects(probeRadar({ root, port, get: response({ ...healthy, version }) }), { code: 'RADAR_VERSION_MISMATCH' });
  }
  assert.equal((await probeRadar({ root, port, get: response(healthy) })).status, 'ready');
});

test('watchdog recovers a stuck physical transport without mistaking pacing for a stuck request', () => {
  for (const status of ['RATE_LIMITED', 'ERROR', 'RUNNING']) {
    const snapshot = { ...healthy, status, scanner: { scanInProgress: false }, transport: { active: false, stalled: false } };
    assert.equal(watchdogDecision({ status: 'ready', snapshot }, 0).recycle, false);
    assert.equal(watchdogDecision({ status: 'ready', snapshot: { ...snapshot, transport: { active: true, stalled: true } } }, 0).recycle, true);
  }
});

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('health deadline did not return control')), 750);
    })]);
  } finally { clearTimeout(timer); }
}

test('absolute health deadline destroys slow-drip and complete-but-unended responses', async () => {
  for (const drip of [false, true]) {
    const source = unfinishedResponse({ drip }), started = Date.now();
    try {
      const result = await bounded(probeRadar({ root, port, timeoutMs: 40, get: source.get }));
      assert.equal(result.status, 'starting');
      assert.equal(source.stats().destroyed, 1);
      assert.ok(Date.now() - started < 1_000, 'HTTP body activity cannot prolong the probe');
      assert.ok(source.stats().chunks >= 1);
    } finally { source.stop(); }
  }
});

test('unended trickle cannot hang the overall startup readiness deadline', async () => {
  const source = unfinishedResponse({ drip: true }), started = Date.now();
  try {
    await assert.rejects(bounded(waitForRadar({ root, port, timeoutMs: 60, intervalMs: 1,
      probe: options => probeRadar({ ...options, get: source.get }) })), { code: 'RADAR_START_TIMEOUT' });
    assert.ok(source.stats().destroyed >= 1);
    assert.ok(Date.now() - started < 1_000, 'startup must regain control from an unfinished response');
  } finally { source.stop(); }
});

test('completed health response clears its absolute deadline without a later destroy', async () => {
  let destroyed = 0;
  const get = (...args) => {
    const request = response()(...args);
    request.destroy = () => { destroyed++; };
    return request;
  };
  assert.equal((await probeRadar({ root, port, timeoutMs: 20, get })).status, 'ready');
  await delay(40);
  assert.equal(destroyed, 0);
});

test('startup fails immediately on wrong-instance health or an exited launcher instead of retrying it', async () => {
  let attempts = 0;
  await assert.rejects(waitForRadar({ root, port, pause: async () => assert.fail('no retry for another instance'),
    probe: async () => { attempts++; throw Object.assign(new Error('conflict'), { code: 'RADAR_PORT_CONFLICT' }); } }),
  { code: 'RADAR_PORT_CONFLICT' });
  assert.equal(attempts, 1);
  await assert.rejects(waitForRadar({ root, port, probe: async () => ({ status: 'absent' }), stopped: () => true }),
    { code: 'RADAR_PROCESS_EXIT' });
});

test('watchdog preserves healthy local loops during AVE outages and recycles only sustained failures or stuck cycles', () => {
  const ready = { status: 'ready', snapshot: { ...healthy, status: 'RATE_LIMITED', scanner: { scanInProgress: false } } };
  assert.deepEqual(watchdogDecision(ready, 2), { failures: 0, recycle: false });
  assert.deepEqual(watchdogDecision({ status: 'starting' }, 0), { failures: 1, recycle: false });
  assert.deepEqual(watchdogDecision({ status: 'absent' }, 2), { failures: 3, recycle: true });
  assert.equal(watchdogDecision({ status: 'ready', snapshot: { ...healthy,
    scanner: { scanInProgress: true, cycleStartedAt: 1 } } }, 0, 8 * 60_000 + 2).recycle, true);
});

test('supervisor marks only its own child, exits on a foreign listener and never kills a PID discovered by port', async () => {
  const processImpl = new EventEmitter(), spawned = [], killed = [];
  let checks = 0;
  const probe = async () => {
    if (++checks <= 2) return { status: 'absent' };
    throw Object.assign(new Error('another instance'), { code: 'RADAR_PORT_CONFLICT' });
  };
  const spawnImpl = (executable, args, options) => {
    spawned.push({ executable, args, options });
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.kill = signal => { killed.push(signal); child.signalCode = signal; child.emit('exit', 1); };
    return child;
  };
  await assert.rejects(superviseRadar({ root, port, env: { PUBLIC_FIXTURE: '1' }, processImpl, probe, spawnImpl,
    lock: async (_name, callback) => callback(), schedule: callback => { queueMicrotask(callback); return 1; }, cancel: () => {} }),
  { code: 'RADAR_PORT_CONFLICT' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.env.RADAR_SUPERVISED, '1');
  assert.equal(spawned[0].options.env.RADAR_PORT, String(port));
  assert.deepEqual(killed, ['SIGTERM']);
  assert.equal(processImpl.listenerCount('SIGTERM'), 0);
});

test('supervisor does not spawn at all when a healthy instance already exists', async () => {
  await superviseRadar({ root, port, processImpl: new EventEmitter(), probe: async () => ({ status: 'ready', snapshot: healthy }),
    lock: async () => assert.fail('do not wait on the running supervisor lifetime lock'),
    spawnImpl: () => assert.fail('do not duplicate a running service') });
});
