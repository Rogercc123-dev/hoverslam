/* Hoverslam interface: rendering, audio, screens, input. Physics lives in sim.js. */
(function () {
  'use strict';
  var Sim = window.Sim, LV = Sim.LEVELS;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var TAU = Math.PI * 2;
  var MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
  var coarse = false;
  try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  // ------------------------------------------------------------------ colours
  function C(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mixA(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function rgba(a, al) { return 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + al + ')'; }

  var THEMES = {
    dawn:  { top: '#0f1b3c', mid: '#6b4f80', low: '#e98a78', hor: '#ffc48b', sea1: '#4b6c92', sea2: '#0f2238', cloud: '#ffd3c2', sun: '#ffe6b0', sunAlt: 50, stars: 0.5, clouds: 26 },
    day:   { top: '#1d58a4', mid: '#4a92d6', low: '#8cc6ee', hor: '#d6edf8', sea1: '#2f8aa8', sea2: '#0b3250', cloud: '#ffffff', sun: '#fffbe0', sunAlt: 420, stars: 0, clouds: 30 },
    dusk:  { top: '#0d1a38', mid: '#7e4a58', low: '#e0774a', hor: '#ffb961', sea1: '#3c5272', sea2: '#0c1626', cloud: '#ffb08a', sun: '#ffd79a', sunAlt: 40, stars: 0.35, clouds: 26 },
    night: { top: '#030610', mid: '#0a1428', low: '#132642', hor: '#21395a', sea1: '#19324f', sea2: '#050b14', cloud: '#2e4160', sun: '#e8f0ff', sunAlt: 360, stars: 1, clouds: 18 },
    storm: { top: '#18222c', mid: '#2c3b47', low: '#4c606c', hor: '#7b909a', sea1: '#3c5663', sea2: '#0e1a22', cloud: '#3a4752', sun: '#aab8c0', sunAlt: 0, stars: 0, clouds: 46 }
  };
  Object.keys(THEMES).forEach(function (k) {
    var t = THEMES[k]; t.id = k;
    t.c = { top: C(t.top), mid: C(t.mid), low: C(t.low), hor: C(t.hor), sea1: C(t.sea1), sea2: C(t.sea2), cloud: C(t.cloud), sun: C(t.sun) };
    t.hl = rgba(mixA(t.c.hor, t.c.low, 0.45), 1);
  });

  // ------------------------------------------------------------------ progress
  var KEY = 'hoverslam.v1';
  var REV = 2;   // rev 2 replaced missions 10 and up, so progress on those from older saves is dropped
  var save = { rev: REV, levels: {}, endless: {}, settings: { sound: true, stability: true, guidance: true, haptics: true } };
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        if (j.levels && typeof j.levels === 'object') save.levels = j.levels;
        if (j.endless && typeof j.endless === 'object') save.endless = j.endless;
        if ((j.rev | 0) < REV) for (var lid in save.levels) if (+lid >= 10) delete save.levels[lid];
        if (j.settings && typeof j.settings === 'object') for (var k in save.settings) if (typeof j.settings[k] === 'boolean') save.settings[k] = j.settings[k];
      }
    }
  } catch (e) {}
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) {} }
  function lvSave(id) { return save.levels[id] || { done: false, ring: false, fuel: false, best: 0 }; }
  function starsOf(sv) { return sv.done ? 1 + (sv.ring ? 1 : 0) + (sv.fuel ? 1 : 0) : 0; }
  function unlocked(id) { return id === 1 || lvSave(id - 1).done; }
  function totalStars() { var n = 0; LV.forEach(function (l) { n += starsOf(lvSave(l.id)); }); return n; }
  function cleared() { var n = 0; LV.forEach(function (l) { if (lvSave(l.id).done) n++; }); return n; }
  function nextLevelId() { for (var i = 0; i < LV.length; i++) { if (unlocked(LV[i].id) && !lvSave(LV[i].id).done) return LV[i].id; } return 1; }

  // ------------------------------------------------------------------ audio
  var Snd = (function () {
    var ac = null, out = null, L = null;
    function noiseBuf(kind) {
      var n = Math.floor(ac.sampleRate * 2), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0), last = 0;
      for (var i = 0; i < n; i++) {
        var w = Math.random() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
      return b;
    }
    function loop(buf) { var s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; }
    function init() {
      if (ac) { if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} } return; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        out = ac.createGain(); out.gain.value = save.settings.sound ? 0.8 : 0; out.connect(ac.destination);
        var brown = noiseBuf('brown'), white = noiseBuf('white');
        L = {};
        L.lp = ac.createBiquadFilter(); L.lp.type = 'lowpass'; L.lp.frequency.value = 200;
        L.eg = ac.createGain(); L.eg.gain.value = 0;
        loop(brown).connect(L.lp); L.lp.connect(L.eg); L.eg.connect(out);
        L.osc = ac.createOscillator(); L.osc.type = 'sawtooth'; L.osc.frequency.value = 46;
        L.lp2 = ac.createBiquadFilter(); L.lp2.type = 'lowpass'; L.lp2.frequency.value = 160;
        L.og = ac.createGain(); L.og.gain.value = 0;
        L.osc.connect(L.lp2); L.lp2.connect(L.og); L.og.connect(out); L.osc.start();
        L.wb = ac.createBiquadFilter(); L.wb.type = 'bandpass'; L.wb.frequency.value = 600; L.wb.Q.value = 0.7;
        L.wg = ac.createGain(); L.wg.gain.value = 0;
        loop(white).connect(L.wb); L.wb.connect(L.wg); L.wg.connect(out);
        L.hp = ac.createBiquadFilter(); L.hp.type = 'highpass'; L.hp.frequency.value = 2800;
        L.rg = ac.createGain(); L.rg.gain.value = 0;
        loop(white).connect(L.hp); L.hp.connect(L.rg); L.rg.connect(out);
        L.noise = white;
      } catch (e) { ac = null; }
    }
    function setOn(v) { if (ac) out.gain.setTargetAtTime(v ? 0.8 : 0, ac.currentTime, 0.05); }
    function loops(thr, speed, rot, active) {
      if (!ac || !L) return;
      var t = ac.currentTime, m = active ? 1 : 0;
      L.eg.gain.setTargetAtTime(m * thr * 0.95, t, 0.06);
      L.lp.frequency.setTargetAtTime(160 + 1100 * thr, t, 0.08);
      L.og.gain.setTargetAtTime(m * thr * 0.18, t, 0.08);
      L.osc.frequency.setTargetAtTime(42 + 28 * thr, t, 0.1);
      L.wg.gain.setTargetAtTime(m * clamp(speed / 160, 0, 1) * 0.12, t, 0.25);
      L.wb.frequency.setTargetAtTime(450 + speed * 5, t, 0.3);
      L.rg.gain.setTargetAtTime(m * (rot ? 0.05 : 0), t, 0.03);
    }
    function tone(f0, f1, dur, type, vol, delay) {
      if (!ac) return;
      var t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
    }
    function burst(dur, hp, lp, vol) {
      if (!ac || !L) return;
      var t = ac.currentTime, s = ac.createBufferSource(), g = ac.createGain(), f1 = ac.createBiquadFilter(), f2 = ac.createBiquadFilter();
      s.buffer = L.noise; f1.type = 'highpass'; f1.frequency.value = hp || 20; f2.type = 'lowpass'; f2.frequency.value = lp || 8000;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f1); f1.connect(f2); f2.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + dur + 0.05);
    }
    return {
      init: init, setOn: setOn, loops: loops,
      click: function () { tone(720, 540, 0.05, 'square', 0.05); },
      clunk: function () { tone(190, 100, 0.14, 'square', 0.12); burst(0.08, 800, 3000, 0.18); },
      thud: function () { tone(110, 38, 0.3, 'sine', 0.7); burst(0.16, 0, 700, 0.45); },
      chime: function () { tone(523, 0, 0.5, 'triangle', 0.22, 0.12); tone(659, 0, 0.5, 'triangle', 0.22, 0.22); tone(784, 0, 0.7, 'triangle', 0.22, 0.32); },
      boom: function () { burst(1.3, 0, 900, 1.0); tone(70, 26, 1.0, 'sine', 0.8); burst(0.4, 1500, 7000, 0.35); },
      splash: function () { burst(0.9, 600, 5000, 0.55); tone(120, 50, 0.4, 'sine', 0.35); },
      beep: function () { tone(880, 0, 0.07, 'square', 0.04); },
      alarm: function () { tone(990, 0, 0.13, 'square', 0.07); tone(740, 0, 0.13, 'square', 0.07, 0.17); tone(990, 0, 0.13, 'square', 0.07, 0.34); }
    };
  })();
  function buzz(p) { if (save.settings.haptics && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }

  // ------------------------------------------------------------------ canvas, camera
  var canvas = $('#view'), ctx = canvas.getContext('2d');
  var W = 400, H = 700, dpr = 1;
  function resize() {
    var app = $('#app');
    W = Math.max(200, app.clientWidth); H = Math.max(200, app.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  var G = {
    mode: 'boot', level: LV[0], sim: null, seed: 1, cur: 1, attract: true, frozen: false, paused: false, acc: 0,
    camX: 0, camY: 800, lz: Math.log(0.4), camZ: 0.4, shake: 0, flash: 0, endTimer: 0, resultShown: false,
    clouds: [], D: null, hintT: 0, hintGone: false, attractWait: 0, lowBeep: 0, th: THEMES.dusk,
    endless: null, transitionTime: 0, secretTime: 0, secretSeen: {},
    highEgg: false, flipEgg: false
  };
  function sx(x) { return W / 2 + (x - G.camX) * G.camZ; }
  function sy(y) { return H / 2 - (y - G.camY) * G.camZ; }

  var stars = [], streaks = [], rain = [];
  (function () {
    var i;
    for (i = 0; i < 150; i++) stars.push({ x: Math.random(), y: Math.random() * 0.95, r: 0.5 + Math.random() * 1.3, p: Math.random() * TAU });
    for (i = 0; i < 34; i++) streaks.push({ x: Math.random(), y: Math.random(), l: 0.5 + Math.random() });
    for (i = 0; i < 110; i++) rain.push({ x: Math.random(), y: Math.random(), l: 0.6 + Math.random() * 0.8 });
  })();

  function buildClouds(th) {
    var arr = [], n = th.clouds, storm = th.id === 'storm';
    for (var i = 0; i < n; i++) {
      var w = 90 + Math.random() * 230, blobs = [];
      for (var b = 0; b < 7; b++) blobs.push({ dx: (Math.random() - 0.5) * w, dy: Math.random() * w * 0.16, r: w * (0.14 + Math.random() * 0.16) });
      arr.push({ x: Math.random() * 3000, y: storm ? 90 + Math.random() * 700 : 130 + Math.random() * 1350, w: w, d: Math.random(), v: 2 + Math.random() * 6, blobs: blobs });
    }
    return arr;
  }

  function camTargets(s, D) {
    var lv = G.level;
    var zFinal = Math.max(1.2, Math.min(0.72 * W / (lv.deck + 30), 0.3 * H / 34));
    var zFar = clamp(0.33 * Math.min(W, H * 0.62) / 390, 0.22, 0.62);
    var dxs = s.x - D.x, hgt = Math.max(0, s.y - D.y);
    var dist = Math.sqrt(dxs * dxs + hgt * hgt);
    var t = clamp((Math.log(Math.max(dist, 60)) - Math.log(60)) / (Math.log(700) - Math.log(60)), 0, 1);
    var zNear = Math.exp(lerp(Math.log(zFinal), Math.log(zFar), t));
    var zFit = 0.82 * W / (Math.abs(dxs) + lv.deck * 0.55 + 60);
    var z = Math.max(0.12, Math.min(zNear, zFit));
    var wS = clamp(1.15 - dist / 450, 0.12, 0.5);
    var cxT = lerp(s.x, D.x, wS);
    var k = clamp((380 - dist) / 280, 0, 1); k = k * k * (3 - 2 * k);
    var cyFar = s.y - 0.12 * H / z, cyNear = D.y + 0.26 * H / z;
    return { z: z, x: cxT, y: lerp(cyFar, cyNear, k) };
  }
  function updateCamera(dt, snap) {
    var s = G.sim, D = G.D, tg = camTargets(s, D);
    if (snap) { G.camX = tg.x; G.camY = tg.y; G.lz = Math.log(tg.z); }
    else {
      G.camX += (tg.x - G.camX) * Math.min(1, dt * 5);
      G.camY += (tg.y - G.camY) * Math.min(1, dt * 6);
      G.lz += (Math.log(tg.z) - G.lz) * Math.min(1, dt * 2.4);
    }
    G.camZ = Math.exp(G.lz);
  }

  // ------------------------------------------------------------------ particles and effects
  var parts = [];
  function addPart(p) {
    if (parts.length > 950) return;
    p.max = p.life; if (p.g === undefined) p.g = 0; if (p.drag === undefined) p.drag = 0; p.rot = p.rot || 0;
    parts.push(p);
  }
  function seaAt(x, t) { return Sim.swellH(G.level, x, t); }
  function updateParts(dt) {
    var s = G.sim, D = G.D, W2 = G.level.deck / 2;
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      if (p.drag) { var kk = Math.exp(-p.drag * dt); p.vx *= kk; p.vy *= kk; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.rv) p.rot += p.rv * dt;
      if (p.k === 'debris' || p.k === 'spark') {
        var u = p.x - D.x;
        if (Math.abs(u) < W2 && p.vy < 0 && p.y < D.y + u * Math.tan(D.phi) + 0.2) {
          p.y = D.y + u * Math.tan(D.phi) + 0.2; p.vy = -p.vy * 0.3; p.vx *= 0.6; if (p.rv) p.rv *= 0.5;
        }
      }
      if (p.k === 'debris' || p.k === 'spray') {
        var sh = seaAt(p.x, s.t);
        if (p.y < sh) { if (p.k === 'debris') splashAt(p.x, sh, 0.35); parts[i] = parts[parts.length - 1]; parts.pop(); }
      }
    }
  }
  function drawParts() {
    var z = G.camZ, i, p, f, px, py, sz;
    ctx.globalCompositeOperation = 'source-over';
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (p.k === 'fire' || p.k === 'spark') continue;
      f = p.life / p.max; px = sx(p.x); py = sy(p.y);
      if (px < -80 || px > W + 80 || py < -80 || py > H + 80) continue;
      sz = Math.max(1.2, lerp(p.s0, p.s1, 1 - f) * z);
      if (p.k === 'smoke') { ctx.fillStyle = rgba(p.col, (p.a || 0.28) * f); }
      else if (p.k === 'steam') { ctx.fillStyle = 'rgba(235,242,248,' + (0.34 * f) + ')'; }
      else if (p.k === 'cold') { ctx.fillStyle = 'rgba(255,255,255,' + (0.7 * f) + ')'; }
      else if (p.k === 'spray') { ctx.fillStyle = 'rgba(222,240,252,' + (0.9 * f) + ')'; }
      else if (p.k === 'foam') { ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * f) + ')'; }
      else if (p.k === 'ring') {
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * f) + ')'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(px, py, sz, sz * 0.16, 0, 0, TAU); ctx.stroke(); continue;
      } else if (p.k === 'debris') {
        ctx.save(); ctx.translate(px, py); ctx.rotate(-p.rot); ctx.fillStyle = p.col;
        ctx.fillRect(-p.w * z / 2, -p.h * z / 2, Math.max(1.5, p.w * z), Math.max(1.5, p.h * z)); ctx.restore(); continue;
      }
      ctx.beginPath(); ctx.arc(px, py, sz, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (p.k !== 'fire' && p.k !== 'spark') continue;
      f = p.life / p.max; px = sx(p.x); py = sy(p.y);
      if (px < -80 || px > W + 80 || py < -80 || py > H + 80) continue;
      if (p.k === 'spark') {
        ctx.strokeStyle = 'rgba(255,205,130,' + f + ')'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx(p.x - p.vx * 0.04), sy(p.y - p.vy * 0.04)); ctx.stroke(); continue;
      }
      sz = Math.max(1.4, lerp(p.s0, p.s1, 1 - f) * z);
      ctx.fillStyle = f > 0.62 ? 'rgba(255,225,160,' + (0.75 * f) + ')' : f > 0.3 ? 'rgba(255,125,45,' + (0.7 * f + 0.15) + ')' : 'rgba(190,60,30,' + (0.9 * f) + ')';
      ctx.beginPath(); ctx.arc(px, py, sz, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function emitFx(s, dt) {
    if (s.status !== 'flying') return;
    var D = G.D, W2 = G.level.deck / 2, i;
    if (s.throttle > 0.05) {
      var thr = s.throttle, dens = Math.exp(-Math.max(s.y, 0) / 2500);
      var nz = Sim.toWorld(s, 0, -18.2), ang = Math.atan2(-Math.cos(s.th), Math.sin(s.th));
      var n = Math.floor(thr * 150 * dt + Math.random());
      for (i = 0; i < n; i++) {
        var sp = 30 + Math.random() * 50 * thr, a = ang + (Math.random() - 0.5) * 0.24;
        addPart({ k: 'fire', x: nz.x + (Math.random() - 0.5) * 0.8, y: nz.y, vx: Math.cos(a) * sp + s.vx * 0.5, vy: Math.sin(a) * sp + s.vy * 0.5, life: 0.18 + Math.random() * 0.25, s0: 1.7, s1: 0.5, drag: 1.2 });
      }
      if (Math.random() < thr * dt * 45 * (0.3 + dens)) {
        var a2 = ang + (Math.random() - 0.5) * 0.5;
        addPart({ k: 'smoke', x: nz.x, y: nz.y, vx: Math.cos(a2) * 9 + s.vx * 0.6 + (Math.random() - 0.5) * 4, vy: Math.sin(a2) * 9 + s.vy * 0.6, life: 1.4 + Math.random() * 1.3, s0: 1.2, s1: 5 + Math.random() * 3, g: -1.4, drag: 0.9, col: [112, 118, 124], a: 0.26 });
      }
      var alt = s.alt === undefined ? 999 : s.alt;
      if (alt < 40 && Math.abs(nz.x - D.x) < W2 + 12 && thr > 0.2) {
        var rate = thr * (1 - alt / 40) * dt * 100, m = Math.floor(rate + Math.random());
        for (i = 0; i < m; i++) {
          var dir = Math.random() < 0.5 ? -1 : 1, ix = nz.x + dir * Math.random() * 2;
          addPart({ k: 'steam', x: ix, y: D.y + (ix - D.x) * Math.tan(D.phi) + 0.6, vx: dir * (10 + Math.random() * 26), vy: 1 + Math.random() * 5, life: 0.8 + Math.random() * 0.8, s0: 1.8, s1: 6.5, drag: 1.4, g: -0.5 });
        }
      }
    }
    if (G.level.leak && s.fuel > 0 && Math.random() < dt * 34) {
      var lp = Sim.toWorld(s, 2.0, 5 + Math.random() * 3);
      addPart({ k: 'steam', x: lp.x, y: lp.y, vx: s.vx * 0.85 + 5 + Math.random() * 6, vy: s.vy * 0.85 + (Math.random() - 0.5) * 6, life: 0.7 + Math.random() * 0.6, s0: 0.7, s1: 3, drag: 0.8 });
    }
    if (s.engineOut && Math.random() < dt * 28) {
      var np = Sim.toWorld(s, 0, -18.2);
      addPart({ k: 'smoke', x: np.x, y: np.y, vx: s.vx * 0.7 + (Math.random() - 0.5) * 6, vy: s.vy * 0.7 + (Math.random() - 0.5) * 6, life: 0.9 + Math.random() * 0.7, s0: 1.2, s1: 4, g: -1, drag: 1, col: [34, 36, 40], a: 0.45 });
    }
    if (s.rot && Math.random() < dt * 42) {
      var tp = Sim.toWorld(s, s.rot * 1.95, 12), c = Math.cos(s.th), sn = Math.sin(s.th);
      addPart({ k: 'cold', x: tp.x, y: tp.y, vx: s.rot * c * 24 + s.vx, vy: s.rot * sn * 24 + s.vy, life: 0.26, s0: 0.45, s1: 1.5, drag: 1.5 });
    }
  }
  function splashAt(x, y, power) {
    var n = Math.floor(46 * power) + 8, i;
    for (i = 0; i < n; i++) {
      var a = Math.PI / 2 + (Math.random() - 0.5) * 1.5, sp = (8 + Math.random() * 26) * (0.5 + power);
      addPart({ k: 'spray', x: x + (Math.random() - 0.5) * 3, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1.1 + Math.random() * 0.8, s0: 0.5, s1: 0.3, g: 9.8 });
    }
    for (i = 0; i < 8 * power + 3; i++) addPart({ k: 'foam', x: x + (Math.random() - 0.5) * 8, y: y + 0.3, vx: (Math.random() - 0.5) * 8, vy: 1 + Math.random() * 2, life: 1.2 + Math.random(), s0: 1.2, s1: 3.2, drag: 1 });
    addPart({ k: 'ring', x: x, y: y, vx: 0, vy: 0, life: 1.4, s0: 2, s1: 10 + 22 * power });
    if (power > 0.5) addPart({ k: 'ring', x: x, y: y, vx: 0, vy: 0, life: 1.9, s0: 1, s1: 16 + 34 * power });
  }
  function fxTouch(s) {
    var f = Sim.feet(s, true), i, j, rough = !!(s.result && s.result.rough);
    for (i = 0; i < 2; i++) {
      for (j = 0; j < (rough ? 18 : 9); j++) {
        var a = Math.PI * (0.15 + Math.random() * 0.7), sp = 6 + Math.random() * 16;
        addPart({ k: 'spark', x: f[i].x, y: f[i].y + 0.3, vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.4, s0: 1, s1: 1, g: 14 });
      }
      for (j = 0; j < 5; j++) addPart({ k: 'steam', x: f[i].x, y: f[i].y + 0.8, vx: (Math.random() - 0.5) * 18, vy: 1 + Math.random() * 3, life: 0.9, s0: 1.4, s1: 5, drag: 1.5 });
    }
    G.shake = Math.max(G.shake, reduceMotion ? 0 : (rough ? 12 : 5));
    Snd.thud(); if (!rough) setTimeout(Snd.chime, 90); buzz(rough ? 70 : 25);
  }
  function fxCrash(s) {
    var i, x = s.x, y = s.y;
    for (i = 0; i < 80; i++) { var a = Math.random() * TAU, sp = 4 + Math.random() * 40; addPart({ k: 'fire', x: x, y: y, vx: Math.cos(a) * sp + s.vx * 0.3, vy: Math.sin(a) * sp + s.vy * 0.3, life: 0.5 + Math.random() * 0.8, s0: 2.5, s1: 6, drag: 1.6 }); }
    for (i = 0; i < 46; i++) { var b = Math.random() * TAU, sq = 2 + Math.random() * 14; addPart({ k: 'smoke', x: x, y: y, vx: Math.cos(b) * sq, vy: Math.sin(b) * sq + 3, life: 1.8 + Math.random() * 2, s0: 3, s1: 12 + Math.random() * 8, g: -2, drag: 0.7, col: [48, 50, 54], a: 0.42 }); }
    for (i = 0; i < 60; i++) { var c = Math.random() * TAU, sk = 12 + Math.random() * 60; addPart({ k: 'spark', x: x, y: y, vx: Math.cos(c) * sk, vy: Math.sin(c) * sk, life: 0.5 + Math.random() * 0.9, s0: 1, s1: 1, g: 16 }); }
    var cols = ['#f1f4f7', '#d3d9df', '#20252c', '#ff7a35', '#8b94a0'];
    for (i = 0; i < 14; i++) { var d = Math.random() * TAU, sd = 6 + Math.random() * 26; addPart({ k: 'debris', x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 12, vx: Math.cos(d) * sd + s.vx * 0.2, vy: Math.sin(d) * sd + 8, life: 4 + Math.random() * 3, w: 0.7 + Math.random() * 1.4, h: 1.4 + Math.random() * 4, rot: Math.random() * TAU, rv: (Math.random() - 0.5) * 12, g: 9.8, col: cols[i % cols.length] }); }
    G.shake = reduceMotion ? 0 : 20; G.flash = reduceMotion ? 0.25 : 0.9;
    Snd.boom(); buzz([160, 40, 90]);
  }
  function fxSplash(s) {
    var sh = seaAt(s.x, s.t);
    var p = clamp((s.result && s.result.speed ? s.result.speed : 30) / 60, 0.3, 1.4);
    splashAt(s.x, sh, p);
    G.shake = reduceMotion ? 0 : 9; Snd.splash(); buzz(90);
  }
  function fxFault(s) {
    var nz = Sim.toWorld(s, 0, -18.2), i;
    for (i = 0; i < 16; i++) addPart({ k: 'smoke', x: nz.x, y: nz.y, vx: s.vx * 0.5 + (Math.random() - 0.5) * 14, vy: s.vy * 0.5 + (Math.random() - 0.5) * 14, life: 1.2 + Math.random(), s0: 1.5, s1: 6, g: -1, drag: 0.9, col: [40, 42, 46], a: 0.5 });
    G.shake = Math.max(G.shake, reduceMotion ? 0 : 6);
    Snd.alarm(); buzz([70, 40, 70]);
  }
  function handleEvents(s) {
    for (var i = 0; i < s.events.length; i++) {
      var e = s.events[i];
      if (e === 'legs') Snd.clunk();
      else if (e === 'touch') fxTouch(s);
      else if (e === 'crash') fxCrash(s);
      else if (e === 'splash') fxSplash(s);
      else if (e === 'fault') fxFault(s);
      else if (e === 'relight') { Snd.clunk(); buzz(30); }
    }
    s.events.length = 0;
  }

  // ------------------------------------------------------------------ drawing: world
  function drawSky(th) {
    var y0 = sy(0), y1 = sy(1600), g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, th.hor); g.addColorStop(0.035, th.hl); g.addColorStop(0.13, th.low); g.addColorStop(0.42, th.mid); g.addColorStop(1, th.top);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function drawStars(th, t) {
    var a = th.stars;
    if (th.id !== 'night' && th.id !== 'storm') a = Math.max(a, clamp((G.camY - 350) / 700, 0, 0.85));
    if (a < 0.03) return;
    ctx.fillStyle = '#fff';
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      ctx.globalAlpha = a * (0.55 + 0.45 * Math.sin(t * 1.5 + s.p));
      ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }
  function drawSun(th) {
    if (th.id === 'storm') return;
    var x = W * 0.74, y = sy(th.sunAlt), r = th.id === 'night' ? 24 : 42;
    if (y > H + 260) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
    g.addColorStop(0, rgba(th.c.sun, th.id === 'night' ? 0.28 : 0.6)); g.addColorStop(0.3, rgba(th.c.sun, 0.16)); g.addColorStop(1, rgba(th.c.sun, 0));
    ctx.fillStyle = g; ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    ctx.fillStyle = th.sun; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function wrap(v, m) { return ((v % m) + m) % m; }
  function drawClouds(th, t) {
    var cl = G.clouds, z = G.camZ, base = th.c.cloud, storm = th.id === 'storm';
    for (var i = 0; i < cl.length; i++) {
      var c = cl[i], par = 0.5 + 0.5 * c.d, zl = z * par;
      var wx = wrap(c.x + t * c.v - G.camX * par, 3000) - 1500;
      var px = W / 2 + wx * zl, py = H / 2 - (c.y - G.camY) * zl;
      if (px < -c.w * zl - 40 || px > W + c.w * zl + 40 || py < -c.w * zl || py > H + 40) continue;
      ctx.fillStyle = rgba(base, (storm ? 0.5 : 0.28) + 0.3 * c.d);
      ctx.beginPath();
      for (var b = 0; b < c.blobs.length; b++) {
        var bl = c.blobs[b], bx = px + bl.dx * zl, by = py - bl.dy * zl, br = bl.r * zl;
        ctx.moveTo(bx + br, by); ctx.arc(bx, by, br, 0, TAU);
      }
      ctx.fill();
    }
  }
  function drawRain(th, dt, s) {
    if (th.id !== 'storm') return;
    var slant = clamp(-(s.wind0 || 0) * 40, -90, 90) + (s.wind0 > 0 ? 30 : -30);
    ctx.strokeStyle = 'rgba(205,225,238,0.28)'; ctx.lineWidth = 1; ctx.beginPath();
    for (var i = 0; i < rain.length; i++) {
      var r = rain[i];
      r.y += dt * (1.6 + r.l); r.x += dt * slant / W; if (r.y > 1.05) { r.y = -0.05; r.x = Math.random(); } if (r.x > 1.05) r.x = -0.05; if (r.x < -0.05) r.x = 1.05;
      var px = r.x * W, py = r.y * H;
      ctx.moveTo(px, py); ctx.lineTo(px + slant * 0.03, py + 16 * r.l);
    }
    ctx.stroke();
  }
  function drawStreaks(s, dt) {
    var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (sp < 25 || s.status !== 'flying') return;
    var a = clamp((sp - 25) / 90, 0, 0.32), vx = s.vx / sp, vy = s.vy / sp, speedPx = clamp(sp * 6, 0, 900), len = clamp(sp * 0.9, 8, 90);
    ctx.strokeStyle = 'rgba(255,255,255,' + a + ')'; ctx.lineWidth = 1.2; ctx.beginPath();
    var floor = sy(0);
    for (var i = 0; i < streaks.length; i++) {
      var k = streaks[i];
      k.x += (-vx * speedPx * dt * k.l) / W; k.y += (vy * speedPx * dt * k.l) / H;
      if (k.y > 1.1) { k.y = -0.1; k.x = Math.random(); } else if (k.y < -0.1) { k.y = 1.1; k.x = Math.random(); }
      if (k.x < -0.05) k.x += 1.1; else if (k.x > 1.05) k.x -= 1.1;
      var px = k.x * W, py = k.y * H;
      if (py > floor - 6) continue;
      ctx.moveTo(px, py); ctx.lineTo(px + vx * len * k.l, py - vy * len * k.l);
    }
    ctx.stroke();
  }
  var seaPts = [];
  function seaH(lv, wx, t, layer) {
    if (layer === 0) return Sim.swellH(lv, wx + 55, t + 1.3) * 0.7 + 0.5 + 0.15 * Math.sin(wx * 0.23 + t * 1.7);
    return Sim.swellH(lv, wx, t) + 0.16 * Math.sin(wx * 0.31 + t * 2.1) + 0.1 * Math.sin(wx * 0.77 - t * 1.4);
  }
  function drawSea(th, s, layer) {
    var lv = s.level, z = G.camZ, y0 = sy(0), amp = lv.swell * 1.5 * z + 8;
    if (y0 - amp > H) return;
    var stepPx = z > 1.5 ? 8 : 14, n = 0, px;
    ctx.beginPath();
    for (px = -stepPx; px <= W + stepPx; px += stepPx) {
      var wx = G.camX + (px - W / 2) / z, py = sy(seaH(lv, wx, s.t, layer));
      seaPts[n++] = px; seaPts[n++] = py;
      if (n === 2) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineTo(W + stepPx, H + 4); ctx.lineTo(-stepPx, H + 4); ctx.closePath();
    var depth = Math.max(90, 50 * z), g = ctx.createLinearGradient(0, y0 - 3 * z, 0, y0 + depth);
    if (layer === 0) { g.addColorStop(0, rgba(mixA(th.c.sea1, th.c.hor, 0.35), 1)); g.addColorStop(1, rgba(th.c.sea2, 1)); }
    else { g.addColorStop(0, rgba(th.c.sea1, 0.94)); g.addColorStop(1, rgba(th.c.sea2, 0.98)); }
    ctx.fillStyle = g; ctx.fill();
    if (layer === 1) {
      ctx.beginPath();
      for (var i = 0; i < n; i += 2) { if (i === 0) ctx.moveTo(seaPts[0], seaPts[1]); else ctx.lineTo(seaPts[i], seaPts[i + 1]); }
      ctx.strokeStyle = 'rgba(255,255,255,0.34)'; ctx.lineWidth = Math.max(1, 0.26 * z); ctx.stroke();
      // sun glints on the water
      if (th.id !== 'storm' && th.sunAlt > 0 && y0 < H - 10) {
        var gx = W * 0.74;
        ctx.fillStyle = rgba(th.c.sun, 0.26);
        for (var k = 0; k < 14; k++) {
          var gy = y0 + 4 + k * Math.max(5, 4.5 * Math.min(z, 3)), gw = (14 + k * 4) * (0.6 + 0.4 * Math.sin(s.t * 2 + k * 1.7));
          if (gy > H) break;
          ctx.fillRect(gx - gw / 2 + Math.sin(s.t + k) * 6, gy, gw, 1.6);
        }
      }
    }
  }

  function drawShip(D, lv, t) {
    var W2 = lv.deck / 2, HL = W2 + 14, z = G.camZ, px = sx(D.x), py = sy(D.y);
    if (px + HL * z < -40 || px - HL * z > W + 40 || py < -300 || py - 16 * z > H) return;
    ctx.save(); ctx.translate(px, py); ctx.rotate(-D.phi); ctx.scale(z, -z);
    var hg = ctx.createLinearGradient(0, -1.6, 0, -11); hg.addColorStop(0, '#3d4857'); hg.addColorStop(1, '#161c26');
    ctx.beginPath(); ctx.moveTo(-HL, -1.6); ctx.lineTo(-HL + 1.2, -8.6); ctx.lineTo(-HL + 9, -11); ctx.lineTo(HL - 9, -11); ctx.lineTo(HL - 1.2, -8.6); ctx.lineTo(HL, -1.6); ctx.closePath();
    ctx.fillStyle = hg; ctx.fill();
    ctx.save(); ctx.clip(); ctx.fillStyle = '#7b3a2f'; ctx.fillRect(-HL, -12, HL * 2, 6.8); ctx.restore();
    ctx.save(); ctx.translate(-W2 * 0.45, -5.3); ctx.scale(1, -1);
    ctx.font = '800 2.8px "Big Shoulders Display", Impact, sans-serif'; ctx.fillStyle = 'rgba(236,241,246,0.9)'; ctx.textAlign = 'center'; ctx.fillText('TIDEWAKE', 0, 0); ctx.restore();
    ctx.fillStyle = '#69737f'; ctx.fillRect(-HL, -2.2, HL * 2, 2.2);
    ctx.fillStyle = '#c9d2da'; ctx.fillRect(-HL, -0.3, HL * 2, 0.3);
    ctx.fillStyle = '#262d37'; ctx.fillRect(-W2, -0.5, W2 * 2, 0.5);
    var i;
    for (i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#15181d' : '#f2c230'; ctx.fillRect(-W2 + i * 0.55, -0.5, 0.55, 0.5); ctx.fillRect(W2 - (i + 1) * 0.55, -0.5, 0.55, 0.5); }
    ctx.fillStyle = '#ff7a35'; ctx.fillRect(-lv.ring, -0.5, lv.ring * 2, 0.5);
    ctx.fillStyle = '#fff'; ctx.fillRect(-0.5, -0.5, 1, 0.5);
    var bg = ctx.createLinearGradient(0, 0, 0, 7); bg.addColorStop(0, 'rgba(255,140,70,' + (0.4 + 0.1 * Math.sin(t * 3)) + ')'); bg.addColorStop(1, 'rgba(255,140,70,0)');
    ctx.fillStyle = bg; ctx.fillRect(-lv.ring, 0, lv.ring * 2, 7);
    for (i = 0; i < 9; i++) {
      var lx = -W2 + (i + 0.5) * (W2 * 2) / 9, la = Math.max(0, Math.sin(t * 5 - i * 0.7));
      ctx.fillStyle = 'rgba(255,240,200,' + (0.18 + 0.7 * la) + ')'; ctx.fillRect(lx - 0.3, 0, 0.6, 0.25);
    }
    [-W2, W2].forEach(function (ex, n) {
      ctx.fillStyle = '#d9dee3'; ctx.fillRect(ex - 0.2, 0, 0.4, 1.8);
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,170,60,' + (0.55 + 0.45 * Math.sin(t * 3 + n * 3.14)) + ')';
      ctx.beginPath(); ctx.arc(ex, 2.1, 0.6, 0, TAU); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
    });
    // bridge tower (left) and thruster block (right)
    var tg = ctx.createLinearGradient(0, 0, 0, 10); tg.addColorStop(0, '#b3bcc6'); tg.addColorStop(1, '#eef1f4');
    ctx.fillStyle = tg; ctx.fillRect(-W2 - 12, 0, 10.5, 10);
    ctx.fillStyle = '#ff7a35'; ctx.fillRect(-W2 - 12, 7.2, 10.5, 0.9);
    ctx.fillStyle = 'rgba(255,214,120,0.95)'; for (i = 0; i < 4; i++) ctx.fillRect(-W2 - 10.8 + i * 2.4, 4.2, 1.3, 1.1);
    ctx.fillStyle = '#9aa5b0'; ctx.fillRect(-W2 - 6.9, 10, 0.25, 4.5);
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,60,50,' + (Math.sin(t * 2.4) > 0.2 ? 0.95 : 0.15) + ')'; ctx.beginPath(); ctx.arc(-W2 - 6.8, 14.7, 0.5, 0, TAU); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#cfd6dc'; ctx.fillRect(W2 + 2, 0, 9, 5.2);
    ctx.fillStyle = '#ff7a35'; ctx.fillRect(W2 + 2, 3.2, 9, 0.7);
    ctx.fillStyle = '#8e99a4'; ctx.fillRect(W2 + 2, 0, 9, 0.7);
    ctx.restore();
  }

  function drawRocket(s) {
    var z = G.camZ, k = Math.max(1, 46 / (34 * z)), thr = s.throttle, i;
    ctx.save(); ctx.translate(sx(s.x), sy(s.y)); ctx.rotate(-s.th); ctx.scale(z * k, -z * k);
    // flame
    if (thr > 0.03 && s.status === 'flying') {
      var fl = (4 + 26 * thr) * (0.88 + 0.12 * Math.sin(s.t * 70) + 0.05 * Math.random()), ny = -17.6;
      ctx.globalCompositeOperation = 'lighter';
      var gl = ctx.createRadialGradient(0, ny - 2, 0, 0, ny - 2, 8 + 12 * thr);
      gl.addColorStop(0, 'rgba(255,160,70,' + (0.45 * thr) + ')'); gl.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gl; ctx.fillRect(-22, ny - 24, 44, 40);
      var layers = [[1.55, 1, 'rgba(255,100,35,0.55)'], [1.0, 0.74, 'rgba(255,190,90,0.8)'], [0.5, 0.5, 'rgba(255,250,225,0.95)']];
      for (i = 0; i < layers.length; i++) {
        var w = layers[i][0], l = fl * layers[i][1];
        ctx.fillStyle = layers[i][2]; ctx.beginPath(); ctx.moveTo(-w, ny);
        ctx.quadraticCurveTo(-w * 1.15, ny - l * 0.45, 0, ny - l); ctx.quadraticCurveTo(w * 1.15, ny - l * 0.45, w, ny); ctx.closePath(); ctx.fill();
      }
      if (thr > 0.45) { ctx.fillStyle = 'rgba(255,235,190,0.7)'; for (i = 1; i <= 3; i++) { ctx.beginPath(); ctx.ellipse(0, ny - fl * (0.18 + i * 0.17), 0.55, 0.34, 0, 0, TAU); ctx.fill(); } }
      ctx.globalCompositeOperation = 'source-over';
    }
    // legs
    var dep = s.status === 'landed' ? 1 : s.legs, lg = Sim.legGeom(dep), comp = s.land ? s.land.comp : 0;
    [-1, 1].forEach(function (sg) {
      var ax = sg * 1.8, ay = -6.5, fx = sg * (lg.span - comp * 0.15), fy = lg.fy + comp * 0.3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#2b3138'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(fx, fy + 0.5); ctx.stroke();
      ctx.strokeStyle = '#6f7b88'; ctx.lineWidth = 0.28; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(fx, fy + 0.5); ctx.stroke();
      ctx.strokeStyle = '#2b3138'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(sg * 1.8, -13.5); ctx.lineTo(lerp(ax, fx, 0.62), lerp(ay, fy, 0.62)); ctx.stroke();
      ctx.fillStyle = '#20262d'; ctx.fillRect(fx - 1.1, fy, 2.2, 0.6);
    });
    // body
    var bg = ctx.createLinearGradient(-1.85, 0, 1.85, 0);
    bg.addColorStop(0, '#bcc6cf'); bg.addColorStop(0.35, '#ffffff'); bg.addColorStop(0.75, '#c3ccd5'); bg.addColorStop(1, '#8996a3');
    ctx.fillStyle = bg; ctx.fillRect(-1.85, -15.6, 3.7, 25.6);
    var soot = clamp(0.1 + s.burnTime / 28, 0, 0.62), sg2 = ctx.createLinearGradient(0, -2, 0, -15.6);
    sg2.addColorStop(0, 'rgba(24,20,18,0)'); sg2.addColorStop(1, 'rgba(24,20,18,' + soot + ')');
    ctx.fillStyle = sg2; ctx.fillRect(-1.85, -15.6, 3.7, 13.6);
    ctx.fillStyle = '#ff7a35'; ctx.fillRect(-1.85, 3.6, 3.7, 0.7);
    ctx.fillStyle = '#1a1e24'; ctx.fillRect(-1.85, 2.5, 3.7, 0.22); ctx.fillRect(-1.85, 5.2, 3.7, 0.22);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, -0.2, 0.95, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ff7a35'; ctx.lineWidth = 0.28; ctx.stroke();
    ctx.fillStyle = '#171b21'; ctx.fillRect(-1.85, 8.4, 3.7, 5.6);
    ctx.fillStyle = '#323943'; ctx.fillRect(-1.85, 13.7, 3.7, 0.5);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-1.0, -14.5, 0.3, 22);
    ctx.fillStyle = '#23282f'; ctx.fillRect(-1.55, -17.3, 3.1, 1.8);
    ctx.beginPath(); ctx.moveTo(-1.0, -17.3); ctx.lineTo(1.0, -17.3); ctx.lineTo(1.4, -18.5); ctx.lineTo(-1.4, -18.5); ctx.closePath(); ctx.fillStyle = '#3a414b'; ctx.fill();
    // grid fins
    [-1, 1].forEach(function (sg) {
      ctx.fillStyle = '#464e58'; ctx.fillRect(sg > 0 ? 1.85 : -3.95, 7.0, 2.1, 1.8);
      ctx.strokeStyle = '#1c2026'; ctx.lineWidth = 0.14;
      for (var n = 1; n < 4; n++) { var gx = (sg > 0 ? 1.85 : -3.95) + n * 0.525; ctx.beginPath(); ctx.moveTo(gx, 7.0); ctx.lineTo(gx, 8.8); ctx.stroke(); }
      ctx.fillStyle = '#2a2f36'; ctx.fillRect(sg * 1.95 - 0.25, 11.5, 0.5, 0.9);
    });
    ctx.restore();
  }

  function drawGuidance(s) {
    if (!save.settings.guidance || s.status !== 'flying' || G.mode !== 'fly' || s.blackout) return;
    var pr = Sim.predict(s), i, z = G.camZ;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (i = 1; i < pr.pts.length; i += 2) {
      var px = sx(pr.pts[i].x), py = sy(pr.pts[i].y);
      if (px < -4 || px > W + 4 || py < -4 || py > H + 4) continue;
      ctx.globalAlpha = 0.55 * (1 - i / pr.pts.length); ctx.beginPath(); ctx.arc(px, py, 1.7, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (pr.hit) {
      var hx = sx(pr.hit.x), hy = sy(Sim.FREEBOARD), col = pr.hit.on ? '#58e0a2' : '#ff5d4f';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx, hy - 22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx, hy - 4); ctx.lineTo(hx - 5, hy - 12); ctx.lineTo(hx + 5, hy - 12); ctx.closePath(); ctx.fill();
    }
  }
  function drawShipMarker(s, D) {
    var px = sx(D.x), py = sy(D.y), dxm = Math.round(s.x - D.x);
    ctx.font = '600 11px ' + MONO; ctx.textBaseline = 'middle';
    if (px < 40 || px > W - 40) {
      var left = px < 40, ay = clamp(py - 40, 150, H - 220);
      ctx.fillStyle = 'rgba(8,19,31,0.65)'; var label = 'SHIP  ' + Math.abs(dxm) + ' m', tw = ctx.measureText(label).width;
      var bx = left ? 8 : W - 8 - tw - 30;
      ctx.fillRect(bx, ay - 14, tw + 30, 28);
      ctx.fillStyle = '#ffb25e'; ctx.beginPath();
      if (left) { ctx.moveTo(14, ay); ctx.lineTo(24, ay - 6); ctx.lineTo(24, ay + 6); } else { ctx.moveTo(W - 14, ay); ctx.lineTo(W - 24, ay - 6); ctx.lineTo(W - 24, ay + 6); }
      ctx.closePath(); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillStyle = '#eef4f8'; ctx.fillText(label, left ? 32 : bx + 8, ay);
    } else if (py > H - 40) {
      // the ship is still below the bottom edge of the screen: point down at it
      var mx = clamp(px, 34, W - 34), my = H - 178, lab = 'SHIP';
      ctx.fillStyle = 'rgba(8,19,31,0.65)'; ctx.fillRect(mx - 30, my - 22, 60, 30);
      ctx.fillStyle = '#ffb25e'; ctx.beginPath(); ctx.moveTo(mx, my + 6); ctx.lineTo(mx - 6, my - 4); ctx.lineTo(mx + 6, my - 4); ctx.closePath(); ctx.fill();
      ctx.textAlign = 'center'; ctx.fillStyle = '#eef4f8'; ctx.fillText(lab, mx, my - 14);
    } else if (G.camZ < 1.1 && py > 24 && py < H + 40) {
      var bob = Math.sin(s.t * 3) * 3, y = py - 34 - bob;
      ctx.fillStyle = '#ffb25e'; ctx.beginPath(); ctx.moveTo(px, y + 8); ctx.lineTo(px - 7, y - 4); ctx.lineTo(px + 7, y - 4); ctx.closePath(); ctx.fill();
    }
  }

  function render(dt) {
    var s = G.sim; if (!s) return;
    var th = G.th, D = Sim.deckPose(s);
    G.D = D; updateCamera(dt, false);
    var sxo = 0, syo = 0;
    if (G.shake > 0.1) { sxo = (Math.random() - 0.5) * G.shake; syo = (Math.random() - 0.5) * G.shake; G.shake *= Math.exp(-6 * dt); } else G.shake = 0;
    ctx.setTransform(dpr, 0, 0, dpr, sxo * dpr, syo * dpr);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawSky(th); drawStars(th, s.t); drawSun(th); drawClouds(th, s.t);
    drawStreaks(s, dt); drawRain(th, dt, s);
    drawSea(th, s, 0); drawShip(D, s.level, s.t);
    // engine light on the deck
    if (s.status === 'flying' && s.throttle > 0.1 && s.alt < 70) {
      var gx = sx(Sim.toWorld(s, 0, -18).x), gy = sy(D.y), rr = (30 + 40 * s.throttle) * Math.max(G.camZ, 0.8), ga = s.throttle * 0.55 * (1 - s.alt / 70);
      var lg = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr); lg.addColorStop(0, 'rgba(255,170,90,' + ga + ')'); lg.addColorStop(1, 'rgba(255,140,60,0)');
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lg; ctx.fillRect(gx - rr, gy - rr, rr * 2, rr * 2); ctx.globalCompositeOperation = 'source-over';
    }
    drawSea(th, s, 1);
    if (s.status === 'flying' || s.status === 'landed') drawRocket(s);
    drawParts();
    drawGuidance(s);
    drawShipMarker(s, D);
    if (G.flash > 0.01) { ctx.fillStyle = 'rgba(255,230,200,' + (G.flash * 0.7) + ')'; ctx.fillRect(-20, -20, W + 40, H + 40); G.flash *= Math.exp(-5 * dt); }
  }

  // ------------------------------------------------------------------ HUD
  var el = {};
  ['v-alt', 'v-vs', 'v-hs', 'v-tilt', 't-vs', 't-hs', 't-tilt', 'v-wind', 'wind-arrow', 'v-fuel', 'fuel-fill', 'fuel-goal', 'fuel', 'cue', 'hint', 'hint-tx'].forEach(function (id) { el[id] = document.getElementById(id); });
  function setTx(node, v) { if (node._t !== v) { node.textContent = v; node._t = v; } }
  function cls(ratio) { return ratio <= 1 ? 'ok' : ratio <= 1.35 ? 'warn' : 'bad'; }
  function updateHud(dt) {
    var s = G.sim, lv = G.level, T = Sim.telemetry(s), near = T.alt < 100 && s.status === 'flying';
    var dark = !!s.blackout && s.status === 'flying';
    setTx(el['v-alt'], dark ? '--' : T.alt >= 100 ? String(Math.round(T.alt)) : Math.max(0, T.alt).toFixed(1));
    setTx(el['v-vs'], dark ? '--' : (T.vn >= 0 ? '↓' : '↑') + Math.abs(T.vn).toFixed(Math.abs(T.vn) < 10 ? 1 : 0));
    setTx(el['v-hs'], dark ? '--' : (T.vt >= 0 ? '→' : '←') + Math.abs(T.vt).toFixed(1));
    setTx(el['v-tilt'], dark ? '--' : (T.rel >= 0 ? '↶' : '↷') + Math.abs(T.rel * 57.296).toFixed(0));
    var a = near && !dark ? cls(T.vn / lv.vMax) : '', b = near && !dark ? cls(Math.abs(T.vt) / lv.hMax) : '', c = near && !dark ? cls(Math.abs(T.rel) / lv.aMax) : '';
    if (el['t-vs'].dataset.s !== a) el['t-vs'].dataset.s = a;
    if (el['t-hs'].dataset.s !== b) el['t-hs'].dataset.s = b;
    if (el['t-tilt'].dataset.s !== c) el['t-tilt'].dataset.s = c;
    var kt = Math.round(T.wind * 10);
    setTx(el['v-wind'], Math.abs(kt) + ' kt');
    var fl = kt < 0 ? 'scaleX(-1)' : 'none'; if (el['wind-arrow']._f !== fl) { el['wind-arrow'].style.transform = fl; el['wind-arrow']._f = fl; }
    el['wind-arrow'].style.opacity = Math.abs(kt) < 1 ? 0.3 : 1;
    setTx(el['v-fuel'], Math.round(T.fuel * 100) + '%');
    el['fuel-fill'].style.width = (T.fuel * 100).toFixed(1) + '%';
    el['fuel'].classList.toggle('low', T.fuel < 0.12 && T.fuel > 0);
    // cue
    var cue = el['cue'];
    if (s.status === 'flying' && s.engineOut) {
      cue.hidden = false; setTx(cue, 'ENGINE OUT'); if (cue.dataset.s !== '2') cue.dataset.s = '2';
    } else if (s.status === 'flying' && s.blackout) {
      cue.hidden = false; setTx(cue, 'NO DATA'); if (cue.dataset.s !== '0') cue.dataset.s = '0';
    } else if (save.settings.guidance && s.status === 'flying') {
      cue.hidden = false;
      var q = Sim.burnCue(s), st = q, tx;
      if (s.throttle > 0.4) { st = 3; tx = 'BURNING'; } else if (q === 2) tx = 'BURN NOW'; else if (q === 1) tx = 'GET READY'; else tx = 'COAST';
      setTx(cue, tx); if (cue.dataset.s !== String(st)) cue.dataset.s = String(st);
    } else cue.hidden = true;
    // hint
    var showHint = G.cur <= 2 && !G.hintGone && G.mode === 'fly' && !G.paused;
    if (showHint) {
      G.hintT += dt;
      if (s.throttle > 0.25 && G.hintT > 1) G.hintT = Math.max(G.hintT, 9);
      if (G.hintT > 12) { G.hintGone = true; showHint = false; }
    }
    el['hint'].hidden = !showHint;
    if (showHint) setTx(el['hint-tx'], G.hintT < 8 ? (coarse ? 'Hold THRUST to burn. Tap the arrows to tilt.' : 'Hold Up or Space to burn. Left and Right to tilt.') : 'Burn late, touch down slow and upright.');
    // low-fuel beep
    if (s.status === 'flying' && T.fuel > 0 && T.fuel < 0.1) { G.lowBeep -= dt; if (G.lowBeep <= 0) { Snd.beep(); G.lowBeep = 0.9; } }
  }
  function showSecret(id, message) {
    if (G.secretSeen[id]) return;
    G.secretSeen[id] = true; G.secretTime = 3.2;
    var toast = $('#easter-egg'); toast.textContent = message; toast.hidden = false;
    toast.classList.remove('pop'); void toast.offsetWidth; toast.classList.add('pop');
  }

  // ------------------------------------------------------------------ screens
  var screens = {};
  ['menu', 'levels', 'brief', 'result', 'pause', 'settings', 'endless', 'transition'].forEach(function (n) { screens[n] = document.getElementById('s-' + n); });
  function setScreen(name) {
    Object.keys(screens).forEach(function (k) { screens[k].hidden = k !== name; });
    chrome();
  }
  function chrome() {
    var hud = (G.mode === 'fly' || G.mode === 'ended') && !G.resultShown;
    $('#hud').hidden = !hud;
    $('#controls').hidden = !(G.mode === 'fly' && !G.paused);
    if (!hud) el['hint'].hidden = true;
  }
  var STAR = '<svg viewBox="0 0 24 24"><polygon class="star{c}" points="12,2 15,9 22,9.5 16.5,14 18.5,21.5 12,17.5 5.5,21.5 7.5,14 2,9.5 9,9"/></svg>';
  function starRow(n) { var h = ''; for (var i = 0; i < 3; i++) h += STAR.replace('{c}', i < n ? ' on' : ''); return h; }
  var LOCK = '<svg class="lock" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/></svg>';
  var CHECK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';
  var CROSS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';

  function buildMenu() {
    var id = nextLevelId(), lv = LV[id - 1], n = cleared();
    $('#m-play-t').textContent = n ? 'Launch' : 'Start';
    $('#m-play-s').textContent = 'Mission ' + id + ' · ' + lv.name;
    $('#m-progress').textContent = n ? n + ' of ' + LV.length + ' missions cleared · ' + totalStars() + ' of ' + LV.length * 3 + ' stars' : LV.length + ' missions. Wind, swell, and some nasty surprises further on.';
  }
  function buildLevels() {
    var grid = $('#l-grid'); grid.innerHTML = '';
    LV.forEach(function (lv) {
      var sv = lvSave(lv.id), open = unlocked(lv.id), th = THEMES[lv.sky], b = document.createElement('button');
      b.className = 'tile'; b.disabled = !open; b.type = 'button';
      b.style.setProperty('--a', th.top); b.style.setProperty('--b', th.mid); b.style.setProperty('--c', th.hor);
      b.setAttribute('aria-label', 'Mission ' + lv.id + ', ' + lv.name + (open ? ', ' + starsOf(sv) + ' of 3 stars' : ', locked'));
      b.innerHTML = '<span class="n">' + lv.id + '</span><span class="nm">' + lv.name + '</span><span class="st">' + starRow(starsOf(sv)) + (sv.best ? '<span class="best">' + sv.best + '</span>' : '') + '</span>' + (open ? '' : LOCK);
      b.addEventListener('click', function () { Snd.click(); openBrief(lv.id); });
      grid.appendChild(b);
    });
    $('#l-total').textContent = totalStars() + ' / ' + LV.length * 3;
  }

  var TOGGLES = [
    { k: 'sound', t: 'Sound', d: 'Engine, wind and landing sounds.' },
    { k: 'stability', t: 'Stability assist', d: 'Stops the booster spinning when you let go of the tilt buttons.' },
    { k: 'guidance', t: 'Flight guidance', d: 'Shows the predicted impact point and a burn cue.' },
    { k: 'haptics', t: 'Vibration', d: 'Short buzzes on touchdown and impact.', needs: 'vibrate' }
  ];
  function buildToggles(box) {
    box.innerHTML = '';
    TOGGLES.forEach(function (tg) {
      if (tg.needs && !navigator[tg.needs]) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(!!save.settings[tg.k]));
      b.innerHTML = '<span class="tx"><b>' + tg.t + '</b><span>' + tg.d + '</span></span><i></i>';
      b.addEventListener('click', function () {
        save.settings[tg.k] = !save.settings[tg.k]; b.setAttribute('aria-checked', String(save.settings[tg.k])); persist();
        if (tg.k === 'sound') { Snd.init(); Snd.setOn(save.settings.sound); }
        if (tg.k === 'stability' && G.sim) G.sim.assist = save.settings.stability;
        Snd.click();
      });
      box.appendChild(b);
    });
  }

  function fmt(n, d) { return n.toFixed(d === undefined ? 0 : d); }
  function openBrief(id) {
    G.endless = null;
    var lv = LV[id - 1], sv = lvSave(id);
    G.cur = id; G.seed = (Math.random() * 1e9) | 0;
    newRound(lv, G.seed, false);
    G.attract = false; G.frozen = true; G.mode = 'brief'; G.paused = false; G.resultShown = false;
    $('#b-eye').textContent = 'Mission ' + id + ' of ' + LV.length;
    $('#b-name').textContent = lv.name;
    $('#b-blurb').textContent = lv.blurb;
    var windTx = lv.wind || lv.gust ? Math.round(lv.wind * 10) + (lv.gust ? '–' + Math.round((lv.wind + lv.gust) * 10) : '') + ' kt' : 'Calm';
    var rows = [['Deck', fmt(lv.deck) + ' m'], ['Swell', fmt(lv.swell, 1) + ' m'], ['Wind', windTx], ['Ship', lv.zig ? 'Weaving' : lv.away ? 'Fleeing' : lv.shipV ? fmt(lv.shipV * 1.94) + ' kt' : 'Holding'], ['Fuel', fmt(lv.fuel * 100) + '%' + (lv.leak ? ' leaking' : '')], [lv.thrust < 1 ? 'Engine' : 'Start', lv.thrust < 1 ? fmt(lv.thrust * 100) + '%' : fmt(lv.alt) + ' m']];
    $('#b-specs').innerHTML = rows.map(function (r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join('');
    var goals = [[true, 'Land on the ship', 'Down at ' + lv.vMax + ' m/s or less'], [sv.ring, 'Touch down inside the ring', '±' + fmt(lv.ring) + ' m'], [sv.fuel, 'Land with fuel to spare', fmt(lv.fuelGoal * 100) + '% left']];
    $('#b-goals').innerHTML = goals.map(function (g, i) { return '<li' + (i === 0 ? (sv.done ? ' class="ok"' : '') : (g[0] ? ' class="ok"' : '')) + '>' + (i === 0 ? (sv.done ? CHECK : STAR.replace('{c}', '')) : g[0] ? CHECK : STAR.replace('{c}', '')) + '<span>' + g[1] + '</span><em>' + g[2] + '</em></li>'; }).join('');
    var how = '';
    if (id <= 2 || !sv.done) {
      how = coarse
        ? '<div><b>Hold THRUST</b> to fire the engine. A short tap is a short burn.</div><div><b>Tilt buttons</b> turn the booster. Lean toward the ship, then burn to move sideways.</div>'
        : '<div><kbd>↑</kbd> or <kbd>Space</kbd> fire the engine. A short tap is a short burn.</div><div><kbd>←</kbd> <kbd>→</kbd> tilt the booster. Lean toward the ship, then burn to move sideways.</div>';
      how += '<div>Light the engine late. Touch down under <b>' + lv.vMax + ' m/s</b>, upright, with legs on the deck. A little too fast still counts as a rough landing.</div>';
    }
    if (lv.hazard) how = '<div class="tip"><b>Hazard.</b> ' + lv.hazard + '</div>' + how;
    $('#b-how').innerHTML = how; $('#b-how').hidden = !how;
    setScreen('brief');
  }
  function openLevels() { G.endless = null; G.mode = 'levels'; startAttract(); buildLevels(); setScreen('levels'); }
  function openEndless() { G.mode = 'endless'; startAttract(); G.endless = null; setScreen('endless'); }
  function endlessRound(transition) {
    var e = G.endless, round = e.round, difficulty = e.difficulty;
    var seed = (Math.random() * 1e9) | 0, pick = Sim.rng(seed)(), base = LV[(Math.floor(pick * LV.length))];
    var lv = {}, factor = (difficulty === 'easy' ? 0.82 : difficulty === 'hard' ? 1.22 : 1) * (1 + Math.min(0.4, (round - 1) * 0.025));
    Object.keys(base).forEach(function (k) { lv[k] = base[k]; });
    lv.id = 0; lv.name = 'Round ' + round; lv.sky = base.sky;
    lv.alt = Math.max(700, Math.round(base.alt * (difficulty === 'easy' ? 0.92 : difficulty === 'hard' ? 1.08 : 1)));
    lv.dx = [base.dx[0] * factor, base.dx[1] * factor];
    lv.deck = Math.max(42, base.deck / factor);
    lv.fuel = Math.max(0.3, Math.min(0.95, base.fuel / (difficulty === 'easy' ? 0.82 : difficulty === 'hard' ? 1.2 : 1) * Math.max(0.55, 1 - (round - 1) * 0.02)));
    lv.fuelGoal = lv.fuel * 0.55;
    lv.wind = base.wind * factor; lv.gust = base.gust * factor; lv.swell = base.swell * factor;
    var toHalf = function (n) { return Math.round(n * 2) / 2; };
    lv.vMax = Math.max(4, toHalf(base.vMax / factor));
    lv.hMax = Math.max(2.5, toHalf(base.hMax / factor));
    lv.aMax = Math.max(0.12, Math.round(base.aMax / factor * 57.296 / 5) * 5 * Math.PI / 180);
    e.seed = seed; e.current = lv;
    G.cur = 0; G.seed = seed;
    newRound(lv, seed, true); G.attract = false; G.frozen = false; G.paused = false; G.resultShown = false; G.mode = transition ? 'transition' : 'fly'; G.endTimer = 0;
    resetInput(); Snd.init();
    if (transition) {
      G.transitionTime = 0;
      $('#e-progress').style.transform = 'scaleX(0)';
      $('#e-next-round').textContent = String(round).padStart(2, '0');
      $('#e-next-difficulty').textContent = difficulty + ' · ' + base.name;
      setScreen('transition');
    } else setScreen(null);
  }
  function startEndless(difficulty) {
    G.endless = { difficulty: difficulty, round: 1, landed: 0, score: 0, bestLanding: 0, verticalSum: 0, fuelSum: 0, startedAt: performance.now() };
    G.highEgg = false; G.flipEgg = false; endlessRound(false);
  }
  function nextEndless() { Snd.click(); G.endless.round++; endlessRound(true); }
  function openMenu() { G.endless = null; G.mode = 'menu'; startAttract(); buildMenu(); setScreen('menu'); }
  function openSettings(from) {
    G.settingsFrom = from; buildToggles($('#s-toggles')); $('#s-reset').textContent = 'Reset progress'; $('#s-reset')._arm = false; setScreen('settings');
  }

  function launch() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    newRound(G.endless ? G.endless.current : LV[G.cur - 1], G.seed, true);
    G.attract = false; G.frozen = false; G.paused = false; G.resultShown = false; G.mode = 'fly'; G.endTimer = 0;
    resetInput(); Snd.init(); setScreen(null);
  }
  function retry() { launch(); }
  function nextMission() { if (G.cur < LV.length) { Snd.click(); openBrief(G.cur + 1); } else openLevels(); }
  function pause(v) {
    if (G.mode !== 'fly') return;
    G.paused = v; resetInput();
    if (v) { buildToggles($('#p-toggles')); setScreen('pause'); Snd.loops(0, 0, 0, false); } else setScreen(null);
  }

  function newRound(lv, seed, assist) {
    G.level = lv; G.th = THEMES[lv.sky]; G.clouds = buildClouds(G.th);
    G.sim = Sim.createSim(lv, seed, { assist: save.settings.stability });
    var lm = function (id, v) { var n = document.getElementById(id); if (n) n.textContent = v; };
    var fg = document.getElementById('fuel-goal'); if (fg) fg.style.left = (lv.fuelGoal * 100).toFixed(1) + '%';
    lm('lim-vs', '\u2264' + fmt(lv.vMax, 1)); lm('lim-hs', '\u2264' + fmt(lv.hMax, 1)); lm('lim-tilt', '\u2264' + Math.round(lv.aMax * 57.296) + '\u00B0');
    G.highEgg = false; G.flipEgg = false;
    parts.length = 0; G.acc = 0; G.shake = 0; G.flash = 0; G.D = Sim.deckPose(G.sim);
    updateCamera(0, true);
  }
  function startAttract() {
    if (G.attract && G.sim && G.sim.status === 'flying') return;
    var ids = [4, 1, 8, 2], lv = LV[ids[(Math.random() * ids.length) | 0] - 1];
    G.level = lv; newRound(lv, (Math.random() * 1e9) | 0, true);
    G.sim.assist = true; G.attract = true; G.frozen = false; G.attractWait = 0;
  }

  function gradeText(vn, lv) { var f = vn / lv.vMax; return f < 0.2 ? 'Feather-soft touchdown' : f < 0.45 ? 'Smooth touchdown' : f < 0.75 ? 'Firm touchdown' : 'Hard, but inside the limit'; }
  function roughWhy(r, lv) {
    var deg = function (x) { return fmt(Math.abs(x) * 57.296, 0) + '\u00B0'; };
    if (r.over === 'hard') return fmt(r.vn, 1) + ' m/s down (limit ' + fmt(lv.vMax, 1) + ').';
    if (r.over === 'skid') return fmt(Math.abs(r.vt), 1) + ' m/s sideways (limit ' + fmt(lv.hMax, 1) + ').';
    if (r.over === 'tilt') return deg(r.rel) + ' off level (limit ' + deg(lv.aMax) + ').';
    return 'a spin at touchdown.';
  }
  function showResult() {
    var s = G.sim, r = s.result, lv = G.level, card = $('#r-card'), h = '';
    G.resultShown = true;
    if (r.ok) {
      var endless = G.endless, sv0 = endless ? { best: 0 } : lvSave(lv.id), wasNext = !endless && lv.id < LV.length && !unlocked(lv.id + 1), prevBest = sv0.best;
      if (!endless) {
        var rec = save.levels[lv.id] || (save.levels[lv.id] = { done: false, ring: false, fuel: false, best: 0 });
        rec.done = true; if (r.stars.ring) rec.ring = true; if (r.stars.fuel) rec.fuel = true; if (r.score > rec.best) rec.best = r.score; persist();
      } else {
        endless.landed++; endless.score += r.score; endless.bestLanding = Math.max(endless.bestLanding, r.score);
        endless.verticalSum += Math.abs(r.vn); endless.fuelSum += r.fuelLeft;
      }
      var side = Math.abs(r.uc) < 0.5 ? 'on the mark' : fmt(Math.abs(r.uc), 1) + ' m off centre';
      h += '<div class="result-head"><p class="eyebrow">' + (endless ? 'Endless · ' + endless.difficulty + ' · round ' + endless.round : 'Mission ' + lv.id) + ' · ' + lv.name + '</p><h2>' + (endless ? (r.rough ? 'Rough landing' : 'Round clear') : (r.rough ? 'Rough landing' : 'Touchdown')) + '</h2></div>';
      if (endless) h += '<div class="arcade-stats"><div><b>' + String(endless.landed).padStart(2, '0') + '</b><span>LANDINGS</span></div><div><b id="r-total-score">' + endless.score + '</b><span>RUN SCORE</span></div></div>';
      h += r.rough ? '<p class="grade warn">Over the limit: ' + roughWhy(r, lv) + ' The legs held, but there are no points for a soft touchdown or attitude.</p>' : '<p class="grade">' + gradeText(r.vn, lv) + '. ' + fmt(r.vn, 1) + ' m/s down, ' + side + '.</p>';
      h += '<ul class="goals"><li class="ok">' + CHECK + '<span>Landed on the ship</span><em>1</em></li>';
      h += '<li class="' + (r.stars.ring ? 'ok' : 'no') + '">' + (r.stars.ring ? CHECK : CROSS) + '<span>Inside the ring (±' + fmt(lv.ring) + ' m)</span><em>' + fmt(Math.abs(r.uc), 1) + ' m</em></li>';
      h += '<li class="' + (r.stars.fuel ? 'ok' : 'no') + '">' + (r.stars.fuel ? CHECK : CROSS) + '<span>' + fmt(lv.fuelGoal * 100) + '% fuel left or more</span><em>' + fmt(r.fuelLeft * 100) + '%</em></li></ul>';
      var p = r.parts;
      h += '<table class="score"><tr><td>Landing</td><td>' + p.landing + '</td></tr><tr><td>Soft touchdown</td><td>+' + p.soft + '</td></tr><tr><td>Centring</td><td>+' + p.centre + '</td></tr><tr><td>Fuel left</td><td>+' + p.fuel + '</td></tr><tr><td>Attitude</td><td>+' + p.attitude + '</td></tr>';
      h += '<tr class="total"><td>Score</td><td><span id="r-score">0</span>' + (r.score > prevBest && prevBest > 0 ? '<span class="tag-new">NEW BEST</span>' : '') + '</td></tr></table>';
      h += '<div class="actions">';
      if (endless) h += '<button class="btn primary" id="r-next">Next descent <small>Round ' + String(endless.round + 1).padStart(2, '0') + '</small></button>';
      else if (lv.id < LV.length) h += '<button class="btn primary" id="r-next">Next mission' + (wasNext ? ' · unlocked' : '') + '</button>'; else h += '<button class="btn primary" id="r-levels">All missions</button>';
      h += '<div class="row"><button class="btn" id="r-retry">' + (endless ? 'Restart run' : 'Fly it again') + '</button>' + (lv.id < LV.length ? '<button class="btn ghost" id="r-levels">Missions</button>' : '') + '</div></div>';
    } else {
      var m = failMsg(r, lv), ht = hazardTip(r, lv); if (ht) m.tip = ht;
      if (G.endless) {
        var e = G.endless, seconds = Math.floor((performance.now() - e.startedAt) / 1000), mins = Math.floor(seconds / 60), best = save.endless[e.difficulty] || { rounds: 0, score: 0 };
        var newBest = e.landed > best.rounds || (e.landed === best.rounds && e.score > best.score);
        if (newBest) { best = { rounds: e.landed, score: e.score }; save.endless[e.difficulty] = best; persist(); }
        h += '<div class="result-head death-head"><p class="eyebrow">' + e.difficulty + ' run · ' + (newBest ? 'new personal best' : 'best: ' + best.rounds + ' landings') + '</p><h2>Run over</h2></div>';
        h += '<p class="death-cause"><b>' + m.title + '</b><span>' + m.detail + '</span></p>';
        h += '<div class="arcade-stats death-stats"><div><b>' + String(e.landed).padStart(2, '0') + '</b><span>LANDINGS</span></div><div><b>' + e.score.toLocaleString() + '</b><span>TOTAL SCORE</span></div><div><b>' + e.bestLanding.toLocaleString() + '</b><span>BEST TOUCHDOWN</span></div><div><b>' + (mins + ':' + String(seconds % 60).padStart(2, '0')) + '</b><span>SURVIVAL TIME</span></div><div><b>' + (e.landed ? (e.verticalSum / e.landed).toFixed(1) : '—') + '</b><span>AVG DESCENT M/S</span></div><div><b>' + (e.landed ? Math.round(e.fuelSum / e.landed * 100) + '%' : '—') + '</b><span>AVG FUEL LEFT</span></div></div>';
        h += '<p class="tip death-tip">' + m.tip + '</p><div class="actions"><button class="btn primary" id="r-retry">Run it back</button><button class="btn ghost" id="r-mode">Change difficulty</button><button class="btn ghost" id="r-levels">Missions</button></div>';
      } else {
        h += '<div class="result-head"><p class="eyebrow">Mission ' + lv.id + ' · ' + lv.name + '</p><h2>' + m.title + '</h2></div>';
        h += '<p class="grade bad">' + m.detail + '</p><div class="tip">' + m.tip + '</div>';
        h += '<div class="actions"><button class="btn primary" id="r-retry">Try again</button><button class="btn ghost" id="r-levels">Missions</button></div>';
      }
    }
    card.innerHTML = h;
    var q = function (id) { return document.getElementById(id); };
    if (q('r-next')) q('r-next').addEventListener('click', endless ? nextEndless : nextMission);
    if (q('r-retry')) q('r-retry').addEventListener('click', function () { Snd.click(); if (G.endless) startEndless(G.endless.difficulty); else retry(); });
    if (q('r-levels')) q('r-levels').addEventListener('click', function () { Snd.click(); openLevels(); });
    if (q('r-mode')) q('r-mode').addEventListener('click', function () { Snd.click(); G.endless = null; openEndless(); });
    setScreen('result');
    if (r.ok) countUp(q('r-score'), r.score);
  }
  function hazardTip(r, lv) {
    var rs = r.reason;
    if (lv.fault && (rs === 'hard' || rs === 'tilt' || rs === 'sea')) return 'The engine can cut out for a couple of seconds. Start your burn earlier so you have height left to recover.';
    if (lv.zig && (rs === 'skid' || rs === 'edge')) return 'The ship weaves. Match its sideways speed, not just its position: watch the Sideways reading.';
    if (lv.away && (rs === 'sea' || rs === 'edge')) return 'The ship keeps moving away. Start chasing it early and aim ahead of it.';
    if (lv.leak && r.fuelLeft !== undefined && r.fuelLeft <= 0.001) return 'The tank leaks even when the engine is off. Keep the descent short and do not hover.';
    if (lv.thrust < 1 && rs === 'hard') return 'The engine is weak, so braking takes longer. Light it earlier than you think you need to.';
    if (lv.rcsR < 1 && (rs === 'tilt' || rs === 'spin' || rs === 'skid')) return 'It turns right slowly. Start right turns earlier, or turn left the long way round.';
    if (lv.shear && (rs === 'skid' || rs === 'edge' || rs === 'sea')) return 'The wind flips direction low down. Expect to be pushed the other way near the water.';
    return '';
  }
  function failMsg(r, lv) {
    var dry = r.fuelLeft !== undefined && r.fuelLeft <= 0.001, deg = function (x) { return fmt(Math.abs(x) * 57.296, 0) + '°'; };
    switch (r.reason) {
      case 'hard': return { title: 'Hard landing', detail: 'You hit the deck at ' + fmt(r.vn, 1) + ' m/s. This mission needs ' + fmt(lv.vMax, 1) + ' or less.', tip: dry ? 'The tank ran dry before touchdown. Burn in short pulses and save fuel for the last 100 metres.' : 'Light the engine earlier, and keep some thrust on until the legs touch.' };
      case 'skid': return { title: 'Skidded off', detail: 'You were moving sideways at ' + fmt(Math.abs(r.vt), 1) + ' m/s. The limit is ' + fmt(lv.hMax, 1) + '.', tip: 'Cancel your sideways drift while you are still high. Tilt against it and burn.' };
      case 'tilt': return { title: 'Tipped over', detail: 'The booster was ' + deg(r.rel) + ' off the deck angle. The limit is ' + deg(lv.aMax) + '.', tip: 'Level out before you are low. On a rolling deck, match its tilt.' };
      case 'spin': return { title: 'Spinning', detail: 'The booster was still rotating at touchdown.', tip: 'Stop a spin with a short tap on the opposite tilt button. Keep stability assist on.' };
      case 'edge': return { title: 'Clipped the edge', detail: 'One leg was off the pad.', tip: 'Aim for the glowing ring in the middle. Use the marker above the ship to line up early.' };
      case 'sea': return { title: 'Splashdown', detail: 'You missed the ship and hit the water.', tip: 'Steer sideways while you still have height. The ship arrow shows which way to lean.' };
      case 'tilt-body': return { title: 'Fell over', detail: 'The booster came in off its legs.', tip: 'Keep it upright. Legs first, nose up.' };
      default: return { title: 'Lost the booster', detail: 'The legs were not down in time.', tip: 'Give the legs a few seconds to lock before you touch down.' };
    }
  }
  function countUp(node, to) {
    if (!node) return;
    var t0 = performance.now(), dur = reduceMotion ? 1 : 900;
    function f(now) { var k = clamp((now - t0) / dur, 0, 1); node.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); }
    requestAnimationFrame(f);
  }

  // ------------------------------------------------------------------ input
  var TEST = window.__HS_TEST ? {} : null;
  var inp = { left: false, right: false, thrust: 0 }, key = { l: false, r: false, t: false }, btn = { l: false, r: false, t: false };
  function resetInput() {
    key.l = key.r = key.t = btn.l = btn.r = btn.t = false;
    ['btn-left', 'btn-right', 'btn-thrust'].forEach(function (id) { document.getElementById(id).classList.remove('on'); });
  }
  function readInput() { if (TEST && TEST.ctrl) return TEST.ctrl(G.sim); inp.left = key.l || btn.l; inp.right = key.r || btn.r; inp.thrust = key.t || btn.t ? 1 : 0; return inp; }
  function hold(id, name) {
    var b = document.getElementById(id);
    function down(e) { e.preventDefault(); btn[name] = true; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch (x) {} Snd.init(); }
    function up() { btn[name] = false; b.classList.remove('on'); }
    b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  hold('btn-left', 'l'); hold('btn-right', 'r'); hold('btn-thrust', 't');
  window.addEventListener('keydown', function (e) {
    Snd.init();
    var c = e.code;
    if (G.mode === 'fly') {
      if (c === 'Escape' || c === 'KeyP') { e.preventDefault(); pause(!G.paused); return; }
      if (G.paused) return;
      if (c === 'ArrowLeft' || c === 'KeyA') { key.l = true; e.preventDefault(); }
      else if (c === 'ArrowRight' || c === 'KeyD') { key.r = true; e.preventDefault(); }
      else if (c === 'ArrowUp' || c === 'KeyW' || c === 'Space') { key.t = true; e.preventDefault(); }
      else if (c === 'KeyR' && !e.repeat) { retry(); }
    }
  });
  window.addEventListener('keyup', function (e) {
    var c = e.code;
    if (c === 'ArrowLeft' || c === 'KeyA') key.l = false;
    else if (c === 'ArrowRight' || c === 'KeyD') key.r = false;
    else if (c === 'ArrowUp' || c === 'KeyW' || c === 'Space') key.t = false;
  });
  window.addEventListener('blur', function () { resetInput(); if (G.mode === 'fly' && !G.paused) pause(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { resetInput(); if (G.mode === 'fly' && !G.paused) pause(true); } });
  document.addEventListener('pointerdown', function () { Snd.init(); }, { capture: true });

  // buttons
  function on(id, fn) { document.getElementById(id).addEventListener('click', function () { Snd.init(); Snd.click(); fn(); }); }
  on('m-play', function () { openBrief(nextLevelId()); });
  on('m-levels', openLevels);
  on('m-endless', openEndless);
  on('e-back', openMenu);
  on('e-skip', launch);
  Array.prototype.forEach.call(document.querySelectorAll('[data-endless]'), function (b) { b.addEventListener('click', function () { Snd.init(); Snd.click(); startEndless(b.getAttribute('data-endless')); }); });
  on('m-settings', function () { openSettings('menu'); });
  on('l-back', openMenu);
  on('b-go', launch);
  on('b-back', function () { if (G.cur && cleared()) openLevels(); else openMenu(); });
  on('btn-pause', function () { pause(true); });
  on('p-resume', function () { pause(false); });
  on('p-restart', function () { G.paused = false; retry(); });
  on('p-quit', function () { G.paused = false; openLevels(); });
  on('s-done', function () { openMenu(); });
  document.getElementById('s-reset').addEventListener('click', function () {
    var b = this;
    if (!b._arm) { b._arm = true; b.textContent = 'Tap again to erase everything'; setTimeout(function () { b._arm = false; b.textContent = 'Reset progress'; }, 3500); return; }
    save.levels = {}; persist(); b._arm = false; b.textContent = 'Progress erased'; buildMenu();
  });

  // ------------------------------------------------------------------ loop
  var last = 0, lowFps = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
    if (document.hidden || !G.sim) return;
    var s = G.sim;
    if (G.mode === 'brief') {
      Sim.advanceTime(s, dt);
    } else if (G.mode === 'transition') {
      G.transitionTime += dt;
      $('#e-progress').style.transform = 'scaleX(' + clamp(G.transitionTime / 1.8, 0, 1) + ')';
      if (G.transitionTime >= 1.8) launch();
    } else if (G.attract) {
      stepSim(dt, function () { return Sim.autopilot(G.sim); });
      emitFx(s, dt);
      if (s.status !== 'flying') { G.attractWait += dt; if (G.attractWait > 3) startAttract(); }
    } else if (G.mode === 'fly' && !G.paused) {
      stepSim(dt, readInput);
      emitFx(s, dt);
      if (s.status === 'flying') {
        if (s.y > 3200) showSecret('high', 'YOU FOUND THE TOP OF THE SKY');
        if (Math.abs(s.th) >= TAU) showSecret('flip', 'ROCKET RODEO! FULL BACKFLIP');
      }
      if (s.status !== 'flying') { G.mode = 'ended'; G.endTimer = 0; resetInput(); chrome(); }
    } else if (G.mode === 'ended') {
      stepSim(dt, function () { return inp; });
      G.endTimer += dt;
      if (!G.resultShown && G.endTimer > (s.status === 'landed' ? 1.5 : 2.0)) showResult();
    }
    if (G.secretTime > 0) { G.secretTime = Math.max(0, G.secretTime - dt); if (!G.secretTime) $('#easter-egg').hidden = true; }
    if (!(G.mode === 'fly' && G.paused)) updateParts(dt);
    render(dt);
    if (G.mode === 'fly' || G.mode === 'ended') updateHud(dt);
    var active = G.mode === 'fly' && !G.paused && s.status === 'flying';
    var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    Snd.loops(s.throttle || 0, sp, s.rot, active || (G.attract && s.status === 'flying' && false));
  }
  function stepSim(dt, fn) {
    var s = G.sim;
    G.acc += dt;
    var n = 0;
    while (G.acc >= Sim.DT && n < 14) { Sim.step(s, fn(), Sim.DT); G.acc -= Sim.DT; n++; }
    if (G.acc > Sim.DT * 14) G.acc = 0;
    handleEvents(s);
  }

  // shrink the title if the font it ended up with is wider than the screen
  function fitLogo() {
    try {
      var lg = document.querySelector('.logo'), box = lg && lg.parentNode;
      if (!lg || !box || !box.clientWidth) return;
      lg.style.fontSize = '';
      var fs = parseFloat(window.getComputedStyle(lg).fontSize), need = lg.scrollWidth, have = box.clientWidth;
      if (need > have && fs) lg.style.fontSize = Math.floor(fs * have / need * 0.97) + 'px';
    } catch (e) {}
  }

  // ------------------------------------------------------------------ boot
  if (TEST) { TEST.G = G; TEST.key = key; window.__hs = TEST; }
  resize();
  window.addEventListener('resize', function () { resize(); fitLogo(); });
  if (window.ResizeObserver) { try { new ResizeObserver(resize).observe($('#app')); } catch (e) {} }
  startAttract(); openMenu();
  fitLogo();
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLogo); } catch (e) {}
  requestAnimationFrame(frame);
  try {
    var hot = window.claude && window.claude.hot;
    if (hot && typeof hot.snapshot === 'function') hot.snapshot(function () { return { cur: G.cur }; });
  } catch (e) {}
})();
