# Hoverslam

Land a rocket booster on a drone ship. Fifteen missions with wind, ocean swell and ships that move or get smaller. Plays on phones (touch buttons) and desktops (keyboard). The whole game is one static page with no dependencies.

## How to play

- Hold **THRUST** (or `↑` / `Space`) to fire the engine. A short tap is a short burn.
- Use the round buttons (or `←` `→` / `A` `D`) to tilt the booster. Lean toward the ship, then burn to move sideways.
- Let it fall, then light the engine late. The cue at the top goes COAST, GET READY, BURN NOW.
- Touch down upright and slower than the mission limit (shown on the HUD next to each reading). A little over the limit is a rough landing: it still counts, with fewer points.
- Three stars per mission: land on the ship, touch down inside the orange ring, finish with enough fuel left.
- `Esc` pauses, `R` retries.

## Deploy

The page to deploy is `public/index.html`.

**Netlify Drop (quickest).** Go to <https://app.netlify.com/drop> and drag in the `public` folder.

**Netlify from GitHub.**
1. Push this repo to GitHub.
2. In Netlify choose *Add new site → Import an existing project* and pick the repo.
3. Leave the build command empty. `netlify.toml` already sets the publish directory to `public`.

**Netlify CLI.**

```sh
npx netlify-cli deploy --prod --dir=public
```

GitHub Pages also works: serve the `public` folder.

## Push to GitHub

```sh
git init
git add .
git commit -m "Hoverslam"
git branch -M main
git remote add origin https://github.com/<you>/hoverslam.git
git push -u origin main
```

## Develop

Node 18 or newer. No packages to install.

```
src/sim.js         physics, levels, scoring, autopilot (no DOM, also runs in Node)
src/app.js         rendering, audio, screens, input
src/template.html  markup and CSS
src/build.js       inlines the three files into public/index.html
tests/             autopilot test, clumsy-player model, headless page smoke test
```

```sh
npm run build      # regenerate public/index.html after editing src/
npm test           # autopilot must land every mission; page smoke test
node tests/human-bot.js 150   # how a laggy on/off-thrust player fares
```

Mission settings live in the `LEVELS` table in `src/sim.js`: start altitude, fuel, deck width, swell, wind, ship speed and the touchdown limits (`vMax` m/s down, `hMax` m/s sideways, `aMax` radians of tilt). The tests check that the built-in autopilot can still beat every mission after you change them.

Progress and settings are saved in the browser's `localStorage`.
