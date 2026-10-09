import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';
import { RadarState } from '../src/state.mjs';
import { RadarControls } from '../src/local-store.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-manual-refresh-'));
  const state = new RadarState(dir);
  const controls = new RadarControls(dir, config.supportedChains, 'bsc', { singleChain: true });
  const calls = [];
  const provider = { metrics: {}, keyEpoch: 1, configured: async () => true,
    discover: async chain => { calls.push(chain); provider.schedulerReadyAt = Date.now() + 300000; return []; } };
  const scanner = new Scanner({ provider, state, controls, settings: { ...config, maxDeepAuditsPerCycle: 0, outcomeReadsPerCycle: 0 } });
  t.after(() => { scanner.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { scanner, provider, controls, state, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manual refresh button is prominent beside the radar title, before the search toolbar', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const heading = html.slice(html.indexOf('<div class="live-heading">'), html.indexOf('<div class="live-toolbar">'));
  assert.match(heading, /class="live-title-row"/);
  assert.match(heading, /id="scanNow" class="mini-button scan-now-prominent"/);
  assert.equal((html.match(/id="scanNow"/g) || []).length, 1);
  assert.doesNotMatch(html, /(?:chainPollingBadge|chainJoinTitle|chainReplaced|chainAdded|saveChains|schedulerSummary):/);
});

test('manual scan starts only the selected chain, coalesces simultaneous clicks, and keeps provider cooldown', async t => {
  const { scanner, provider, calls } = fixture(t);
  assert.deepEqual(scanner.refreshSelectedChain('bsc'), { status: 'started' });
  for (let i = 0; i < 20; i++) assert.equal(scanner.refreshSelectedChain('bsc').status, 'scanning');
  await settle();
  assert.deepEqual(calls, ['bsc']); assert.equal(scanner.running, false);
  const deadline = provider.schedulerReadyAt;
  for (let i = 0; i < 20; i++) assert.deepEqual(scanner.refreshSelectedChain('bsc'), { status: 'cooldown', retryAt: deadline });
  assert.equal(provider.schedulerReadyAt, deadline); assert.deepEqual(calls, ['bsc']);
});

test('manual scan obeys the longest scheduler, rate-limit or quota deadline without changing state', async t => {
  const { scanner, provider, state, calls } = fixture(t);
  const before = JSON.stringify(state.value), now = Date.now();
  for (const [scheduler, spacing, backoff] of [[300000, 0, 0], [0, 480000, 0], [300000, 480000, 900000]]) {
    scanner.nextTickAt = scheduler ? now + scheduler : 0;
    provider.schedulerReadyAt = spacing ? now + spacing : 0;
    provider.nextAllowedAt = backoff ? now + backoff : 0;
    assert.deepEqual(scanner.refreshSelectedChain('bsc'), { status: 'cooldown', retryAt: now + Math.max(scheduler, spacing, backoff) });
  }
  await settle(); assert.deepEqual(calls, []); assert.equal(JSON.stringify(state.value), before);
});

test('manual scan never switches a stale tab target or overrides stopped, auth and total budget gates', async t => {
  const { scanner, provider, state, calls, controls } = fixture(t);
  for (const chain of ['sol', 'base', 'eth', 'robinhood', 'unsupported']) assert.equal(scanner.refreshSelectedChain(chain).status, 'chain_changed');
  assert.deepEqual(controls.value.enabledChains, ['bsc']);
  state.value.status = 'AVE_AUTH_REQUIRED'; assert.equal(scanner.refreshSelectedChain('bsc').status, 'auth_required');
  state.value.status = 'RUNNING'; provider.snapshot = () => ({ manualResetRequired: true });
  assert.equal(scanner.refreshSelectedChain('bsc').status, 'budget_paused');
  provider.snapshot = () => ({}); scanner.stop(); assert.equal(scanner.refreshSelectedChain('bsc').status, 'unavailable');
  await settle(); assert.deepEqual(calls, []);
});

test('manual refresh while switching chains does not queue another scan behind the in-flight request', async t => {
  const { scanner, provider, calls } = fixture(t); let complete;
  provider.discover = async chain => { calls.push(chain); provider.schedulerReadyAt = Date.now() + 300000; return new Promise(resolve => { complete = resolve; }); };
  scanner.refreshSelectedChain('bsc'); await settle();
  scanner.switchChain('sol');
  assert.equal(scanner.refreshSelectedChain('bsc').status, 'chain_changed');
  assert.equal(scanner.refreshSelectedChain('sol').status, 'scanning');
  assert.equal(scanner.rescanRequested, false);
  complete([]); await settle();
  assert.equal(scanner.activeChain, 'sol'); assert.equal(scanner.refreshSelectedChain('sol').status, 'cooldown');
  assert.deepEqual(calls, ['bsc']);
});

function ui() {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('    function renderScanNow()'), end = html.indexOf('    function providerStatus(', start);
  const button = {}, requests = [], messages = [], reads = [];
  const context = { manualScanBusy: false, manualScanRetry: null, chainSwitching: false, serviceOnline: true, viewChain: 'sol',
    lastData: { activeChain: 'sol', scheduler: {} }, liveEnabled: false,
    activeChain: data => data.activeChain, byId: () => button, number: n => Number(n) || 0,
    t: (key, args) => key + (args?.time ? ':' + args.time : ''), formatDuration: ms => String(Math.ceil(ms / 1000)),
    showToast: text => messages.push(text), refresh: async () => reads.push('status'), refreshLive: async force => reads.push(force),
    postLocal: async (url, body) => { requests.push({ url, ...body }); return { status: 'started' }; } };
  vm.createContext(context); vm.runInContext(html.slice(start, end), context);
  return { context, button, requests, messages, reads, html };
}

test('manual refresh UI shows countdown, uses selected chain, and still reads once with auto-update disabled', async () => {
  const { context, button, requests, messages, reads, html } = ui();
  context.lastData.scheduler.selectedNextAttemptAt = Date.now() + 60000;
  context.renderScanNow(); assert.equal(button.textContent, 'scanNow'); assert.match(button.title, /scanNowWait:/);
  assert.equal(button.disabled, false);
  await context.refreshCurrentScan();
  assert.deepEqual(requests, [{ url: '/api/scan-now', chain: 'sol' }]);
  assert.deepEqual(reads, ['status', true]); assert.equal(context.liveEnabled, false);
  assert.deepEqual(messages, ['scanNowStarted']); assert.equal(context.manualScanBusy, false);
  assert.match(html, /byId\('scanNow'\)\.addEventListener\('click', refreshCurrentScan\)/);
  assert.match(html, /!liveEnabled && force !== true/);
});

test('manual refresh UI deduplicates pending clicks and does not claim scan success during cooldown', async () => {
  const { context, button, messages } = ui(); let complete, count = 0;
  context.postLocal = () => { count++; return new Promise(resolve => { complete = resolve; }); };
  const pending = context.refreshCurrentScan();
  assert.equal(button.disabled, true); await context.refreshCurrentScan(); assert.equal(count, 1);
  complete({ status: 'cooldown', retryAt: Date.now() + 480000 }); await pending;
  assert.match(messages[0], /^scanNowCooldown:/); assert.equal(button.textContent, 'scanNow'); assert.match(button.title, /scanNowWait:/);
  assert.equal(button.disabled, false); assert.equal(context.manualScanRetry.chain, 'sol');
});

test('manual refresh UI handles offline, switching and errors without exposing internal messages', async () => {
  const { context, button, requests, messages } = ui();
  context.serviceOnline = false; context.renderScanNow(); assert.equal(button.disabled, true);
  await context.refreshCurrentScan(); assert.deepEqual(requests, []);
  context.serviceOnline = true; context.chainSwitching = true; await context.refreshCurrentScan(); assert.deepEqual(requests, []);
  context.chainSwitching = false; context.postLocal = async () => { throw Error('synthetic-private-message'); };
  await context.refreshCurrentScan(); assert.deepEqual(messages, ['scanNowFailed']); assert.equal(context.manualScanBusy, false);
});

test('manual refresh UI does not attribute an old-chain response to a newly selected chain', async () => {
  const { context, messages, button } = ui();
  context.postLocal = async () => { context.viewChain = 'bsc'; return { status: 'started' }; };
  await context.refreshCurrentScan(); assert.deepEqual(messages, ['scanNowChanged']);
  context.lastData.scheduler.reason = 'scanning'; context.renderScanNow(); assert.equal(button.textContent, 'scanNowRunning');
});

test('automatic scanning continues after a manual attempt fails and does not lose its scheduled timer', async t => {
  let now = Date.now(); const timers = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cancelled = true; });
  const { scanner, provider, state, calls } = fixture(t);
  provider.discover = async chain => {
    calls.push(chain); provider.schedulerReadyAt = now + 300000;
    if (calls.length === 2) throw Object.assign(new Error('synthetic outage'), { code: 'AVE_NETWORK' });
    return [];
  };
  await scanner.start();
  assert.deepEqual(calls, ['bsc']); const automaticTimer = scanner.timer;
  assert.equal(scanner.refreshSelectedChain('bsc').status, 'cooldown');
  assert.equal(scanner.timer, automaticTimer); assert.equal(automaticTimer.cancelled, undefined);
  now = scanner.nextTickAt;
  assert.equal(scanner.refreshSelectedChain('bsc').status, 'started');
  automaticTimer.fn(); await settle();
  assert.equal(state.value.status, 'ERROR'); assert.equal(scanner.running, false);
  assert.notEqual(scanner.timer, automaticTimer); assert.ok(scanner.nextTickAt > now);
  now = scanner.nextTickAt; scanner.timer.fn(); await settle();
  assert.deepEqual(calls, ['bsc', 'bsc', 'bsc']); assert.equal(state.value.status, 'RUNNING');
  assert.equal(scanner.stopped, false); assert.ok(scanner.nextTickAt > now);
});

test('manual button never disables automatic page refresh on success, cooldown or failure', async () => {
  for (const status of ['started', 'scanning', 'cooldown', 'auth_required', 'budget_paused', 'unavailable', 'error']) {
    const { context } = ui(); context.liveEnabled = true;
    context.postLocal = async () => {
      if (status === 'error') throw Error('synthetic network failure');
      return { status, retryAt: Date.now() + 60000 };
    };
    await context.refreshCurrentScan();
    assert.equal(context.liveEnabled, true, status); assert.equal(context.manualScanBusy, false, status);
  }
});
