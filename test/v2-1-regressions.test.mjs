import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { RadarState } from '../src/state.mjs';
import { RadarControls, atomicJson } from '../src/local-store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { discoveryScreen } from '../src/scoring.mjs';
import { normalizeLiveRows } from '../src/live-discovery.mjs';
import { healthSnapshot } from '../src/server.mjs';
import vm from 'node:vm';

test('clean install scans the same BSC chain shown by the default page, preserving explicit existing choices', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-v21-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RadarState(dir);
  assert.equal(config.chain, 'bsc'); assert.equal(state.value.activeChain, 'bsc');
  const controls = new RadarControls(dir, config.supportedChains, state.value.activeChain);
  const scanner = new Scanner({ state, controls, provider: { metrics: {}, configured: () => false } });
  assert.equal(scanner.scheduleSnapshot('bsc').selectedEnabled, true);
  assert.deepEqual(controls.value.enabledChains, ['bsc']); scanner.stop();
  controls.setChains(['sol', 'robinhood']);
  atomicJson(path.join(dir, 'radar.json'), { ...state.value, activeChain: 'sol' });
  assert.equal(new RadarState(dir).value.activeChain, 'sol');
  assert.deepEqual(new RadarControls(dir, config.supportedChains, 'bsc').value.enabledChains, ['sol', 'robinhood']);
});

test('single-chain migration collapses old rotation to BSC and preserves annotations, secrets and budget', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-single-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { enabledChains: ['sol', 'robinhood', 'bsc'], annotations: { sample: { note: 'keep' } } };
  atomicJson(path.join(dir, 'preferences.json'), old);
  for (const name of ['ave-credentials.json', 'ave-read-budget.json']) atomicJson(path.join(dir, name), { fixture: name });
  const controls = new RadarControls(dir, config.supportedChains, 'sol', { singleChain: true });
  assert.deepEqual(controls.value.enabledChains, ['bsc']); assert.deepEqual(controls.value.annotations, old.annotations);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json.bak'))), old);
  assert.throws(() => controls.setChains(['bsc', 'sol']));
  assert.deepEqual(controls.value.enabledChains, ['bsc']);
  controls.setChains(['sol']);
  assert.deepEqual(new RadarControls(dir, config.supportedChains, 'bsc', { singleChain: true }).value.enabledChains, ['sol']);
  for (const name of ['ave-credentials.json', 'ave-read-budget.json']) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, name))), { fixture: name });
});

test('single-chain selection and restart align with the scanner without bypassing cooldown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-single-cooldown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RadarState(dir); state.value.activeChain = 'sol';
  const controls = new RadarControls(dir, config.supportedChains, 'bsc', { singleChain: true });
  const provider = { schedulerReadyAt: Date.now() + 300000, snapshot: () => ({ transport: { spacingMs: 300000 } }) };
  const scanner = new Scanner({ state, controls, provider });
  assert.equal(scanner.activeChain, 'bsc');
  const visits = []; scanner.cycle = async () => { visits.push(scanner.activeChain); };
  await scanner.start();
  const deadline = scanner.nextTickAt, providerDeadline = provider.schedulerReadyAt;
  for (const chain of ['sol', 'base', 'eth', 'robinhood', 'bsc']) {
    scanner.switchChain(chain);
    assert.deepEqual(controls.value.enabledChains, [chain]); assert.equal(scanner.activeChain, chain);
    assert.deepEqual(scanner.scheduleSnapshot(chain).eligibleChains, [chain]);
    assert.equal(scanner.scheduleSnapshot(chain).nominalChainIntervalMs, 300000);
  }
  assert.deepEqual(visits, []); assert.equal(scanner.nextTickAt, deadline); assert.equal(provider.schedulerReadyAt, providerDeadline);
  scanner.stop();
});

test('removed chain preferences recover to a supported scan target instead of an empty scheduling pool', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-removed-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  atomicJson(path.join(dir, 'preferences.json'), { enabledChains: ['removed-chain'], annotations: {} });
  const state = new RadarState(dir); state.value.activeChain = 'removed-chain';
  const controls = new RadarControls(dir, config.supportedChains, state.value.activeChain, { singleChain: true });
  const scanner = new Scanner({ state, controls, provider: {} });
  assert.deepEqual(controls.value.enabledChains, ['bsc']);
  assert.equal(scanner.activeChain, 'bsc'); assert.deepEqual(scanner.schedulingPool(), ['bsc']);
  scanner.stop();
});

