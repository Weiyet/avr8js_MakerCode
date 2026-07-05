# Integration Guide — MakerCode Arduino Frontend

This repo is the **frontend** for MakerCode's Arduino challenges: an avr8js-based
circuit + code playground (drag components, wire them, write the sketch, see it
run live) with a **Grade** button wired to the MakerCode backend.

It is a pure **client** of that backend — it does not grade anything itself.
Challenge content (question text, starter code, starter wiring) is fetched from
the backend, and submissions are graded by the backend. Swap this UI for your
own and the integration is just the 3 HTTP calls documented below.

## Quick start (fastest — no backend setup needed)

The app is pre-configured to talk to the **live MakerCode backend** by default.
Just run the frontend:

```bash
npm install        # first time only
npx vite           # http://localhost:5173
```

Open **http://localhost:5173**, pick a challenge from the left sidebar (all 51
load live from the real backend), wire the circuit + write the code, click
**✔ Submit / Grade**, and you'll get a real PASS/FAIL from the production grader.

That's the whole setup. No Python, no local backend, no Docker.

## How the live simulator actually works (core idea)

If you're re-skinning this for your own site, this is the part worth
understanding before you touch layout/CSS — it explains what you can freely
restyle vs. what's actually load-bearing.

1. **Compile is dumb.** The `.ino` sketch is sent to a build service (Wokwi's
   `hexi`, same as the backend uses) and comes back as an **Intel HEX file** —
   literally just AVR machine code, byte-identical to what you'd flash onto a
   real Uno. The compiler knows nothing about your circuit; `diagram.json`
   never gets sent to it.

