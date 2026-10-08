import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function harness(fetch) {
  const timers = [], rendered = [], elements = {};
  const c = { fetch, AbortSignal, document: { hidden: false }, window: { dispatchEvent() {} },
    CustomEvent: class {}, viewChain: 'bsc', refreshSequence: 0, acceptedRefresh: 0, offlineSince: 0,
    serviceOnline: false, t: k => k, byId: k => elements[k] ||= {}, ensureVisibleChain: () => false,
    render: data => rendered.push(data), renderChainSwitcher() {}, renderTelemetry() {}, desktopAlert() {},
    clearTimeout() {}, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; } };
  vm.runInNewContext(html.slice(html.indexOf('let refreshBusy ='), html.indexOf('function startParticleField()')) + ';this.run = refresh;', c);
  return { c, timers, rendered };
}
test('slow status requests remain single-flight even with repeated refresh clicks', async () => {
  let finish, requests = 0;
  const h = harness(() => { requests++; return new Promise(r => { finish = r; }); });
  const first = h.c.run();
  await Promise.all(Array.from({ length: 20 }, () => h.c.run()));
  assert.equal(requests, 1);
  finish({ ok: true, json: async () => ({ voiceSnapshot: [] }) }); await first;
  assert.equal(h.rendered.length, 1); assert.equal(h.timers.at(-1).delay, 3000);
});
test('failure backs off, background throttles, and success restores normal cadence', async () => {
  const h = harness(async () => { throw Error('offline'); });
  await h.c.run(); assert.equal(h.timers.at(-1).delay, 6000);
  await h.c.run(); assert.equal(h.timers.at(-1).delay, 12000);
  for (let i = 0; i < 8; i++) await h.c.run();
  assert.equal(h.timers.at(-1).delay, 30000);
  h.c.fetch = async () => ({ ok: true, json: async () => ({}) });
  await h.c.run(); assert.equal(h.timers.at(-1).delay, 3000);
  h.c.document.hidden = true; await h.c.run(); assert.equal(h.timers.at(-1).delay, 30000);
});
test('a chain switch drops the late result and schedules exactly one immediate follow-up', async () => {
  let finish;
  const h = harness(() => new Promise(r => { finish = r; }));
  const old = h.c.run(); h.c.viewChain = 'sol'; await h.c.run(); await h.c.run();
  finish({ ok: true, json: async () => ({}) }); await old;
  assert.equal(h.rendered.length, 0); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 0);
});
test('page boot has no animation startup or overlapping fixed status interval', () => {
  const boot = html.slice(html.indexOf("const storedLocale ="));
  assert.doesNotMatch(boot, /startParticleField\(\)|setInterval\(refresh,/);
  assert.match(boot, /if \(!document.hidden\) renderTelemetry/);
});
