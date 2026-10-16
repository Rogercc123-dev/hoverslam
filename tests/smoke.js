// Headless smoke test with a strict hand-made DOM and canvas stand-in (no jsdom available offline).
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
const LVN = require('../src/sim.js').LEVELS.length;
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

const METHODS = ['save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash', 'drawImage'];
const PROPS = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'globalCompositeOperation', 'font', 'textAlign', 'textBaseline', 'shadowBlur', 'shadowColor', 'imageSmoothingEnabled'];
let drawCalls = 0;
const ctxStore = {};
const ctx = new Proxy({}, {
  get(_, p) {
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop(o, c) { if (typeof c !== 'string') throw new Error('bad color stop'); } });
    if (p === 'measureText') return () => ({ width: 60 });
    if (METHODS.includes(p)) return (...a) => { drawCalls++; for (const v of a) if (typeof v === 'number' && !isFinite(v)) throw new Error('non-finite arg to ctx.' + p + ' ' + a.join(',')); };
    if (PROPS.includes(p)) return ctxStore[p];
    throw new Error('unknown ctx member: ' + String(p));
  },
  set(_, p, v) { if (!PROPS.includes(p)) throw new Error('unknown ctx prop: ' + String(p)); if (p === 'globalAlpha' && !(v >= 0 && v <= 1)) throw new Error('globalAlpha out of range ' + v); ctxStore[p] = v; return true; }
});

const els = {};
function makeEl(id) {
  const el = {
    id, hidden: false, children: [], _l: {}, dataset: {}, textContent: '', innerHTML: '', clientWidth: 390, clientHeight: 800, width: 0, height: 0, disabled: false,
    style: { setProperty() {}, transform: '', opacity: '', width: '' },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    appendChild(c) { this.children.push(c); }, setAttribute() {}, getAttribute(name) { return this._attrs && this._attrs[name] || null; }, setPointerCapture() {}, focus() {}, blur() {},
    querySelectorAll(sel) {
      if (this._queryMarkup !== this.innerHTML) { this._queryMarkup = this.innerHTML; this._queryCache = {}; }
      if (this._queryCache && this._queryCache[sel]) return this._queryCache[sel];
      const attr = (sel.match(/data-([a-z-]+)/) || [])[1]; if (!attr) return [];
      const re = new RegExp('<button\\b[^>]*\\bdata-' + attr + '="([^"]+)"[^>]*>', 'gi'), out = []; let m;
      while ((m = re.exec(this.innerHTML))) { const child = makeEl(id + '-dynamic'); child.dataset[attr] = m[1]; child._attrs = {}; child._attrs['data-' + attr] = m[1]; out.push(child); }
      this._queryCache[sel] = out; return out;
    },
    getContext() { return ctx; }
  };
  return el;
}
const DYN = ['r-next', 'r-retry', 'r-levels', 'r-score'];
function byId(id) {
  const dynamic = Object.keys(els).some(k => typeof els[k].innerHTML === 'string' && els[k].innerHTML.includes('id="' + id + '"'));
  if (!ids.has(id) && !dynamic) return null;
  if (DYN.includes(id) && !(els['r-card'] && els['r-card'].innerHTML.includes('id="' + id + '"'))) return null;
  return els[id] || (els[id] = makeEl(id));
}
const doc = {
  hidden: false, activeElement: null, fonts: { ready: Promise.resolve() },
  getElementById: byId,
  querySelector(sel) { return sel[0] === '#' ? byId(sel.slice(1)) : null; },
  querySelectorAll(sel) {
    const attr = (sel.match(/data-([a-z-]+)/) || [])[1]; if (!attr) return [];
    const re = new RegExp('<button\\b[^>]*\\bdata-' + attr + '="([^"]+)"[^>]*>', 'gi'), out = []; let m;
    while ((m = re.exec(html))) { const child = makeEl('static-dynamic'); child.dataset[attr] = m[1]; child._attrs = {}; child._attrs['data-' + attr] = m[1]; out.push(child); }
    return out;
  },
  createElement(t) { const e = makeEl(null); e.tag = t; return e; },
  addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); }, _l: {}
};
let rafQ = [];
const win = {
  document: doc, _l: {}, devicePixelRatio: 2,
  addEventListener(t, f) { (win._l[t] = win._l[t] || []).push(f); },
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (f) => { rafQ.push(f); return 1; },
  performance: { now: () => now },
  navigator: {}, setTimeout, clearTimeout, console, Math, Date, JSON, Promise,
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
  __HS_TEST: true
};
let now = 0;
win.window = win; win.self = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(__dirname + '/../src/sim.js', 'utf8'), win);
if (!win.Sim) throw new Error('Sim not defined');
const errors = [];
try { vm.runInContext(fs.readFileSync(__dirname + '/../src/app.js', 'utf8'), win); } catch (e) { console.log('BOOT ERROR', e.stack); process.exit(1); }
const H = win.__hs;

