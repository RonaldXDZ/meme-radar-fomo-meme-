import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
test('shutdown bounds active connections and releases the launcher even if close stalls', () => {
  for (const stalled of [true, false]) {
    let deadline, closed = 0, exits = 0, cleared = 0, stops = 0;
    const context = {
      scanner: {stop() { stops++; }}, liveDiscovery: {stop() {}}, market: {resetCredentials() {}},
      process: {exit(code) { assert.equal(code, 0); exits++; }},
      setTimeout(fn, ms) { assert.equal(ms, 3000); deadline = fn; return {unref() {}}; },
      clearTimeout() { cleared++; },
      server: {close(fn) {if (!stalled) fn();},closeIdleConnections() {},closeAllConnections() {closed++;}}
    };
    vm.runInNewContext(main.slice(main.indexOf('let closing = false;'), main.indexOf("for (const signal of ['SIGINT'")) + ';shutdown();shutdown();', context);
    assert.equal(stops, 1);
    if (stalled) { assert.equal(exits, 0); deadline(); assert.equal(closed, 1); }
    else assert.equal(cleared, 1);
    assert.equal(exits, 1);
  }
});
