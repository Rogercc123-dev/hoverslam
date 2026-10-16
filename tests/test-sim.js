// Autopilot beatability test: node test-sim.js [seeds] [levelId]
const Sim = require('../src/sim.js');
const N = +process.argv[2] || 60;
const only = process.argv[3] ? +process.argv[3] : 0;
const TUNE = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};

function run(level, seed, ctrl) {
  const s = Sim.createSim(level, seed, { assist: true });
  let n = 0;
  while (s.status === 'flying' && s.t < 120) {
    const inp = ctrl(s);
    Sim.step(s, inp, Sim.DT);
    n++;
  }
  return s;
}

// Release checks for the three distinct world/vehicle programs and Mars entry.
const byWorld = Object.fromEntries(['earth', 'moon', 'mars'].map(w => [w, Sim.LEVELS.filter(l => l.world === w)]));
if (Sim.G !== 9.81 || byWorld.earth.length !== 23 || byWorld.moon.length !== 11 || byWorld.mars.length !== 11) throw new Error('world catalogue or Earth gravity baseline changed');
if (byWorld.moon.some(l => l.gravity !== 1.62 || l.vehicle !== 'hls') || byWorld.mars.some(l => l.gravity !== 3.71 || l.vehicle !== 'starship' || !l.atmosphericEntry)) throw new Error('planet gravity or vehicle configuration is inconsistent');
const dailyA = Sim.dailyChallenge('2026-10-17'), dailyB = Sim.dailyChallenge('2026-10-17');
if (dailyA.seed !== dailyB.seed || JSON.stringify(dailyA.level) !== JSON.stringify(dailyB.level) || !dailyA.level.stockLoadout) throw new Error('daily seed/loadout is not stable');
const mars = Sim.LEVELS.find(l => l.id === 24), upright = Sim.createSim(mars, 92), broadside = Sim.createSim(mars, 92);
for (const s of [upright, broadside]) { s.y = Sim.FREEBOARD + 5000; s.x = 0; s.vx = 80; s.vy = -180; s.om = 0; s.throttle = 0; }
upright.th = 0; broadside.th = Math.PI / 2;
Sim.step(upright, { thrust: 0 }, Sim.DT); Sim.step(broadside, { thrust: 0 }, Sim.DT);
if (!(broadside.entryLoad > upright.entryLoad)) throw new Error('Mars drag does not respond to Starship attitude');
const entryA = run(mars, 81723, s => Sim.autopilot(s)), entryB = run(mars, 81723, s => Sim.autopilot(s));
if (!entryA.result || !entryA.result.ok || !entryB.result || !entryB.result.ok || entryA.result.score !== entryB.result.score || entryA.t !== entryB.t || !entryA.events.includes('entry-upright')) throw new Error('Mars entry or replay determinism failed');
console.log('release checks: 45 scenarios, planetary configs, angle-dependent Mars drag, fixed daily and deterministic entry passed');

let allOk = true;
for (const lv of Sim.LEVELS) {
  if (only && lv.id !== only) continue;
  let ok = 0, ring = 0, fuelStar = 0, fuelSum = 0, tSum = 0, vnSum = 0;
  const why = {};
  for (let seed = 1; seed <= N; seed++) {
    const s = run(lv, seed * 7919, (st) => Sim.autopilot(st, TUNE));
    if (s.result && s.result.ok) {
      ok++; if (s.result.stars.ring) ring++; if (s.result.stars.fuel) fuelStar++;
      fuelSum += s.result.fuelLeft; tSum += s.t; vnSum += s.result.vn;
    } else {
      const r = s.result ? s.result.reason : 'timeout';
      why[r] = (why[r] || 0) + 1;
    }
  }
  const pct = (100 * ok / N).toFixed(0);
  if (ok / N < (lv.fault ? 0.85 : 0.9)) allOk = false;
  console.log(
    String(lv.id).padStart(2), lv.name.padEnd(12),
    'land', (pct + '%').padStart(4),
    'ring', (ok ? (100 * ring / ok).toFixed(0) : '-').toString().padStart(3) + '%',
    'fuel*', (ok ? (100 * fuelStar / ok).toFixed(0) : '-').toString().padStart(3) + '%',
    'fuelLeft', ok ? (100 * fuelSum / ok).toFixed(0) + '%' : '-',
    't', ok ? (tSum / ok).toFixed(1) + 's' : '-',
    'vn', ok ? (vnSum / ok).toFixed(1) : '-',
    JSON.stringify(why)
  );
}

// sanity: doing nothing and holding thrust must both fail
for (const [name, ctrl] of [['no input', () => ({ thrust: 0 })], ['hold thrust', () => ({ thrust: 1 })]]) {
  let ok = 0, M = 40;
  for (let seed = 1; seed <= M; seed++) {
    const s = run(Sim.LEVELS[0], seed * 31, ctrl);
    if (s.result && s.result.ok) ok++;
  }
  console.log('sanity', name, 'landed', ok + '/' + M);
}
process.exit(allOk ? 0 : 1);
