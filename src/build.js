#!/usr/bin/env node
// Inlines sim.js and app.js into template.html and writes standalone deployable pages.
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const tpl = read('template.html');
const sim = read('sim.js');
const app = read('app.js');

for (const [name, body] of [['sim.js', sim], ['app.js', app]]) {
  if (/<\/script/i.test(body)) throw new Error(name + ' contains a script terminator and cannot be inlined');
}

const split = tpl.indexOf('<div id="app">');
if (split < 0) throw new Error('template.html has no #app container');
const headPart = tpl.slice(0, split);
const bodyPart = tpl.slice(split).replace('/*SIM*/', () => sim).replace('/*APP*/', () => app);

const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2307111c'/%3E%3Crect x='13' y='4' width='6' height='17' rx='2.4' fill='%23f1f4f7'/%3E%3Crect x='13' y='7' width='6' height='3.2' fill='%23171b21'/%3E%3Cpath d='M16 30l-4-8.5h8z' fill='%23ff7a35'/%3E%3C/svg%3E";
const blurb = 'Land a rocket booster on a drone ship. Build a career, explore new worlds, and take the daily challenge.';

const head = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="theme-color" content="#07111c">',
  '<meta name="description" content="' + blurb + '">',
  '<meta property="og:title" content="Hoverslam">',
  '<meta property="og:description" content="' + blurb + '">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<link rel="icon" href="' + icon + '">',
  '<style>',
  '  html { height: 100%; box-sizing: border-box; padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px); color-scheme: dark; }',
  '  body { margin: 0; }',
  '  img { max-width: 100%; }',
  '</style>',
  ''
].join('\n');

const html = head + headPart + '</head>\n<body>\n' + bodyPart + '\n</body>\n</html>\n';
const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
// Keep a root entry point too, so the repository can also be deployed directly by GitHub Pages.
fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
console.log('wrote public/index.html (' + Buffer.byteLength(html) + ' bytes)');