function frames(n, dtMs = 16.667) {
  for (let i = 0; i < n; i++) {
    now += dtMs;
    const cbs = rafQ.splice(0);
    if (!cbs.length) throw new Error('no rAF callback queued');
    try { cbs.forEach(cb => cb(now)); } catch (e) { console.log('FRAME ERROR at', H.G.mode, H.G.sim && H.G.sim.status, '\n', e.stack.split('\n').slice(0, 5).join('\n')); process.exit(1); }
  }
}
function fire(id, type = 'click', ev = {}) { const e = byId(id); (e._l[type] || []).forEach(f => f.call(e, Object.assign({ preventDefault() {}, pointerId: 1 }, ev))); }
function key(type, code) { (win._l[type] || []).forEach(f => f({ code, preventDefault() {}, repeat: false })); }
function visible(name) { return !byId('s-' + name).hidden; }
function check(c, msg) { if (!c) { console.log('FAIL:', msg); process.exit(1); } else console.log('ok  ', msg); }

const rc = byId('r-card'); let rcSets = []; let _ih = '';
Object.defineProperty(rc, 'innerHTML', { get() { return _ih; }, set(v) { _ih = v; DYN.forEach(d => delete els[d]); rcSets.push((v.match(/<h2>(.*?)<\/h2>/) || [])[1] + '@mode=' + H.G.mode + '/t=' + H.G.sim.t.toFixed(1)); } });
// 1. boot -> menu with attract mode running
frames(5);
check(visible('menu'), 'menu visible after boot');
check(/Mission 1/.test(byId('m-play-s').textContent), 'menu shows next mission: ' + byId('m-play-s').textContent);
frames(60 * 40);
check(drawCalls > 1000, 'attract mode drew frames (' + drawCalls + ' calls)');

// 2. every mission opens a briefing
fire('m-levels'); frames(3);
check(visible('levels') && byId('l-grid').children.length === LVN, 'mission grid has ' + LVN + ' tiles');
const tiles = byId('l-grid').children;
check(tiles[0].disabled === false && tiles[1].disabled === true, 'only mission 1 unlocked on a fresh save');
for (let i = 0; i < LVN; i++) { H.G.cur = i + 1; win.localStorage._d = {}; }
fire('l-back'); frames(3);

// 3. brief -> launch -> fly with keyboard, then pause/resume
fire('m-play'); frames(3);
check(visible('brief') && byId('b-name').textContent === 'First Light', 'briefing for mission 1 shown');
check(/Calm/.test(byId('b-specs').innerHTML) && /Land on the ship/.test(byId('b-goals').innerHTML), 'briefing specs and goals filled');
fire('b-go'); frames(3);
check(H.G.mode === 'fly' && !byId('hud').hidden && !byId('controls').hidden, 'flying with HUD and controls visible');
key('keydown', 'ArrowUp'); key('keydown', 'ArrowLeft'); frames(60);
check(H.G.sim.throttle > 0.5, 'thrust key spools the engine (throttle ' + H.G.sim.throttle.toFixed(2) + ')');
check(H.G.sim.fuel < 1, 'fuel is burning');
key('keyup', 'ArrowUp'); key('keyup', 'ArrowLeft'); frames(30);
key('keydown', 'Escape'); frames(3);
check(visible('pause') && H.G.paused, 'Escape pauses');
const tPause = H.G.sim.t; frames(30);
check(H.G.sim.t === tPause, 'sim frozen while paused');
fire('p-resume'); frames(3);
check(!H.G.paused && !visible('pause'), 'resume works');
fire('btn-thrust', 'pointerdown'); frames(20); fire('btn-thrust', 'pointerup');
check(H.G.sim.throttle > 0.2, 'on-screen thrust button works');

// 4. do nothing until it crashes -> result card with a tip and retry
frames(60 * 60);
check(visible('result') && /Try again/.test(byId('r-card').innerHTML), 'failure result card shown: ' + (byId('r-card').innerHTML.match(/<h2>(.*?)<\/h2>/) || [])[1]);
fire('r-retry'); frames(3);
check(H.G.mode === 'fly' && H.G.sim.status === 'flying', 'retry relaunches');

