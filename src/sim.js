/* Hoverslam physics, levels, scoring and autopilot. No DOM access: runs in the page and in Node. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- constants
  var G = 9.81;               // m/s^2
  var THRUST = 17.5;          // m/s^2 at full tank and full throttle (divided by mass ratio below)
  var ROT_ACC = 2.8;          // rad/s^2 from cold-gas thrusters
  var ROT_MAX = 1.25;         // rad/s
  var ASSIST_DAMP = 3.2;      // 1/s, stability assist
  var FREEBOARD = 5.0;        // deck height above mean sea level, m
  var LEN = 34, HALF_W = 1.85;
  var FOOT_SPAN = 7.4, FOOT_Y = -17.8;      // legs deployed
  var FOLD_SPAN = 2.4, FOLD_Y = -15.6;      // legs folded
  var LEG_ALT = 260;          // legs start to deploy below this height above the deck, m
  var LEG_TIME = 1.1;         // s
  var DT = 1 / 120;
  var EDGE_MARGIN = 7;        // hull / end towers beyond the pad
  var BODY_PTS = [[0, -17.2], [-HALF_W, -16], [HALF_W, -16], [-HALF_W, 12.5], [HALF_W, 12.5], [0, 14]];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sign(v) { return v < 0 ? -1 : 1; }
  function wrapAngle(v) { v = (v + Math.PI) % (Math.PI * 2); if (v < 0) v += Math.PI * 2; return v - Math.PI; }
  function trackFlip(s, delta) {
    var dir = delta > 0.0001 ? 1 : delta < -0.0001 ? -1 : 0;
    if (!dir) return;
    if (s.flipDirection && dir !== s.flipDirection) s.flipProgress = 0;
    s.flipDirection = dir;
    s.flipProgress += Math.abs(delta);
    if (s.flipProgress >= Math.PI * 2) {
      s.flipProgress -= Math.PI * 2;
      s.flips++;
      s.trickScore += 100;
      s.events.push('flip');
    }
  }

  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- levels
  // alt: start height above the deck (m). dx: start offset range from the ship (m).
  // vx/vy: start speeds. wind: steady push (m/s^2 at altitude, gusts on top). deck: pad width (m).
  // vMax/hMax/aMax/wMax: touchdown limits (m/s down, m/s sideways, rad tilt, rad/s spin).
  function L(o) {
    // hazards: thrust (engine strength), leak (fuel/s lost for free), tiltMin/om0 (start tumbling), vxAway (start moving away),
    // away/zig (ship flees / weaves), shear (altitude where the wind flips), fault {hi, lo, d0, d1} (engine cut-out),
    // blackout [hi, lo] (instrument dropout altitudes), rcsL/rcsR (turn strength each way)
    var d = { vMax: 10, hMax: 6, aMax: 0.3, wMax: 0.9, vx: 6, tilt: 0.12, tiltMin: 0, om0: 0, shipV: 0, away: false, zig: 0, gust: 0, wind: 0, shear: 0,
      swell: 0.6, fuel: 1, burn: 0.0125, thrust: 1, leak: 0, vxAway: false, fault: null, blackout: null, rcsL: 1, rcsR: 1, hazard: '', world: 'earth', vehicle: 'booster' };
    for (var k in o) d[k] = o[k];
    if (d.terrain === 'moon') { d.world = 'moon'; d.vehicle = 'hls'; }
    if (d.terrain === 'mars') { d.world = 'mars'; d.vehicle = 'starship'; }
    d.certification = d.certification || d.id === 22 || d.id === 35 || d.id === 45;
    if (d.atmosphericEntry) d.entryFlipStart = d.entryFlipStart || 2600;
    var risk = d.atmosphericEntry || d.fault || d.blackout || d.away || d.vxAway ? 3 : (d.gust > 0.9 || d.deck < 65 || d.leak ? 2 : 1);
    var objectiveType = d.id % 3 === 0 ? 'fuel' : d.id % 3 === 1 ? 'ring' : 'soft';
    d.contract = d.contract || {
      baseReward: Math.round(245 + d.id * 9 + d.alt * 0.018 + risk * 42),
      operatingCost: Math.round(38 + d.alt * 0.025 + risk * 24),
      repairCap: Math.round(180 + d.alt * 0.035 + risk * 45),
      insurancePremium: Math.round(38 + risk * 14), insuranceCoverage: 0.72,
      reputation: risk, objectiveBonus: 85 + risk * 25, risk: risk,
      objectiveType: objectiveType,
      optionalObjective: d.certification ? 'Qualification: clean touchdown inside the ring with fuel remaining' : objectiveType === 'fuel' ? 'Preserve the marked fuel reserve' : objectiveType === 'soft' ? 'Complete a clean, non-rough touchdown' : 'Touch down inside the landing ring'
    };
    d.fuel *= 0.9 * 0.82;
    if (d.fuelGoal !== undefined) d.fuelGoal *= 0.9 * 0.82;
    d.ring = o.ring || Math.max(7, d.deck * 0.14);
    return d;
  }
  var LEVELS = [
    L({ id: 1, name: 'First Light', sky: 'dawn', blurb: 'Calm water and a wide deck. Learn when to light the engine.', alt: 900, dx: [40, 140], vx: 4, vy: -35, tilt: 0.1, deck: 92, swell: 0.6, burn: 0.0125, fuelGoal: 0.72 }),
    L({ id: 2, name: 'Open Water', sky: 'day', blurb: 'A light breeze. The deck rises and falls with the swell.', alt: 1000, dx: [80, 200], vx: 6, vy: -40, deck: 86, swell: 0.9, wind: 0.5, gust: 0.2, burn: 0.0135, fuelGoal: 0.7 }),
    L({ id: 3, name: 'Crosswind', sky: 'day', blurb: 'Steady wind from the side pushes you off line. Lean into it.', alt: 1000, dx: [100, 220], vx: 7, vy: -40, tilt: 0.15, deck: 82, swell: 1.0, wind: 1.3, gust: 0.5, burn: 0.014, fuelGoal: 0.68 }),
    L({ id: 4, name: 'Long Swell', sky: 'dusk', blurb: 'Big rolling swell. Match your tilt to the tilt of the deck.', alt: 1000, dx: [80, 200], vx: 7, vy: -42, deck: 80, swell: 1.8, wind: 0.6, gust: 0.3, burn: 0.0145, fuelGoal: 0.68 }),
    L({ id: 5, name: 'Under Way', sky: 'day', blurb: 'The ship is making way. Aim where it will be, not where it is.', alt: 1000, dx: [60, 200], vx: 7, vy: -42, deck: 78, swell: 1.2, wind: 0.8, gust: 0.3, shipV: 2.5, burn: 0.015, fuelGoal: 0.72 }),
    L({ id: 6, name: 'Gusts', sky: 'dusk', blurb: 'The wind keeps changing its mind. Stay loose on the controls.', alt: 1000, dx: [80, 220], vx: 8, vy: -44, deck: 74, swell: 1.6, wind: 1.4, gust: 1.0, shipV: 2, burn: 0.015, fuelGoal: 0.7, ring: 9, vMax: 9, hMax: 5.5, aMax: 0.27 }),
    L({ id: 7, name: 'Short Deck', sky: 'dawn', blurb: 'A smaller pad. There is no room to be a little off.', alt: 1000, dx: [60, 180], vx: 6, vy: -42, deck: 60, swell: 1.2, wind: 0.8, gust: 0.3, burn: 0.015, fuelGoal: 0.72, ring: 8, vMax: 9, hMax: 5.5, aMax: 0.27 }),
    L({ id: 8, name: 'Night Shift', sky: 'night', blurb: 'Dark, rough and windy. Trust the instruments.', alt: 1000, dx: [80, 220], vx: 8, vy: -44, deck: 66, swell: 1.8, wind: 1.6, gust: 0.8, shipV: 1.5, burn: 0.0155, fuelGoal: 0.7, ring: 8, vMax: 9, hMax: 5.5, aMax: 0.27 }),
    L({ id: 9, name: 'Low Tank', sky: 'day', blurb: 'Under half a tank. Hovering is a luxury you cannot afford.', hazard: 'Fuel is tight. Burn in pulses and save some for the last 100 metres.', alt: 950, dx: [60, 180], vx: 6, vy: -42, deck: 76, swell: 1.4, wind: 1.0, gust: 0.4, fuel: 0.45, burn: 0.0135, fuelGoal: 0.22, ring: 8, vMax: 9, hMax: 5.5, aMax: 0.27 }),
    L({ id: 10, name: 'Runaway', sky: 'day', blurb: 'The ship has spotted you and is steaming away.', hazard: 'The ship sails away from you the whole way down. Start chasing it early.', alt: 1100, dx: [90, 200], vx: 6, vy: -44, deck: 70, swell: 1.4, wind: 0.8, gust: 0.4, shipV: 5, away: true, fuel: 0.85, burn: 0.0155, fuelGoal: 0.54, ring: 7, vMax: 8.5, hMax: 5, aMax: 0.26 }),
    L({ id: 11, name: 'Tumble', sky: 'dusk', blurb: 'Separation went wrong. You are nearly sideways and spinning.', hazard: 'You start almost horizontal and spinning. Get upright before the speed builds.', alt: 1150, dx: [60, 160], vx: 5, vy: -40, tiltMin: 1.0, tilt: 1.35, om0: 0.7, deck: 72, swell: 1.6, wind: 0.8, gust: 0.4, fuel: 0.9, burn: 0.0155, fuelGoal: 0.59, ring: 7, vMax: 8.5, hMax: 5, aMax: 0.26 }),
    L({ id: 12, name: 'Shear', sky: 'storm', blurb: 'Rough air up high, and something odd near the water.', hazard: 'The wind flips direction low down. What pushed you left now pushes you right.', alt: 1000, dx: [80, 220], vx: 9, vy: -46, deck: 64, swell: 2.4, wind: 1.4, gust: 1.8, shear: 380, fuel: 0.75, burn: 0.0155, fuelGoal: 0.48, ring: 6.5, vMax: 8, hMax: 5, aMax: 0.25 }),
    L({ id: 13, name: 'Long Shot', sky: 'dawn', blurb: 'Way out on the edge of the recovery zone, and heading further out.', hazard: 'You start hundreds of metres away, drifting the wrong way. Turn around early.', alt: 1500, dx: [380, 520], vx: 14, vxAway: true, vy: -40, deck: 66, swell: 1.2, wind: 0.6, gust: 0.3, shipV: 1.5, fuel: 0.9, burn: 0.0155, fuelGoal: 0.56, ring: 7, vMax: 8, hMax: 5, aMax: 0.25 }),
    L({ id: 14, name: 'Flameout', sky: 'night', blurb: 'Something in the engine bay is not right.', hazard: 'The engine can cut out for a couple of seconds during your descent. Do not leave your burn too late.', alt: 1000, dx: [80, 200], vx: 7, vy: -48, deck: 70, swell: 1.6, wind: 0.8, gust: 0.4, shipV: 1.5, fault: { hi: 540, lo: 340, d0: 1.4, d1: 2.0 }, fuel: 0.9, burn: 0.0155, fuelGoal: 0.63, ring: 6.5, vMax: 8, hMax: 5, aMax: 0.25 }),
    L({ id: 15, name: 'Hot Drop', sky: 'day', blurb: 'You are coming in fast and late. Light the engine early.', hazard: 'Very high entry speed. The burn has to start much earlier than feels right.', alt: 760, dx: [60, 160], vx: 6, vy: -72, deck: 60, swell: 1.6, wind: 1.0, gust: 0.5, fuel: 0.6, burn: 0.0155, fuelGoal: 0.39, ring: 6, vMax: 7.5, hMax: 4.5, aMax: 0.24 }),
    L({ id: 16, name: 'Needle', sky: 'night', blurb: 'The smallest pad you will ever see from this high up.', hazard: 'A very small pad and a ship that keeps creeping along.', alt: 1000, dx: [60, 160], vx: 6, vy: -44, deck: 46, swell: 1.5, wind: 0.8, gust: 0.4, shipV: 2, fuel: 0.8, burn: 0.0155, fuelGoal: 0.55, ring: 5, vMax: 8, hMax: 5, aMax: 0.25 }),
    L({ id: 17, name: 'Heavy Haul', sky: 'day', blurb: 'The payload is still on board. Everything takes longer.', hazard: 'Weak engine: you can barely out-push gravity. Brake much earlier, and do not waste thrust.', alt: 1000, dx: [80, 200], vx: 7, vy: -42, deck: 66, swell: 1.6, wind: 1.0, gust: 0.5, thrust: 0.78, fuel: 0.9, burn: 0.0155, fuelGoal: 0.53, ring: 6, vMax: 7.5, hMax: 4.5, aMax: 0.24 }),
    L({ id: 18, name: 'Sticky Thruster', sky: 'dusk', blurb: 'One of the cold-gas thrusters is clogged.', hazard: 'The booster turns right much more slowly than left. Plan your turns early.', alt: 1000, dx: [80, 220], vx: 8, vy: -44, tiltMin: 0.25, tilt: 0.5, deck: 66, swell: 1.8, wind: 1.4, gust: 0.8, rcsR: 0.6, fuel: 0.85, burn: 0.0155, fuelGoal: 0.59, ring: 6, vMax: 7.5, hMax: 4.5, aMax: 0.24 }),
    L({ id: 19, name: 'Leaky Tank', sky: 'dawn', blurb: 'There is a hole in the tank and fuel is pouring out.', hazard: 'Fuel drains steadily even when the engine is off. Do not hang about.', alt: 1000, dx: [80, 200], vx: 7, vy: -46, deck: 66, swell: 1.6, wind: 1.0, gust: 0.5, shipV: 2, leak: 0.0045, fuel: 0.75, burn: 0.0155, fuelGoal: 0.41, ring: 6, vMax: 7.5, hMax: 4.5, aMax: 0.24 }),
    L({ id: 20, name: 'Evasive', sky: 'day', blurb: 'The captain is zigzagging to dodge the swell. Good luck.', hazard: 'The ship weaves left and right at speed. Match its sideways speed or you will skid.', alt: 1000, dx: [60, 180], vx: 7, vy: -44, deck: 66, swell: 2.8, wind: 0.8, gust: 0.5, shipV: 6.5, zig: 0.4, fuel: 0.85, burn: 0.0155, fuelGoal: 0.58, ring: 6, vMax: 7.5, hMax: 4.2, aMax: 0.22 }),
    L({ id: 21, name: 'Blackout', sky: 'night', blurb: 'A storm and a failing instrument panel.', hazard: 'Your readouts and guidance drop out for a few seconds near the end. Trust your eyes.', alt: 1000, dx: [80, 220], vx: 8, vy: -46, deck: 62, swell: 2.4, wind: 1.4, gust: 1.4, shipV: 2.5, blackout: [460, 160], fuel: 0.8, burn: 0.0155, fuelGoal: 0.54, ring: 5.5, vMax: 7, hMax: 4.2, aMax: 0.22 }),
    L({ id: 22, name: 'Hoverslam', sky: 'night', blurb: 'Everything at once. One burn, no mistakes.', hazard: 'Tumbling start, a fleeing ship, a weak engine that can cut out, a gale and a tiny pad.', alt: 1150, dx: [80, 180], vx: 7, vy: -56, tiltMin: 0.6, tilt: 1.1, om0: 0.5, deck: 50, swell: 2.4, wind: 1.6, gust: 1.0, shipV: 3.5, away: true, thrust: 0.92, fault: { hi: 520, lo: 340, d0: 1.2, d1: 1.8 }, fuel: 0.72, burn: 0.0158, fuelGoal: 0.45, ring: 5, vMax: 6.5, hMax: 4, aMax: 0.2 }),
    L({ id: 23, name: 'Mare Tranquillitatis', sky: 'moon', terrain: 'moon', gravity: 1.62, padName: 'M-04', blurb: 'A quiet touchdown in Mare Tranquillitatis. Low gravity stretches every correction.', alt: 620, dx: [85, 210], vx: 5, vy: -25, deck: 68, swell: 0, wind: 0, gust: 0, shipV: 0, fuel: 0.58, burn: 0.012, fuelGoal: 0.31, ring: 7, vMax: 7, hMax: 4.5, aMax: 0.24 }),
    L({ id: 24, name: 'Red Horizon', sky: 'mars', world: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'A-12', blurb: 'The first Starship landing at Ares. Ride the Martian air broadside, then flip upright in the marked window.', hazard: 'BELLY-FLOP ENTRY: keep the ship broadside above 2,600 m. Rotate upright before the low-altitude deadline, then brake for the pad.', alt: 8200, dx: [55, 125], vx: 8, vy: -220, tiltMin: 1.2, tilt: 1.6, deck: 164, swell: 0, wind: 0.35, gust: 0.12, shipV: 0, fuel: 1.18, burn: 0.014, fuelGoal: 0.38, ring: 18, vMax: 8, hMax: 5, aMax: 0.25, entryFlipStart: 2600, entryFailAlt: 500 }),
    L({ id: 25, name: 'Black Squall', sky: 'stormNight', blurb: 'A night recovery in a hard squall. Rain, crosswind and a rolling deck.', hazard: 'Storm gusts reverse near the surface. Keep fuel for the last correction.', alt: 980, dx: [90, 220], vx: 9, vy: -48, deck: 58, swell: 2.4, wind: 1.5, gust: 1.45, shear: 340, shipV: 2.2, fuel: 0.68, burn: 0.0155, fuelGoal: 0.4, ring: 5.5, vMax: 7, hMax: 4.2, aMax: 0.22 }),
    L({ id: 26, name: 'South Pole Shadow', sky: 'moon', terrain: 'moon', world: 'moon', vehicle: 'hls', gravity: 1.62, padName: 'SHACKLETON', blurb: 'Land beside the shadow line at Shackleton crater. The low sun hides the pad edge.', alt: 760, dx: [110, 240], vx: 7, vy: -31, deck: 72, fuel: 0.82, burn: 0.0108, fuelGoal: 0.4, ring: 9, vMax: 6.5, hMax: 4.2, aMax: 0.23, swell: 0 }),
    L({ id: 27, name: 'HLS Hover Test', sky: 'moon', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'M-07', blurb: 'A precision test for the HLS landing engines. The pad is deliberately narrow.', alt: 540, dx: [70, 155], vx: 4, vy: -24, deck: 54, fuel: 0.72, burn: 0.0105, fuelGoal: 0.34, ring: 6, vMax: 5.8, hMax: 3.8, aMax: 0.2, swell: 0 }),
    L({ id: 28, name: 'Rille Crossing', sky: 'dusk', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'RILLE 3', blurb: 'A long diagonal hop across a shallow lunar rille. Arrive with almost no sideways drift.', alt: 930, dx: [220, 360], vx: 10, vy: -28, deck: 76, fuel: 0.91, burn: 0.011, fuelGoal: 0.45, ring: 10, vMax: 6.5, hMax: 4, aMax: 0.22, swell: 0 }),
    L({ id: 29, name: 'Regolith Freight', sky: 'night', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'CARGO 2', blurb: 'The cargo mass slows the HLS response. Give every correction time to build.', alt: 680, dx: [100, 215], vx: 6, vy: -27, deck: 78, thrust: 0.82, fuel: 0.88, burn: 0.0115, fuelGoal: 0.42, ring: 10, vMax: 6.2, hMax: 4.5, aMax: 0.23, swell: 0 }),
    L({ id: 30, name: 'Farside Relay', sky: 'moon', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'RELAY 9', blurb: 'The relay site is on the far side. A narrow approach corridor leaves little room to drift.', alt: 1050, dx: [300, 430], vx: 12, vy: -30, deck: 64, fuel: 0.9, burn: 0.0115, fuelGoal: 0.4, ring: 7, vMax: 6, hMax: 3.8, aMax: 0.21, swell: 0 }),
    L({ id: 31, name: 'Dustless Night', sky: 'night', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'M-12', blurb: 'A sunless approach lit only by the landing beacons and your instruments.', alt: 840, dx: [120, 255], vx: 8, vy: -30, deck: 66, fuel: 0.8, burn: 0.011, fuelGoal: 0.38, ring: 8, vMax: 6, hMax: 4.2, aMax: 0.22, swell: 0 }),
    L({ id: 32, name: 'Crater Rim', sky: 'dawn', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'RIM 1', blurb: 'The pad sits close to a crater rim. Keep the landing legs square to the surface.', alt: 720, dx: [80, 200], vx: 5, vy: -35, deck: 58, fuel: 0.94, burn: 0.011, fuelGoal: 0.46, ring: 6.5, vMax: 5.8, hMax: 4, aMax: 0.2, swell: 0 }),
    L({ id: 33, name: 'Cold Restart', sky: 'moon', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'HLS-B', blurb: 'A descent engine pauses briefly during the braking arc. Save room for the relight.', alt: 890, dx: [130, 260], vx: 7, vy: -34, deck: 70, fault: { hi: 410, lo: 280, d0: 1, d1: 1.5 }, fuel: 0.91, burn: 0.011, fuelGoal: 0.42, ring: 8, vMax: 6, hMax: 4, aMax: 0.21, swell: 0 }),
    L({ id: 34, name: 'Cargo Beacon', sky: 'dusk', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'BEACON 4', blurb: 'A beacon marks the centre of a broad cargo pad. Reach it without wasting the reserve.', alt: 780, dx: [105, 210], vx: 6, vy: -32, deck: 84, fuel: 0.69, burn: 0.0105, fuelGoal: 0.28, ring: 12, vMax: 6.4, hMax: 4.4, aMax: 0.23, swell: 0 }),
    L({ id: 35, name: 'HLS Certification', sky: 'moon', terrain: 'moon', gravity: 1.62, vehicle: 'hls', padName: 'CERT PAD', blurb: 'Final lunar qualification: a small target, an offset approach and a tight reserve.', alt: 1120, dx: [260, 390], vx: 11, vy: -36, deck: 60, fuel: 0.89, burn: 0.0115, fuelGoal: 0.4, ring: 6.5, vMax: 5.6, hMax: 3.7, aMax: 0.19, swell: 0 }),
    L({ id: 36, name: 'Ares Lowlands', sky: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'A-18', blurb: 'First cargo arrival in the Ares lowlands. Hold the broadside through peak drag, then flip.', alt: 9000, dx: [70, 145], vx: 9, vy: -225, tiltMin: 1.2, tilt: 1.7, deck: 170, fuel: 1.2, burn: 0.014, fuelGoal: 0.4, ring: 20, vMax: 8, hMax: 5, aMax: 0.25, entryFlipStart: 2700, entryFailAlt: 500 }),
    L({ id: 37, name: 'Valles Approach', sky: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'V-02', blurb: 'A long approach above Valles Marineris. The extra horizontal speed makes the flip timing matter.', alt: 9800, dx: [95, 180], vx: 11, vy: -240, tiltMin: 1.25, tilt: 1.7, deck: 186, fuel: 1.25, burn: 0.0145, fuelGoal: 0.39, ring: 22, vMax: 8.5, hMax: 5.2, aMax: 0.25, entryFlipStart: 3000, entryFailAlt: 650 }),
    L({ id: 38, name: 'Olympus Cargo', sky: 'dusk', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'OLYMPUS 1', blurb: 'A heavy cargo ship enters above the high plateau, where the thinner air gives less braking help.', alt: 11000, dx: [85, 160], vx: 9, vy: -255, tiltMin: 1.25, tilt: 1.65, deck: 190, thrust: 0.85, fuel: 1.34, burn: 0.015, fuelGoal: 0.38, ring: 24, vMax: 9, hMax: 5.5, aMax: 0.26, entryDensity: 0.000095, entryFlipStart: 3200, entryFailAlt: 700 }),
    L({ id: 39, name: 'Night-side Flip', sky: 'night', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'NIGHT 6', blurb: 'A night-side arrival with only the approach lights to frame the flip corridor.', alt: 8600, dx: [55, 130], vx: 8, vy: -220, tiltMin: 1.2, tilt: 1.7, deck: 158, fuel: 1.19, burn: 0.014, fuelGoal: 0.39, ring: 18, vMax: 8, hMax: 5, aMax: 0.24, entryFlipStart: 2600, entryFailAlt: 520 }),
    L({ id: 40, name: 'Crosswind Aerobrake', sky: 'storm', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'A-24', blurb: 'A high crosswind builds during the belly-flop. Keep the landing zone aligned before the flip.', alt: 9600, dx: [75, 150], vx: 9, vy: -235, wind: 0.35, gust: 0.2, tiltMin: 1.2, tilt: 1.65, deck: 172, fuel: 1.25, burn: 0.0145, fuelGoal: 0.39, ring: 21, vMax: 8.5, hMax: 5, aMax: 0.24, entryFlipStart: 2900, entryFailAlt: 620 }),
    L({ id: 41, name: 'Engine Relight', sky: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'A-31', blurb: 'A descent-engine relight fault is expected during the flip. Keep the transition controlled.', alt: 9000, dx: [65, 140], vx: 8, vy: -230, tiltMin: 1.2, tilt: 1.7, deck: 168, fault: { hi: 970, lo: 780, d0: 1.1, d1: 1.5 }, fuel: 1.28, burn: 0.014, fuelGoal: 0.38, ring: 20, vMax: 8.2, hMax: 5, aMax: 0.24, entryFlipStart: 2800, entryFailAlt: 650 }),
    L({ id: 42, name: 'Dust Front', sky: 'dusk', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'DUST 3', blurb: 'A dusty front masks the pad until late. Use the entry marker and start the flip on altitude.', alt: 9400, dx: [80, 150], vx: 8, vy: -240, tiltMin: 1.25, tilt: 1.7, deck: 176, fuel: 1.28, burn: 0.0145, fuelGoal: 0.4, ring: 21, vMax: 8.3, hMax: 5.2, aMax: 0.24, entryDensity: 0.00014, entryFlipStart: 2850, entryFailAlt: 600 }),
    L({ id: 43, name: 'Narrow Survey Pad', sky: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'SURVEY 8', blurb: 'The survey pad is narrow for a Starship. Bleed off sideways speed before committing to the flip.', alt: 10000, dx: [90, 165], vx: 10, vy: -245, tiltMin: 1.2, tilt: 1.65, deck: 142, fuel: 1.34, burn: 0.0145, fuelGoal: 0.39, ring: 16, vMax: 8, hMax: 4.5, aMax: 0.23, entryFlipStart: 3000, entryFailAlt: 650 }),
    L({ id: 44, name: 'Phobos Window', sky: 'night', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'PHOBOS 2', blurb: 'A moonset shadow crosses the pad while the ship rotates from belly-flop to vertical.', alt: 9200, dx: [75, 150], vx: 9, vy: -235, tiltMin: 1.2, tilt: 1.7, deck: 170, fuel: 1.29, burn: 0.014, fuelGoal: 0.4, ring: 20, vMax: 8.2, hMax: 5, aMax: 0.24, entryFlipStart: 2780, entryFailAlt: 620 }),
    L({ id: 45, name: 'Starship Certification', sky: 'mars', terrain: 'mars', vehicle: 'starship', atmosphericEntry: true, gravity: 3.71, padName: 'CERT PAD', blurb: 'Final Mars certification: heavy entry, a compact landing zone and a short powered descent.', alt: 10800, dx: [100, 175], vx: 11, vy: -250, tiltMin: 1.25, tilt: 1.72, deck: 150, thrust: 0.9, fuel: 1.32, burn: 0.015, fuelGoal: 0.39, ring: 17, vMax: 7.8, hMax: 4.5, aMax: 0.22, entryFlipStart: 3100, entryFailAlt: 700 })
  ];

  // ---------------------------------------------------------------- environment
  function swellH(lv, x, t) {
    var A = lv.swell;
    if (!A) return 0;
    return A * (Math.sin(x * 0.0571 - t * 0.78) + 0.3 * Math.sin(x * 0.134 - t * 1.25 + 1.3));
  }
  function swellSlope(lv, x, t) {
    var A = lv.swell;
    if (!A) return 0;
    return A * (0.0571 * Math.cos(x * 0.0571 - t * 0.78) + 0.3 * 0.134 * Math.cos(x * 0.134 - t * 1.25 + 1.3));
  }
  function swellVel(lv, x, t) {
    var A = lv.swell;
    if (!A) return 0;
    return A * (-0.78 * Math.cos(x * 0.0571 - t * 0.78) - 0.3 * 1.25 * Math.cos(x * 0.134 - t * 1.25 + 1.3));
  }

  // wind push (m/s^2): strongest up high, weaker in the boundary layer near the water
  function windAccel(s, y, t) {
    if (t === undefined) t = s.t;
    var lv = s.level;
    var g = lv.gust * (0.6 * Math.sin(0.55 * t + s.wp1) + 0.4 * Math.sin(1.7 * t + s.wp2));
    var f = 0.3 + 0.7 * (1 - Math.exp(-Math.max(y, 0) / 300));
    var m = 1;
    if (lv.shear) m = 1 - 2.3 * clamp((lv.shear * 1.2 - y) / (lv.shear * 0.4), 0, 1);   // flips to -1.3 below the shear line
    return (s.wind0 + g) * f * m;
  }
  function dragK(y) { return 0.00045 * Math.exp(-Math.max(y, 0) / 3500); }

  function deckPose(s) {
    var lv = s.level, xs = s.ship.x, t = s.t;
    var slope = swellSlope(lv, xs, t);
    var phi = Math.atan(slope * 0.5);
    var vs = s.ship.vNow;
    return {
      x: xs,
      y: FREEBOARD + swellH(lv, xs, t),
      phi: phi,
      c: Math.cos(phi), sn: Math.sin(phi),
      vx: vs,
      vy: swellVel(lv, xs, t) + slope * vs
    };
  }
  function toDeck(D, px, py) {
    var rx = px - D.x, ry = py - D.y;
    return { u: rx * D.c + ry * D.sn, v: -rx * D.sn + ry * D.c };
  }
  function toWorld(s, lx, ly) {
    var c = Math.cos(s.th), sn = Math.sin(s.th);
    return { x: s.x + lx * c - ly * sn, y: s.y + lx * sn + ly * c };
  }
  function legGeom(d) {
    var e = d * d * (3 - 2 * d);
    return { span: FOLD_SPAN + (FOOT_SPAN - FOLD_SPAN) * e, fy: FOLD_Y + (FOOT_Y - FOLD_Y) * e };
  }
  function feet(s, deployed) {
    var g = legGeom(deployed ? 1 : s.legs);
    return [toWorld(s, -g.span, g.fy), toWorld(s, g.span, g.fy)];
  }
  function altitude(s, D) {
    D = D || deckPose(s);
    var f = feet(s, true);
    return Math.min(toDeck(D, f[0].x, f[0].y).v, toDeck(D, f[1].x, f[1].y).v);
  }
  function massRatio(s) { return 0.7 + 0.3 * s.fuel; }
  function gravity(s) { return s.level.gravity || G; }
  function maxAccel(s) { return THRUST * s.level.thrust / massRatio(s); }
  function dragFor(s, y, vx, vy) {
    var speed = Math.sqrt(vx * vx + vy * vy);
    if (!s.level.atmosphericEntry) return { ax: -dragK(y) * speed * vx, ay: -dragK(y) * speed * vy, load: 0 };
    var broadside = 1 - Math.abs(Math.cos(wrapAngle(s.th)));
    var factor = 0.32 + 1.25 * broadside;
    var k = (s.level.entryDensity || 0.00012) * Math.exp(-Math.max(y, 0) / (s.level.entryScale || 10000)) * factor;
    var mag = k * speed * speed;
    return { ax: -k * speed * vx, ay: -k * speed * vy, load: clamp(mag / 22, 0, 1) };
  }

  function dailyChallenge(date) {
    date = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
    var h = 2166136261;
    for (var i = 0; i < date.length; i++) { h ^= date.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    // Daily flights are always a stock vehicle with a fixed assist setting. The
    // date selects the scenario; career upgrades never enter this function.
    var level = {}, base = LEVELS[h % LEVELS.length];
    Object.keys(base).forEach(function (k) { level[k] = base[k]; });
    level.id = 1000 + (h % LEVELS.length); level.name = 'Daily Flight'; level.blurb = 'One shared, seeded descent. Same conditions for every pilot today.';
    level.stockLoadout = true;
    return { date: date, seed: h || 1, level: level };
  }

  // ---------------------------------------------------------------- creation
  function createSim(level, seed, opts) {
    opts = opts || {};
    var r = rng(seed || 1);
    var s = {
      level: level, seed: seed || 1, t: 0, status: 'flying', result: null, events: [],
      assist: opts.assist !== false,
      wind0: (r() < 0.5 ? -1 : 1) * level.wind, wp1: r() * 6.28, wp2: r() * 6.28,
      ship: { x: 0, v: (r() < 0.5 ? -1 : 1) * level.shipV, vNow: 0, ph: r() * 6.28 },
      fuel: level.fuel, throttle: 0, legs: 0, legsStarted: false, rot: 0, om: 0,
      land: null, burnTime: 0, flipDirection: 0, flipProgress: 0, flips: 0, trickScore: 0,
      entryPhase: level.atmosphericEntry ? 'bellyflop' : null, entryLoad: 0
    };
    s.ship.vNow = s.ship.v;
    var dxAbs = level.dx[0] + (level.dx[1] - level.dx[0]) * r();
    s.x = (r() < 0.5 ? -1 : 1) * dxAbs;
    s.y = FREEBOARD + level.alt;
    s.vx = (r() * 2 - 1) * level.vx;
    s.vy = level.vy;
    var tu = r() * 2 - 1;
    s.th = (tu < 0 ? -1 : 1) * (level.tiltMin + (level.tilt - level.tiltMin) * Math.abs(tu));
    if (level.vxAway) s.vx = (s.x < 0 ? -1 : 1) * level.vx * (0.8 + 0.4 * r());
    if (level.away) { s.ship.v = -(s.x < 0 ? -1 : 1) * level.shipV; s.ship.vNow = s.ship.v; }
    if (level.om0) s.om = (r() < 0.5 ? -1 : 1) * level.om0;
    if (level.fault) s.fault = { at: level.fault.lo + (level.fault.hi - level.fault.lo) * r(), dur: level.fault.d0 + (level.fault.d1 - level.fault.d0) * r(), state: 'armed', until: 0 };
    s.engineOut = false; s.blackout = false;
    return s;
  }

  // ---------------------------------------------------------------- stepping
  function advanceTime(s, dt) {
    s.t += dt;
    var lv = s.level;
    s.ship.vNow = lv.zig ? lv.shipV * Math.sin(lv.zig * s.t + s.ship.ph) : s.ship.v * (1 + 0.2 * Math.sin(0.5 * s.t + s.ship.ph));
    s.ship.x += s.ship.vNow * dt;
  }

  function step(s, inp, dt) {
    var lv = s.level;
    advanceTime(s, dt);

    if (s.status === 'landed') { settle(s, dt); return; }
    if (s.status !== 'flying') return;

    // throttle spool
    var target = s.fuel > 0 ? clamp(inp.thrust || 0, 0, 1) : 0;
    var rate = target > s.throttle ? 4.5 : 6;
    s.throttle += clamp(target - s.throttle, -rate * dt, rate * dt);
    if (s.fuel <= 0) s.throttle = 0;

    // engine cut-out
    if (s.fault) {
      var F = s.fault;
      if (F.state === 'armed' && s.alt !== undefined && s.alt < F.at) { F.state = 'active'; F.until = s.t + F.dur; s.engineOut = true; s.events.push('fault'); }
      else if (F.state === 'active' && s.t >= F.until) { F.state = 'done'; s.engineOut = false; s.events.push('relight'); }
      if (s.engineOut) s.throttle = 0;
    }

    // attitude
    var rot = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    s.rot = rot;
    s.om += ROT_ACC * (rot > 0 ? lv.rcsL : lv.rcsR) * rot * dt;
    s.om *= Math.exp(-(rot === 0 && s.assist ? ASSIST_DAMP : 0.1) * dt);
    s.om = clamp(s.om, -ROT_MAX, ROT_MAX);
    var previousTh = s.th;
    s.th += s.om * dt;
    trackFlip(s, s.th - previousTh);

    // forces
    var aT = maxAccel(s) * s.throttle;
    var drag = dragFor(s, s.y, s.vx, s.vy);
    var ax = -Math.sin(s.th) * aT + windAccel(s, s.y) + drag.ax;
    var ay = Math.cos(s.th) * aT - gravity(s) + drag.ay;
    s.entryLoad = drag.load;
    s.vx += ax * dt; s.vy += ay * dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.fuel = Math.max(0, s.fuel - (lv.burn * s.throttle + lv.leak) * dt);
    if (s.throttle > 0.05) s.burnTime += dt;

    var D = deckPose(s);
    s.D = D;
    var alt = altitude(s, D);
    s.alt = alt;
    if (lv.atmosphericEntry) {
      if (s.entryPhase === 'bellyflop' && alt <= lv.entryFlipStart) { s.entryPhase = 'flip-window'; s.events.push('entry-flip-window'); }
      if (s.entryPhase === 'flip-window' && Math.abs(wrapAngle(s.th)) <= 0.28) { s.entryPhase = 'powered'; s.events.push('entry-upright'); }
      if (s.entryPhase !== 'powered' && alt <= (lv.entryFailAlt || 500)) return finish(s, D, 'entry', toDeck(D, s.x, s.y).u);
    }
    if (lv.blackout) s.blackout = alt < lv.blackout[0] && alt > lv.blackout[1];

    // landing legs
    if (!s.legsStarted && alt < LEG_ALT) { s.legsStarted = true; s.events.push('legs'); }
    if (s.legsStarted) s.legs = Math.min(1, s.legs + dt / (lv.legTime || LEG_TIME));

    if (alt > 40 && s.y > 60) return;   // nothing to hit up here

    // contacts
    var W2 = lv.deck / 2;
    var fp = feet(s, false), q0 = toDeck(D, fp[0].x, fp[0].y), q1 = toDeck(D, fp[1].x, fp[1].y);
    var qs = [q0, q1];
    var touch = -1;
    for (var i = 0; i < 2; i++) {
      if (qs[i].v <= 0 && Math.abs(qs[i].u) <= W2 + EDGE_MARGIN) { touch = i; break; }
    }
    if (touch >= 0) {
      var other = qs[1 - touch];
      var edge = false;
      if (Math.abs(qs[touch].u) > W2 || Math.abs(other.u) > W2) edge = true;
      return resolveTouch(s, D, edge);
    }
    // body points striking the deck (flipped over) or the sea
    for (var j = 0; j < BODY_PTS.length; j++) {
      var bp = toWorld(s, BODY_PTS[j][0], BODY_PTS[j][1]);
      var qb = toDeck(D, bp.x, bp.y);
      if (qb.v <= 0 && Math.abs(qb.u) <= W2 + EDGE_MARGIN) { return finish(s, D, 'tilt-body', qb.u); }
    }
    var pts = [fp[0], fp[1], toWorld(s, 0, -17.2)];
    for (var k = 0; k < pts.length; k++) {
      if (pts[k].y <= (lv.terrain ? 0 : swellH(lv, pts[k].x, s.t))) {
        var du = toDeck(D, pts[k].x, pts[k].y).u;
        return finish(s, D, lv.terrain ? 'ground' : 'sea', du);
      }
    }
  }

  function resolveTouch(s, D, edge) {
    var lv = s.level;
    var rvx = s.vx - D.vx, rvy = s.vy - D.vy;
    var vn = Math.max(0, -(-rvx * D.sn + rvy * D.c));
    var vt = rvx * D.c + rvy * D.sn;
    var rel = wrapAngle(s.th - D.phi);
    var uc = toDeck(D, s.x, s.y).u;
    var info = { vn: vn, vt: vt, rel: rel, om: s.om, uc: uc, fuelLeft: s.fuel, t: s.t, burnTime: s.burnTime, legs: s.legs };
    if (s.legs < 0.9) return finish(s, D, 'legs', uc, info);
    if (edge) return finish(s, D, 'edge', uc, info);
    var ratios = { hard: vn / lv.vMax, skid: Math.abs(vt) / lv.hMax, tilt: Math.abs(rel) / lv.aMax, spin: Math.abs(s.om) / lv.wMax };
    var worst = 'hard', wr = 0;
    for (var k in ratios) if (ratios[k] > wr) { wr = ratios[k]; worst = k; }
    var rough = false;
    if (wr > 1) {
      var band = { hard: 1.45, skid: 1.4, tilt: 1.3, spin: 1.35 };
      for (var bk in ratios) if (ratios[bk] > band[bk]) return finish(s, D, worst, uc, info);
      rough = true; info.over = worst;
    }

    // success
    var W2 = lv.deck / 2;
    var parts = {
      landing: 1000,
      soft: rough ? 0 : Math.round(600 * clamp(1 - vn / lv.vMax, 0, 1) / 10) * 10,
      centre: Math.round(600 * clamp(1 - Math.abs(uc) / W2, 0, 1) / 10) * 10,
      fuel: Math.round(800 * s.fuel / 10) * 10,
      attitude: rough ? 0 : Math.round(200 * clamp(1 - Math.abs(rel) / lv.aMax, 0, 1) / 10) * 10
    };
    parts.trick = s.trickScore;
    var total = parts.landing + parts.soft + parts.centre + parts.fuel + parts.attitude;
    total += parts.trick;
    info.ok = true;
    info.rough = rough;
    info.parts = parts;
    info.score = total;
    info.stars = { land: true, ring: Math.abs(uc) <= lv.ring, fuel: s.fuel >= lv.fuelGoal };
    info.starCount = 1 + (info.stars.ring ? 1 : 0) + (info.stars.fuel ? 1 : 0);
    s.result = info;
    s.status = 'landed';
    s.throttle = 0;
    s.events.push('touch');
    s.land = { u: uc, v: toDeck(D, s.x, s.y).v, vv: -vn * (rough ? 0.6 : 0.35), rel: rel, relv: s.om * 0.4, comp: 0 };
    settle(s, 0);
  }

  function finish(s, D, reason, u, info) {
    info = info || {};
    info.ok = false;
    info.reason = reason;
    info.u = u;
    info.t = s.t;
    info.fuelLeft = s.fuel;
    info.speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    s.result = info;
    s.status = reason === 'sea' ? 'splash' : 'crashed';
    s.events.push(reason === 'sea' ? 'splash' : 'crash');
    s.throttle = 0;
  }

  // the booster rides the deck once it is down: small shock-absorber bounce, then still
  function settle(s, dt) {
    var D = deckPose(s), a = s.land, tgtV = -FOOT_Y;
    if (dt > 0) {
      // damped springs for height and tilt
      a.vv += (-140 * (a.v - tgtV) - 16 * a.vv) * dt;
      a.v += a.vv * dt;
      a.relv += (-90 * a.rel - 12 * a.relv) * dt;
      a.rel += a.relv * dt;
    }
    a.comp = clamp((tgtV - a.v) / 1.2, -0.6, 1.6);
    s.th = D.phi + a.rel;
    s.x = D.x + a.u * D.c - a.v * D.sn;
    s.y = D.y + a.u * D.sn + a.v * D.c;
    s.vx = D.vx; s.vy = D.vy; s.om = 0;
    s.D = D;
    s.alt = 0;
  }

  // ---------------------------------------------------------------- helpers for the interface
  function telemetry(s) {
    var D = s.D || deckPose(s);
    var rvx = s.vx - D.vx, rvy = s.vy - D.vy;
    var alt = s.alt !== undefined ? s.alt : altitude(s, D);
    var q = toDeck(D, s.x, s.y);
    return {
      alt: alt,
      vn: -(-rvx * D.sn + rvy * D.c),         // positive = descending towards the deck
      vt: rvx * D.c + rvy * D.sn,
      rel: wrapAngle(s.th - D.phi),
      dx: s.x - D.x,
      u: q.u,
      fuel: s.fuel,
      wind: windAccel(s, s.y), entryPhase: s.entryPhase, entryLoad: s.entryLoad || 0
    };
  }

  // 0 coast, 1 get ready, 2 burn now
  function burnCue(s) {
    var T = telemetry(s);
    if (T.vn < 12 || s.throttle > 0.4) return 0;
    var g = gravity(s), aNet = Math.max(1, maxAccel(s) * Math.max(0.6, Math.cos(s.th)) - g);
    var d = T.vn * T.vn / (2 * aNet) * (s.level.fault ? 1.4 : 1);
    if (T.alt < d * 1.12) return 2;
    if (T.alt < d * 1.7) return 1;
    return 0;
  }

  // ballistic prediction without thrust: used for the guidance trace
  function predict(s) {
    var pts = [], x = s.x, y = s.y, vx = s.vx, vy = s.vy, t = s.t, dt = 0.2;
    var lv = s.level, hit = null, c = Math.cos(s.th);
    for (var i = 0; i < 160; i++) {
      var drag = dragFor(s, y, vx, vy);
      vx += (windAccel(s, y, t) + drag.ax) * dt;
      vy += (-gravity(s) + drag.ay) * dt;
      x += vx * dt; y += vy * dt; t += dt;
      pts.push({ x: x, y: y });
      var xs = s.ship.x + (lv.zig ? 0 : s.ship.v * (t - s.t));
      if (y - 17.8 * c <= FREEBOARD) {
        hit = { x: x, y: FREEBOARD, t: t - s.t, xs: xs, on: Math.abs(x - xs) <= lv.deck / 2 };
        break;
      }
    }
    return { pts: pts, hit: hit };
  }

  // ---------------------------------------------------------------- autopilot (tests and title-screen demo)
  function autopilot(s, tune) {
    tune = tune || {};
    var lv = s.level, D = deckPose(s);
    var aMax = maxAccel(s);
    var alt = altitude(s, D);
    if (lv.atmosphericEntry && s.entryPhase === 'bellyflop') {
      var bellyTarget = (s.th < 0 ? -1 : 1) * Math.PI / 2;
      var bellyErr = 4 * wrapAngle(bellyTarget - s.th) - s.om;
      return { thrust: 0, left: bellyErr > 0.12, right: bellyErr < -0.12 };
    }
    var dx = s.x - D.x, dvx = s.vx - D.vx, dvy = s.vy - D.vy;
    var cosT = Math.max(0.6, Math.cos(s.th));
    var g = gravity(s), aNet = Math.max(1, aMax * cosT - g);
    var aProf = (tune.prof || 0.5) * aNet;
    var vyd = -(1.4 + Math.sqrt(2 * aProf * Math.max(alt - 2.0, 0)));

    // lateral guidance: close the gap to the ship, arrive with no sideways speed
    var lat = Math.min(tune.maxLat || 24, Math.sqrt(2 * 1.9 * Math.abs(dx)), 0.25 * Math.abs(dx));
    var vxd = -sign(dx) * lat;
    if (alt < 70) vxd = -clamp(0.3 * dx, -3, 3);
    var wcomp = windAccel(s, s.y);
    var axLim = alt > 150 ? 7 : 1.4 + 5.6 * alt / 150;
    var axd = clamp(2.0 * (vxd - dvx) - wcomp, -axLim, axLim);

    var ff = aProf * clamp((alt - 3) / 25, 0, 1);
    var ayTotal = clamp(g + ff + 3.0 * (vyd - dvy), 0, aMax * 1.6);
    var tanMax = Math.tan(0.5);
    var ayAtt = Math.max(ayTotal, 0.9 * g, Math.abs(axd) / tanMax);
    var thD = -Math.atan2(axd, ayAtt);
    var thr;
    if (ayTotal <= 0.01) {
      thr = Math.abs(axd) > (tune.steerBand || 0.9) ? Math.hypot(axd, Math.abs(axd) / tanMax) / aMax : 0;
    } else {
      thr = Math.hypot(axd, Math.max(ayTotal, Math.abs(axd) / tanMax)) / aMax;
    }
    thr = clamp(thr, 0, 1);
    if (Math.abs(wrapAngle(s.th - thD)) > 0.4 && alt > 400) thr = 0;

    var wd = clamp(4.0 * wrapAngle(thD - s.th), -1.0, 1.0);
    var err = wd - s.om;
    return { thrust: thr, left: err > 0.12, right: err < -0.12 };
  }

  var Sim = {
    LEVELS: LEVELS, DT: DT, G: G, LEN: LEN, HALF_W: HALF_W, FREEBOARD: FREEBOARD, EDGE_MARGIN: EDGE_MARGIN,
    FOOT_Y: FOOT_Y, FOOT_SPAN: FOOT_SPAN, FOLD_SPAN: FOLD_SPAN, FOLD_Y: FOLD_Y, ROT_MAX: ROT_MAX, LEG_ALT: LEG_ALT, LEG_TIME: LEG_TIME,
    createSim: createSim, step: step, advanceTime: advanceTime, deckPose: deckPose, toDeck: toDeck, toWorld: toWorld, feet: feet, legGeom: legGeom,
    altitude: altitude, swellH: swellH, swellSlope: swellSlope, windAccel: windAccel,
    telemetry: telemetry, burnCue: burnCue, predict: predict, autopilot: autopilot, maxAccel: maxAccel, rng: rng, dailyChallenge: dailyChallenge
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim; else root.Sim = Sim;
})(typeof self !== 'undefined' ? self : this);
