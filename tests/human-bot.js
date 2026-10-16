// Clumsy-human model: thrust is on or off (no partial throttle), 0.3 s reaction delay, plans come from the autopilot.
// Prints how often such a player lands, how often the landing is rough, and how often each star is earned.
// usage: node tests/human-bot.js [runs] [comma separated mission ids | all]
const Sim = require('../src/sim.js');
const N = +process.argv[2] || 150;
const arg = process.argv[3] || 'all';
const ids = arg === 'all' ? Sim.LEVELS.map(l => l.id) : arg.split(',').map(Number);

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
const pc = (n, d) => (d ? Math.round(100 * n / d) : 0) + '%';
for (const id of ids) {
  const lv = Sim.LEVELS[id - 1];
  let ok = 0, rough = 0, ring = 0, fuel = 0, three = 0, fuelSum = 0;
  const reasons = {};
  for (let i = 1; i <= N; i++) {
    const s = run(lv, i * 104729, Math.round(0.3 / Sim.DT), 0.4);
    const r = s.result || {};
    if (r.ok) {
      ok++; if (r.rough) rough++;
      if (r.stars.ring) ring++; if (r.stars.fuel) fuel++;
      if (r.stars.ring && r.stars.fuel && !r.rough) three++;
      fuelSum += r.fuelLeft;
    } else reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  console.log(String(id).padStart(2), lv.name.padEnd(15), 'land', pc(ok, N).padStart(4), 'rough', pc(rough, ok).padStart(4),
    'ring*', pc(ring, ok).padStart(4), 'fuel*', pc(fuel, ok).padStart(4), '3-star', pc(three, N).padStart(4),
    'fuelLeft', ok ? Math.round(100 * fuelSum / ok) + '%' : '-', 'goal', Math.round(lv.fuelGoal * 100) + '%', JSON.stringify(reasons));
}
