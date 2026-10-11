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
  if (ok / N < 0.9) allOk = false;
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
