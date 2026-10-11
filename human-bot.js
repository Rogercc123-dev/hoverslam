// Clumsy-human model: binary thrust (hold or not), 0.3 s reaction delay, thrust decided from the autopilot's plan.
const Sim = require('../src/sim.js');
const N = +process.argv[2] || 150;
const ids = (process.argv[3] || '1,3,6,10,14').split(',').map(Number);
function run(lv, seed, delaySteps, thrustThresh) {
  const s = Sim.createSim(lv, seed, { assist: true });
  const q = [];
  while (s.status === 'flying' && s.t < 120) {
    const a = Sim.autopilot(s);
    q.push({ thrust: a.thrust > thrustThresh ? 1 : 0, left: a.left, right: a.right });
    const inp = q.length > delaySteps ? q.shift() : { thrust: 0 };
    Sim.step(s, inp, Sim.DT);
  }
  return s;
}
for (const id of ids) {
  const lv = Sim.LEVELS[id - 1];
  const vns = [], reasons = {};
  let ok = 0;
  for (let i = 1; i <= N; i++) {
    const s = run(lv, i * 104729, Math.round(0.3 / Sim.DT), 0.4);
    const r = s.result || {};
    if (r.vn !== undefined) vns.push(r.vn);
    if (r.ok) ok++; else reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  vns.sort((a, b) => a - b);
  const pct = p => vns.length ? vns[Math.min(vns.length - 1, Math.floor(p * vns.length))].toFixed(1) : '-';
  console.log('L' + String(id).padStart(2), lv.name.padEnd(12), 'limit', lv.vMax, 'landed', ok + '/' + N, 'vn p25/50/75/90:', pct(.25), pct(.5), pct(.75), pct(.9), JSON.stringify(reasons));
}
