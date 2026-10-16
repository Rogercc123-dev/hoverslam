# Hoverslam

Land a rocket booster on a drone ship. Twenty-five missions span the Atlantic, the Moon, Mars and a night storm. Career contracts pay for upgrades; daily seeded flights, replays and best-run ghosts add reasons to come back. Plays on phones (touch buttons) and desktops (keyboard).

## How to play

- Hold **THRUST** (or `↑` / `Space`) to fire the engine. A short tap is a short burn.
- Use the round buttons (or `←` `→` / `A` `D`) to tilt the booster. Lean toward the ship, then burn to move sideways.
- Let it fall, then light the engine late. The cue at the top goes COAST, GET READY, BURN NOW.
- Touch down upright and slower than the mission limit (shown on the HUD next to each reading). A little over the limit is a rough landing: it still counts, with fewer points.
- Three stars per mission: land on the ship, touch down inside the orange ring, finish with enough fuel left.
- `Esc` pauses, `R` retries.

## The missions

Missions 1 to 8 teach the basics (wind, swell, a moving ship, a smaller pad). From mission 9 each one adds its own problem:

| # | Mission | Twist |
|---|---------|-------|
| 9 | Low Tank | Under half a tank of fuel |
| 10 | Runaway | The ship sails away from you the whole way down |
| 11 | Tumble | You start nearly sideways and spinning |
| 12 | Shear | The wind flips direction near the water |
| 13 | Long Shot | You start 400 m or more away, drifting the wrong way |
| 14 | Flameout | The engine can cut out for a couple of seconds |
| 15 | Hot Drop | Very fast entry |
| 16 | Needle | A very small pad |
| 17 | Heavy Haul | A weak engine that barely out-pushes gravity |
| 18 | Sticky Thruster | The booster turns right much more slowly than left |
| 19 | Leaky Tank | Fuel drains even with the engine off |
| 20 | Evasive | The ship weaves left and right |
| 21 | Blackout | Readouts and guidance drop out near the end |
| 22 | Hoverslam | Tumbling start, fleeing ship, weak engine that can cut out, gale, tiny pad |
| 23 | Mare Tranquillitatis | Lunar gravity and a dedicated moon pad |
| 24 | Red Horizon | Martian gravity and an Ares landing pad |
| 25 | Black Squall | Night storm with rain, wind shear and a rolling deck |

The star goals on later missions are tight: the fuel goal is close to what the built-in autopilot manages, and the ring gets smaller.

## Deploy

The page to deploy is `public/index.html`.

**Static hosting.** The game works on Netlify Drop or GitHub Pages by serving `public/`. Career data, local personal bests, replay exports, and the on-device daily board work there. Static hosting cannot accept shared scores; use the Node host below for the live daily leaderboard.

**Netlify from GitHub.**
1. Push this repo to GitHub. (If you only upload `index.html` into the root of a repo, set `publish = "."` in `netlify.toml` instead.)
2. In Netlify choose *Add new site → Import an existing project* and pick the repo.
3. Leave the build command empty. `netlify.toml` already sets the publish directory to `public`.

**Netlify CLI.**

```sh
npx netlify-cli deploy --prod --dir=public
```

GitHub Pages also works for the static game build.

**Live daily leaderboard.** Build the page, then run the included no-dependency Node server:

```sh
npm run build
npm start
```

It serves the game and `/api/daily`, verifies submitted daily scores by replaying the controls through the same simulation, and saves the board in `data/daily-scores.json`. The process listens on `0.0.0.0` and `PORT` (default `8080`), so deploy it to a Node host with persistent storage to share one leaderboard across players. `npm run serve` remains a static preview and uses the local board fallback.

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
src/sim.js         physics, levels, scoring, autopilot and daily seed generation (no DOM)
src/app.js         rendering, audio, career, daily board, replay/ghost screens and input
src/template.html  markup and CSS
src/build.js       inlines the three files into public/index.html
server.js          static host and replay-verified daily leaderboard API
tests/             autopilot test, clumsy-player model, headless page smoke test
```

```sh
npm run build      # regenerate public/index.html after editing src/
npm test           # autopilot must land every mission; page smoke test
node tests/human-bot.js 150   # how a laggy on/off-thrust player fares
```

Mission settings live in the `LEVELS` table in `src/sim.js`: start altitude, fuel, deck width, swell, wind, ship speed and the touchdown limits (`vMax` m/s down, `hMax` m/s sideways, `aMax` radians of tilt). Hazards are plain settings too: `thrust` (engine strength), `leak`, `tiltMin` and `om0` (tumbling start), `vxAway`, `away` and `zig` (ship behaviour), `shear`, `fault` (engine cut-out), `blackout`, and `rcsL` / `rcsR` (turn strength each way). Each one has a one-line `hazard` text that appears in the briefing. The tests check that the built-in autopilot can still beat every mission after you change them.

Progress, career cash and upgrades, daily personal bests and mission ghosts are saved in the browser's `localStorage`. Flight recordings export as `.hvr` files; use **Watch replay file** from the hangar to import one. Results also offer a slow-motion video export of the replay (WebM or MP4, depending on browser support). The best valid mission or daily flight appears as a translucent ghost on the next attempt.