// 5. autopilot lands it -> success card, stars saved, next mission unlocked
H.ctrl = (s) => win.Sim.autopilot(s);
let guard = 0; while (H.G.mode === 'fly' && guard++ < 60 * 90) frames(1);
frames(60 * 3);
check(H.G.sim.status === 'landed', 'autopilot landed (status ' + H.G.sim.status + ')');
check(visible('result') && /Touchdown/.test(byId('r-card').innerHTML) && /Score/.test(byId('r-card').innerHTML), 'success result card shown');
const saved = JSON.parse(win.localStorage._d['hoverslam.v1']);
check(saved.levels['1'] && saved.levels['1'].done && saved.levels['1'].best > 1000, 'progress saved: ' + JSON.stringify(saved.levels['1']));
fire('r-next'); frames(3);
console.log('r-card sets:', rcSets.join(' | '));
console.log('DEBUG mode', H.G.mode, 'cur', H.G.cur, 'brief hidden', byId('s-brief').hidden, 'name', byId('b-name').textContent, 'listeners', '');
check(visible('brief') && byId('b-name').textContent === 'Open Water', 'next mission briefing opens');
H.ctrl = null;

// 6. every mission, every sky theme: autopilot flight plus a no-input crash, all through the strict renderer
const outcomes = {};
const seenHazard = {};
for (let id = 1; id <= LVN; id++) {
  for (const mode of ['auto', 'idle']) {
    fire('l-back'); frames(2); fire('m-levels'); frames(2);
    const tile = byId('l-grid').children[id - 1];
    tile._l.click.forEach(f => f({}));
    frames(2);
    if (byId('b-name').textContent !== win.Sim.LEVELS[id - 1].name) { console.log('FAIL: brief name mismatch for', id); process.exit(1); }
    frames(30);
    fire('b-go'); frames(2);
    H.ctrl = mode === 'auto' ? (s) => win.Sim.autopilot(s) : null;
    let g = 0;
    while (H.G.mode === 'fly' && g++ < 60 * 100) {
      frames(1);
      if (mode === 'auto') {
        const cueTx = byId('cue').textContent, altTx = byId('v-alt').textContent;
        if (cueTx === 'ENGINE OUT') seenHazard[id + 'fault'] = true;
        if (cueTx === 'NO DATA' && altTx === '--') seenHazard[id + 'dark'] = true;
        if (H.G.sim.level.leak && H.G.sim.fuel < H.G.sim.level.fuel - 0.02) seenHazard[id + 'leak'] = true;
      }
    }
    frames(60 * 3);
    if (!visible('result')) { console.log('FAIL: no result card for level', id, mode, H.G.sim.status); process.exit(1); }
    const title = (byId('r-card').innerHTML.match(/<h2>(.*?)<\/h2>/) || [])[1];
    outcomes[id + mode[0]] = title;
    H.ctrl = null;
  }
}
console.log(JSON.stringify(outcomes));
const okAuto = Object.keys(outcomes).filter(k => k.endsWith('a') && outcomes[k] === 'Touchdown').length;
check(okAuto >= LVN - 2, 'autopilot touched down on ' + okAuto + '/' + LVN + ' missions through the full UI');
for (const lv of win.Sim.LEVELS) {
  if (lv.fault) check(seenHazard[lv.id + 'fault'], 'mission ' + lv.id + ' shows the ENGINE OUT alert in flight');
  if (lv.blackout) check(seenHazard[lv.id + 'dark'], 'mission ' + lv.id + ' blanks the readouts and shows NO DATA');
  if (lv.leak) check(seenHazard[lv.id + 'leak'], 'mission ' + lv.id + ' loses fuel with the engine mostly off');
}
check(Object.keys(outcomes).filter(k => k.endsWith('i') && outcomes[k] !== 'Touchdown').length === LVN, 'idle flights all end in a failure card');
// 6b. every mission with a hazard explains it in its briefing
for (const lv of win.Sim.LEVELS) {
  if (!lv.hazard) continue;
  fire('l-back'); frames(2); fire('m-levels'); frames(2);
  byId('l-grid').children[lv.id - 1]._l.click.forEach(f => f({})); frames(2);
  if (!/Hazard\./.test(byId('b-how').innerHTML) || !byId('b-how').innerHTML.includes(lv.hazard.slice(0, 20))) { console.log('FAIL: no hazard text in briefing for', lv.id); process.exit(1); }
}
console.log('ok   all ' + win.Sim.LEVELS.filter(l => l.hazard).length + ' hazard briefings show their warning');
// 7. clumsy-player flights: a rough landing (over the limit, legs hold) must show its own card and still count
let roughCard = null, tries = 0;
while (!roughCard && tries++ < 60) {
  fire('l-back'); frames(2); fire('m-levels'); frames(2);
  byId('l-grid').children[0]._l.click.forEach(f => f({})); frames(2);
  fire('b-go'); frames(2);
  const q = [];
  H.ctrl = (s) => { const a = win.Sim.autopilot(s); q.push({ thrust: a.thrust > 0.4 ? 1 : 0, left: a.left, right: a.right }); return q.length > 36 ? q.shift() : { thrust: 0 }; };
  let g2 = 0; while (H.G.mode === 'fly' && g2++ < 60 * 100) frames(1);
  frames(60 * 3); H.ctrl = null;
  if (/Rough landing/.test(byId('r-card').innerHTML)) roughCard = byId('r-card').innerHTML;
}
check(!!roughCard, 'a rough landing card appeared after ' + tries + ' clumsy flights');
check(/grade warn/.test(roughCard) && /no points for a soft touchdown/.test(roughCard) && /Next mission/.test(roughCard), 'rough card explains the penalty and offers the next mission');
const savedRough = JSON.parse(win.localStorage._d['hoverslam.v1']);
check(savedRough.levels['1'] && savedRough.levels['1'].done, 'rough landing still counts as cleared');