2. **[`avr8js`](https://www.npmjs.com/package/avr8js) is a real ATmega328P
   emulator, running in the browser.** It loads that hex and executes it
   cycle-accurately (CPU, timers, GPIO ports, ADC, USART, I2C — all emulated).
   The renderer paces it to wall-clock time (run N cycles per animation frame)
   so `delay(500)` really looks like it blinks every half second.

3. **`diagram.json` is the single source of truth for wiring**, and it feeds
   *two independent consumers* that never talk to each other directly:
   - **This frontend** — `netlist-builder`/`gpio-router` trace `diagram.json`
     to know which avr8js pin drives which on-screen part, then push pin
     events into [`@wokwi/elements`](https://www.npmjs.com/package/@wokwi/elements)
     web components (`<wokwi-led>`, `<wokwi-lcd1602>`, `<wokwi-neopixel>`, …) —
     pin goes HIGH → the LED element's `value` prop flips → it visually lights up.
   - **The backend grader** — traces the *exact same* `diagram.json` shape to
     find the identical pins, and records what happens on them instead of
     rendering it.

   Same wiring format, same tracing logic, two different jobs (paint pixels vs.
   record a timeline to compare against the golden solution). That's *why* what
   you see animate here is exactly what gets graded — there's no separate
   "grading model" that could disagree with the visual one.

4. **Interactivity runs the same pipe in reverse.** Clicking the on-screen
   pushbutton fires `port.setPin(...)`; dragging a potentiometer sets
   `adc.channelValues[...]`. The *running sketch's* `digitalRead`/`analogRead`
   sees these exactly as if a human pressed a real button — you're driving the
   virtual MCU, not a canned animation.

**What this means for a reskin:** you can change every pixel of layout, theming,
panel arrangement, branding — none of that touches the mechanism. What you
*must* keep (if the live circuit animation + backend grading should keep
working) is:
- avr8js as the emulator driving pin state,
- something that renders components from pin state (`@wokwi/elements`, or your
  own renderer, as long as it consumes the same events),
- the `diagram.json` **shape** (`parts: [{id, type, attrs}]`,
  `connections: [{from: "partId:pin", to: "partId:pin"}]`) — the backend's
  wiring tracer depends on this exact structure, so if you build a custom
  wiring UI, make sure it still emits this format.

## Pointing at a different backend

The backend URL is controlled by the `?api=` query parameter (persisted in
`localStorage`, so you only need to set it once):

```
http://localhost:5173/?api=http://localhost:8000
```

To go back to the live backend, either clear the param:
```
http://localhost:5173/?api=https://stingray-app-g8ivf.ondigitalocean.app
```
or clear the stored value in DevTools:
```js
localStorage.removeItem('makercode_api_base'); location.reload();
```

**Running a local backend** (only needed if you're also changing backend code,
e.g. adding challenges or editing the grader) — from the `MakerCode_DEV` repo:
```bash
python main_app.py    # http://localhost:8000 (needs Node on PATH — the Arduino
                       # grader shells out to it; see arduino_question/README.md)
```
Then point the frontend at it with `?api=http://localhost:8000`.

## The API contract (3 endpoints)

This is the entire integration surface. Any frontend — this one or a from-scratch
rewrite — only needs to call these three:

| Purpose | Endpoint | Response |
|---|---|---|
| List challenges (sidebar) | `GET /api/arduino_questions` | `[{ id, title, difficulty, total_submission, success_rate }]` |
| Load one challenge | `GET /api/arduino_question/{id}` | `{ id, title, difficulty, question, template_code, template_diagram }` |
| Grade a submission | `POST /run_arduino_question` | `{ pass, message, details }` |

**Loading a challenge** — `question` is markdown (goal, provided components,
reference wiring, hints); `template_code` is the starter `.ino` (functions
present, bodies are `// TODO`); `template_diagram` is a Wokwi-format
`diagram.json` **string** with parts placed but **zero connections** — the
student wires everything, including power and ground.

**Grading** — `POST /run_arduino_question` body:
```json
{ "question_id": "0000", "code": "<the .ino source>", "diagram": "<diagram.json as a string>" }
```
Response:
```json
{ "pass": true, "message": "Matches the reference behaviour (component outputs agree under the test stimulus).", "details": { "signals": 1 } }
```
On failure, `message` explains why (missing wire, wrong pin, behaviour mismatch
percentage, or a compile error) — see `arduino_question/README.md` in
`MakerCode_DEV` for the full grading model (it compiles + simulates your
submission against a golden reference in avr8js and compares component
behaviour — LED brightness, buzzer tone, NeoPixel colours, LCD text, etc).

CORS is already open on the backend for any origin, so no server-side changes
are needed to point a new frontend at it.

## What's been added on top of the stock avr8js playground

- **Grade button** (top-right, `✔ Submit / Grade`) — posts the current code +
  wiring to `/run_arduino_question` and shows a green/red result banner.
- **Canvas editing**: select a part and press **Delete**/**Backspace** to
  remove it (and its wires), **R** to rotate, **Ctrl+C** / **Ctrl+V** to
  duplicate a part.
- Reliable clipboard **inside the code editor** (Ctrl+C/X/V go through
  `navigator.clipboard` directly rather than Monaco's built-in clipboard
  actions, which were found to silently no-op in some environments).

## Repo layout / remotes

- `origin` → this repo (`Weiyet/avr8js_MakerCode`) — push changes here.
- `upstream` → the original open-source avr8js Electron playground this was
  forked from, kept as a remote in case you want to pull in updates from there:
  ```bash
  git fetch upstream
  git merge upstream/master   # or cherry-pick specific commits
  ```
- `src/renderer/services/browser-ipc.ts` — the shim that makes the sidebar's
  project list / load / (no-op) save calls hit the MakerCode backend instead of
  Electron IPC. This is the file to look at first to understand the wiring.
- `grader/` — a **standalone local grader** kept only for offline experimentation
  (see its own comments). The integrated app above does **not** use it — all
  real grading happens in the backend.

## Desktop (Electron) mode

The app also runs as an Electron desktop app (`npm run dev`), not just in a
browser. The backend selection above works the same way there.