test('in-flight single-chain selection keeps only the last choice and waits for the shared deadline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-single-inflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RadarState(dir), controls = new RadarControls(dir, config.supportedChains, 'bsc', { singleChain: true });
  const visits = []; let complete;
  const provider = { metrics: {}, keyEpoch: 1, configured: async () => true,
    discover: async chain => { visits.push(chain); return new Promise(resolve => { complete = resolve; }); } };
  const scanner = new Scanner({ state, controls, provider, settings: { ...config, maxDeepAuditsPerCycle: 0, outcomeReadsPerCycle: 0 } });
  const running = scanner.cycle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanner.switchChain('sol').queued, true);
  assert.equal(scanner.switchChain('bsc').queued, false); assert.equal(scanner.pendingChain, '');
  scanner.switchChain('sol'); scanner.switchChain('eth');
  assert.deepEqual(controls.value.enabledChains, ['eth']);
  provider.schedulerReadyAt = Date.now() + 300000; complete([]); await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(visits, ['bsc']); assert.equal(scanner.activeChain, 'eth'); assert.equal(scanner.pendingChain, '');
  provider.schedulerReadyAt = 0; provider.discover = async chain => { visits.push(chain); return []; };
  await scanner.cycle(); scanner.stop(); assert.deepEqual(visits, ['bsc', 'eth']);
});

test('active 6h+ hot-list observations do not require unrequested history, but remain unverified', () => {
  const at = 1_800_000_000_000, nowSec = at / 1000;
  const row = { marketProvider: 'AVE', chain: 'bsc', address: '0x' + '1'.repeat(40), symbol: 'OBS',
    price: 1, market_cap: 50000, liquidity: 20000, volume_5m: 1000, buy_volume_5m: 600, sell_volume_5m: 400,
    launch_at: nowSec - 7 * 3600, capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 30000 };
  const settings = { ...config, chain: 'bsc' }, result = discoveryScreen(row, settings, nowSec);
  assert.equal(result.pass, true); assert.equal(result.historyVerified, false);
  assert.equal(result.evidenceWarnings.length, 2);
  const [live] = normalizeLiveRows([row], 'bsc', [], at);
  assert.equal(live.discoveryState, 'READY'); assert.equal(live.hasUnknownRisk, true);
  for (const change of [{ is_honeypot: true }, { is_wash_trading: true }, { sellable: false },
    { is_open_source: false }, { dev_team_hold_rate: .02 }, { buy_tax: .1 },
    { volume_5m: 10 }, { liquidity: 1000 }, { sourceUpdatedAt: at - 61000 }]) {
    assert.equal(discoveryScreen({ ...row, ...change }, settings, nowSec).pass, false, JSON.stringify(change));
  }
});

test('health reports a physically stuck request, not a normal provider cooldown, without private transport contents', () => {
  const at = 1_800_000_000_000, settings = { ...config, version: '2.1.0' };
  for (const transport of [{}, { active: false, activeSince: at - 120000 }, { active: true, activeSince: at - 10000 },
    { active: true, activeSince: null }, { active: true, activeSince: at + 1 }]) {
    assert.equal(healthSnapshot({}, settings, at, transport).transport.stalled, false);
  }
  const result = healthSnapshot({}, settings, at, { active: true, activeSince: at - 61000, key: 'synthetic-private' });
  assert.equal(result.transport.stalled, true); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test('late voice module receives the current snapshot without another request, and static HTML obeys style CSP', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\sstyle=["']/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  const listeners = {}, sent = [], voiceSnapshot = { alertsAvailable: false, chains: { bsc: [] } };
  const context = { serviceOnline: true, lastData: { voiceSnapshot },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { addEventListener: (event, fn) => { listeners[event] = fn; }, dispatchEvent: event => sent.push(event) } };
  const start = html.indexOf("    window.addEventListener('radar-voice-ready'");
  vm.runInNewContext(html.slice(start, html.indexOf('    const storedLocale =', start)), context);
  listeners['radar-voice-ready'](); assert.equal(sent.length, 1); assert.equal(sent[0].detail, voiceSnapshot);
  context.serviceOnline = false; listeners['radar-voice-ready'](); assert.equal(sent.length, 1);
});