// 8. career offers, term billing, insured flights, repeat terms, upgrades and the zero-cash recovery path
fire('m-career'); frames(3);
const careerCard = byId('career-card');
check(visible('career') && /Atlantic recovery/.test(careerCard.innerHTML), 'career opens on the Atlantic chapter');
check((careerCard.innerHTML.match(/class="contract offer"/g) || []).length === 3, 'career board presents three authored offers at a time');
const firstOffer = careerCard.querySelectorAll('[data-contract]').find(b => b.dataset.contract === '1');
firstOffer._l.click.forEach(f => f({})); frames(2);
check(visible('brief') && /Operating cost/.test(byId('b-contract').innerHTML) && /Repair exposure/.test(byId('b-contract').innerHTML) && /Insurance/.test(byId('b-contract').innerHTML), 'career briefing discloses costs, repair cap and insurance');
byId('b-insure').checked = true;
const cashBeforeCareer = H.save.career.cash;
fire('b-go'); frames(2);
const careerDebit = H.G.careerRun.operatingCost + H.G.careerRun.premium;
check(H.G.mode === 'fly' && H.save.career.cash === cashBeforeCareer - careerDebit, 'contract launch charges operations and selected insurance');
H.ctrl = s => win.Sim.autopilot(s);
let careerFrames = 0; while (H.G.mode === 'fly' && careerFrames++ < 60 * 100) frames(1);
frames(60 * 2); H.ctrl = null;
check(visible('result') && H.save.career.contracts['1'] && H.save.career.contracts['1'].done, 'successful career landing pays and records the contract');
check(H.save.ghosts['career:1'] && H.save.ghosts['career:1'].version === 2, 'career best run is saved as a versioned ghost');
fire('r-career'); frames(3);
check(/data-contract="2"/.test(careerCard.innerHTML) && !/<button class="contract offer" data-contract="1"/.test(careerCard.innerHTML), 'cleared offer advances the branch board');
const gearOffer = careerCard.querySelectorAll('[data-upgrade]').find(b => b.dataset.upgrade === 'gear');
const fundsBeforeGear = H.save.career.cash;
check(!!gearOffer && H.buyUpgrade('gear') && H.save.career.upgrades.gear === 1, 'landing gear purchase persists from earned cash ($' + fundsBeforeGear + ' before purchase)');
H.save.career.cash = 0; H.buildCareer();
const recoveryOffer = careerCard.querySelectorAll('[data-contract]').find(b => b.dataset.contract === '46');
recoveryOffer._l.click.forEach(f => f({})); frames(2);
check(H.G.careerRun.recovery && /Operating cost<\/dt><dd>\$0 at launch/.test(byId('b-contract').innerHTML), 'standby recovery contract is available at zero cash');
fire('b-go'); frames(2);
check(H.G.mode === 'fly' && H.save.career.cash === 0, 'recovery launch does not require funds');
H.ctrl = s => win.Sim.autopilot(s);
let rescueFrames = 0; while (H.G.mode === 'fly' && rescueFrames++ < 60 * 100) frames(1);
frames(60 * 2); H.ctrl = null;
check(visible('result') && H.save.career.cash > 0, 'recovery landing restores a positive balance');
console.log('all checks passed; draw calls:', drawCalls);
process.exit(0);
