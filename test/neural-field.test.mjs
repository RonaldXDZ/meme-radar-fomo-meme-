import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function harness(enabled = true) {
  let writes = 0, markup = '';
  const classes = new Map();
  const host = { dataset: {}, classList: { toggle: (key, value) => classes.set(key, value) },
    set innerHTML(value) { writes++; markup = value; }, get innerHTML() { return markup; } };
  const toggle = {};
  const context = { document: { hidden: false }, currentLocale: 'zh-CN',
    byId: id => id === 'neuralField' ? host : toggle, readStorage: () => enabled,
    voiceSpotlightKey: row => row.address, voiceSpotlightRank: row => row.reminded ? 0 : Infinity,
    t: key => key, escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) };
  const start = html.indexOf('    function renderNeuralField(');
  const end = html.indexOf('    async function refreshLive(', start);
  vm.runInNewContext(html.slice(start, end) + ';this.render=renderNeuralField', context);
  return { context, host, toggle, classes, writes: () => writes };
}
test('field uses only actual rows, escapes token labels and bounds nodes at 36', () => {
  const h = harness();
  h.context.render([], false);
  assert.equal((h.host.innerHTML.match(/class="neural-node/g) || []).length, 0);
  h.context.render(Array.from({length:100}, (_, i) => ({address:String(i),symbol:'<img onerror="x">'})), false);
  assert.equal((h.host.innerHTML.match(/class="neural-node/g) || []).length, 36);
  assert.ok(!h.host.innerHTML.includes('<img'));
  assert.ok(h.host.innerHTML.includes('&lt;img'));
  assert.ok(!h.host.innerHTML.includes('neural-caption'));
  assert.ok(!h.host.innerHTML.includes('neuralNote'));
  assert.doesNotMatch(h.host.innerHTML, /\sstyle=/);
  assert.match(h.host.innerHTML, /pathLength="1"/);
  assert.match(html, /@keyframes neural-connect/);
  assert.match(html, /@keyframes neural-contact/);
  for (const name of ['neural-arm', 'neural-node', 'neural-dust', 'neural-feeler']) {
    assert.match(html, new RegExp('\\.' + name + ' \\{[^}]*neural-swim 12s ease-in-out infinite'));
  }
  assert.match(html, /transform-box:view-box; transform-origin:500px 205px/);
  const realArm = html.match(/\.neural-arm \{([^}]+)\}/)[1];
  assert.match(realArm, /stroke-dasharray:none/);
  assert.doesNotMatch(realArm, /neural-connect/);
  assert.match(html, /\.neural-feeler \{[^}]*neural-connect/);
});
test('only real reminder state selects nodes; unchanged polls do not restart the scene', () => {
  const h = harness();
  const rows = [{address:'a',symbol:'A'}, {address:'b',symbol:'B',reminded:true}];
  h.context.render(rows, false);
  assert.equal((h.host.innerHTML.match(/class="neural-node neural-selected /g) || []).length, 1);
  h.context.render(rows, true);
  assert.equal(h.writes(), 1);
  assert.equal(h.classes.get('neural-paused'), true);
  rows[1].reminded = false;
  h.context.render(rows, false);
  assert.equal(h.writes(), 2);
  assert.ok(!h.host.innerHTML.includes('neural-node neural-selected'));
});
test('simple mode hides the field and hidden documents pause it', () => {
  const h = harness(false);
  h.context.render([{address:'a',symbol:'A'}], false);
  assert.equal(h.host.hidden, true);
  assert.equal(h.writes(), 0);
  const visible = harness();
  visible.context.document.hidden = true;
  visible.context.render([], false);
  assert.equal(visible.classes.get('neural-paused'), true);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /frontRow\.appendChild\(card\)/);
  assert.match(html, /byId\('livePanel'\)\.addEventListener\('click'/);
});

test('ambient dots are unnamed decorations even when the real candidate pool is empty', () => {
  const h = harness();
  const rows = [];
  h.context.render(rows, true);
  const ambient = h.host.innerHTML.match(/<g class="neural-ambient" aria-hidden="true">([\s\S]*?)<\/g>/)[1];
  assert.equal((ambient.match(/class="neural-dust /g) || []).length, 60);
  assert.equal((ambient.match(/class="neural-feeler /g) || []).length, 24);
  assert.doesNotMatch(ambient, /<text|<title|neural-node|neural-selected|address|symbol/);
  assert.equal(rows.length, 0);
  assert.doesNotMatch(h.host.innerHTML, /class="neural-node/);
  h.context.render([{address:'real-contract',symbol:'REAL'}], false);
  assert.equal(h.host.innerHTML.match(/<g class="neural-ambient" aria-hidden="true">([\s\S]*?)<\/g>/)[1], ambient, 'polls and real candidate changes must not reshuffle the ambient field');
  assert.match(h.host.innerHTML, />REAL<\/text>/);
  assert.equal((h.host.innerHTML.match(/class="neural-node/g) || []).length, 1);
});

test('decorative cycle relocates a dot and its matching arm together but never a real token', () => {
  const h = harness(), attributes = {}, path = {};
  h.host.querySelector = selector => {
    assert.equal(selector, '[data-spark-arm="7"]');
    return {setAttribute(key, value) {path[key] = value;}};
  };
  const dot = {dataset:{spark:'7'},classList:{contains: name => name === 'neural-dust'},
    setAttribute(key,value) {attributes[key] = value;}};
  h.context.relocateNeuralSpark({animationName:'neural-emerge',target:dot});
  assert.ok(Number.isFinite(attributes.cx) && Number.isFinite(attributes.cy));
  assert.ok(path.d.endsWith(' ' + attributes.cx + ' ' + attributes.cy));
  const previous = {...attributes};
  dot.classList.contains = () => false;
  h.context.relocateNeuralSpark({animationName:'neural-emerge',target:dot});
  assert.deepEqual(attributes, previous);
  assert.match(html, /addEventListener\('animationiteration', relocateNeuralSpark\)/);
});
