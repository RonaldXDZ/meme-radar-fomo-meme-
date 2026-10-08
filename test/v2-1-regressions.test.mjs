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
