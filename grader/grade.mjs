/**
 * Headless Arduino grader spike — now with per-challenge "testbenches".
 *
 * Each challenge has a SPEC (the testbench): an assertion type + params. The
 * grader compiles the .ino, runs avr8js, traces the user's diagram.json to find
 * which pins the relevant parts are on, drives inputs / observes outputs, and
 * returns PASS/FAIL. Wiring + code are graded jointly.
 *
 * gradeArduino(sketch, diagram, challenge) -> { pass, message, details }
 * CLI: node grade.mjs <sketch.ino> <diagram.json> <challenge-slug>
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
    CPU, avrInstruction, AVRTimer,
    timer0Config, timer1Config, timer2Config,
    AVRIOPort, portBConfig, portCConfig, portDConfig,
    AVRUSART, usart0Config, AVRADC, adcConfig,
    AVRTWI, twiConfig,
} from 'avr8js';
import { I2CBus, LCDController, DS1307Controller, LCD_I2C_ADDR, DS1307_ADDR } from './i2c.mjs';

const FREQ = 16_000_000;          // atmega328P @ 16 MHz
const HEXI_URL = process.env.HEXI_URL || 'https://hexi.wokwi.com';

// ── the "testbenches": one spec per challenge ──────────────────────────────
export const SPECS = {
    'blink-led':      { title: 'Blink an LED at 1 Hz',          type: 'blink',    periodMs: 1000, tol: 0.20, runMs: 2600 },
    'pushbutton':     { title: 'Button controls LED',           type: 'inputLed', inputRe: 'pushbutton', activeHigh: false },
    'pushbutton-6mm': { title: '6 mm button controls LED',      type: 'inputLed', inputRe: 'pushbutton', activeHigh: false },
    'slide-switch':   { title: 'Slide switch controls LED',     type: 'inputLed', inputRe: 'slide-switch', activeHigh: false },
    'tilt-switch':    { title: 'Tilt switch controls LED',      type: 'inputLed', inputRe: 'tilt', activeHigh: false },
    'pir-motion':     { title: 'PIR motion lights LED (3 s hold)', type: 'inputLed', inputRe: 'pir', activeHigh: true, releaseWaitMs: 3500 },
    '7segment':       { title: '7-segment counts 0–9',          type: 'sevenSeg' },
};

const ok = (message, details = {}) => ({ pass: true, message, details });
const no = (message, details = {}) => ({ pass: false, message, details });

// ── Intel HEX -> flash ──
function loadHex(hexText, target) {
    for (const line of hexText.split('\n')) {
        if (line[0] !== ':') continue;
        const len = parseInt(line.substr(1, 2), 16);
        const addr = parseInt(line.substr(3, 4), 16);
        const type = parseInt(line.substr(7, 2), 16);
        if (type === 0) for (let i = 0; i < len; i++) target[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
    }
}

// ── wiring helpers ──
function findPart(parts, re) { return parts.find(p => re.test(p.type)); }

function partEndpoints(conns, partId) {
    const set = new Set();
    for (const c of conns) for (const ep of [c.from, c.to]) if (ep.split(':')[0] === partId) set.add(ep);
    return [...set];
}

/** BFS over the wiring (incl. resistor internal links) to the first numeric/analog board pin. */
function traceBoardPin(diagram, startEndpoints) {
    const parts = diagram.parts || [], conns = diagram.connections || [];
    const board = parts.find(p => /arduino|uno|nano|mega/i.test(p.type));
    if (!board) return null;
    const adj = new Map();
    const link = (a, b) => (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    for (const c of conns) { link(c.from, c.to); link(c.to, c.from); }
    for (const p of parts) if (/resistor/i.test(p.type)) { link(`${p.id}:1`, `${p.id}:2`); link(`${p.id}:2`, `${p.id}:1`); }
    const seen = new Set(startEndpoints), q = [...startEndpoints];
    while (q.length) {
        const node = q.shift();
        const [id, pin] = node.split(':');
        if (id === board.id && /^(\d+|A\d+)$/.test(pin)) return pin;
        for (const nxt of adj.get(node) ?? []) if (!seen.has(nxt)) { seen.add(nxt); q.push(nxt); }
    }
    return null;
}

function pinToPortBit(pin) {
    if (/^\d+$/.test(pin)) { const n = +pin; if (n <= 7) return ['D', n]; if (n <= 13) return ['B', n - 8]; }
    const m = /^A(\d)$/.exec(pin); if (m) return ['C', +m[1]];
    return null;
}

// ── avr8js sim harness ──
function makeSim(hex) {
    const program = new Uint16Array(0x4000);
    loadHex(hex, new Uint8Array(program.buffer));
    const cpu = new CPU(program);
    new AVRTimer(cpu, timer0Config); new AVRTimer(cpu, timer1Config); new AVRTimer(cpu, timer2Config);
    const ports = { B: new AVRIOPort(cpu, portBConfig), C: new AVRIOPort(cpu, portCConfig), D: new AVRIOPort(cpu, portDConfig) };
    const usart = new AVRUSART(cpu, usart0Config, FREQ); // keep Serial.* from blocking on UDRE
    let serial = ''; usart.onByteTransmit = (b) => { serial += String.fromCharCode(b); };
    const adc = new AVRADC(cpu, adcConfig);              // so analogRead() works (else it hangs)
    const twi = new AVRTWI(cpu, twiConfig, FREQ);
    const i2cBus = new I2CBus(twi);                      // so Wire.* completes (else it hangs)
    return {
        cpu, ports, FREQ, i2cBus,
        ms: () => cpu.cycles / FREQ * 1000,
        runMs(ms) { const d = cpu.cycles + Math.floor(ms * FREQ / 1000); while (cpu.cycles <= d) { avrInstruction(cpu); cpu.tick(); } },
        high(pin) { const pb = pinToPortBit(pin); return pb ? ports[pb[0]].pinState(pb[1]) === 1 : false; },
        drive(pin, isHigh) { const pb = pinToPortBit(pin); if (pb) ports[pb[0]].setPin(pb[1], !!isHigh); },
        setAnalog(channel, frac) { adc.channelValues[channel] = Math.max(0, Math.min(1, frac)) * (adc.avcc || 5); },
        portBit(pin) { return pinToPortBit(pin); },
        serial: () => serial,
    };
}

// Content-addressed disk cache for compiled hex. The golden reference solution
// is compiled on EVERY grading call otherwise, even though its source never
// changes between submissions — a wasted ~3.5s remote compile every time.
// Keyed by sha256(sketch) so a code change always misses (never stale), and it
// persists across the separate Node subprocess spawned per grading request.
const CACHE_DIR = new URL('./.hex_cache/', import.meta.url);
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* best-effort */ }

async function compile(sketch) {
    const hash = createHash('sha256').update(sketch).digest('hex');
    const cachePath = new URL(`${hash}.json`, CACHE_DIR);
    if (existsSync(cachePath)) {
        try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* fall through and recompile */ }
    }
    const resp = await fetch(`${HEXI_URL}/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sketch, files: [], board: 'uno' }),
    });
    const result = await resp.json();
    if (result && result.hex) {
        try { writeFileSync(cachePath, JSON.stringify(result)); } catch { /* best-effort cache */ }
    }
    return result;
}

// ── checkers (one per spec.type) ──
function checkBlink(sim, diagram, spec) {
    const led = findPart(diagram.parts, /wokwi-led|(^|-)led$/i);
    if (!led) return no('Wiring: no LED found in the diagram.');
    const pin = traceBoardPin(diagram, partEndpoints(diagram.connections, led.id));
    if (!pin) return no('Wiring: the LED is not connected to any Arduino pin.');
    const pb = pinToPortBit(pin); const port = sim.ports[pb[0]];
    const edges = []; let last = port.pinState(pb[1]);
    port.addListener(() => { const s = port.pinState(pb[1]); if (s !== last) { edges.push(sim.ms()); last = s; } });
    sim.runMs(spec.runMs);
    if (edges.length < 3) return no(`Pin ${pin} did not blink (only ${edges.length} edges). Toggle the pin your LED is wired to.`, { wiredPin: pin, edges: edges.length });
    const halves = edges.slice(1).map((t, i) => t - edges[i]);
    const clean = (halves.length > 2 ? halves.slice(1) : halves).sort((a, b) => a - b);
    const period = clean[Math.floor(clean.length / 2)] * 2;
    const pass = Math.abs(period - spec.periodMs) <= spec.periodMs * spec.tol;
    const d = { wiredPin: pin, periodMs: Math.round(period) };
    return pass ? ok(`LED on pin ${pin} blinks at ${(1000 / period).toFixed(2)} Hz (period ${Math.round(period)}ms).`, d)
                : no(`Wrong blink rate on pin ${pin}: period ${Math.round(period)}ms (expected ~${spec.periodMs}ms).`, d);
}

// Generic "an input device drives an LED": pushbutton, slide/tilt switch, PIR…
// Drives the input pin inactive/active/inactive and checks the LED follows.
// spec.activeHigh: input HIGH activates (else LOW activates, e.g. INPUT_PULLUP).
function checkInputLed(sim, diagram, spec) {
    const inputPart = findPart(diagram.parts, new RegExp(spec.inputRe, 'i'));
    const led = findPart(diagram.parts, /wokwi-led|(^|-)led$/i);
    if (!inputPart || !led) return no('Wiring: need both the input device and an LED.');
    const inPin = traceBoardPin(diagram, partEndpoints(diagram.connections, inputPart.id));
    const ledPin = traceBoardPin(diagram, partEndpoints(diagram.connections, led.id));
    if (!inPin) return no('Wiring: the input device is not connected to an Arduino pin.');
    if (!ledPin) return no('Wiring: the LED is not connected to an Arduino pin.');

    const active = !!spec.activeHigh;
    const relWait = spec.releaseWaitMs || 150;
    const actWait = spec.pressWaitMs || 150;
    sim.runMs(60);                                                 // let setup() run
    sim.drive(inPin, !active); sim.runMs(relWait); const off1 = sim.high(ledPin); // inactive
    sim.drive(inPin, active);  sim.runMs(actWait); const on   = sim.high(ledPin); // active
    sim.drive(inPin, !active); sim.runMs(relWait); const off2 = sim.high(ledPin); // inactive again

    const pass = on && !off1 && !off2;
    const d = { inputPin: inPin, ledPin, ledWhenActive: on, ledWhenInactive: off1 };
    if (pass) return ok(`Input on pin ${inPin} drives LED on pin ${ledPin}: ON when active, OFF when inactive.`, d);
    if (on === off1) return no(`LED on pin ${ledPin} does not respond to the input on pin ${inPin}.`, d);
    return no(`LED logic inverted on pin ${ledPin} (expected ON while the input is active).`, d);
}

const SEG_DIGITS = { // standard common-cathode A..G bitmasks -> digit
    0b0111111: 0, 0b0000110: 1, 0b1011011: 2, 0b1001111: 3, 0b1100110: 4,
    0b1101101: 5, 0b1111101: 6, 0b0000111: 7, 0b1111111: 8, 0b1101111: 9,
};
function checkSevenSeg(sim, diagram, spec) {
    const seg = findPart(diagram.parts, /7segment|seven|7seg/i);
    if (!seg) return no('Wiring: no 7-segment display found.');
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const bits = [];
    for (const L of letters) {
        const pin = traceBoardPin(diagram, [`${seg.id}:${L}`]);
        if (!pin) return no(`Wiring: segment ${L} is not connected to an Arduino pin.`);
        bits.push(pinToPortBit(pin));
    }
    sim.runMs(60);
    const seen = new Set();
    for (let i = 0; i < 1320; i++) {                 // sample ~9.2 s (one full 0–9 cycle is ~8 s)
        sim.runMs(7);
        let pattern = 0;
        for (let b = 0; b < 7; b++) if (sim.ports[bits[b][0]].pinState(bits[b][1]) === 1) pattern |= (1 << b);
        if (pattern in SEG_DIGITS) seen.add(SEG_DIGITS[pattern]);
    }
    const missing = [];
    for (let dgt = 0; dgt <= 9; dgt++) if (!seen.has(dgt)) missing.push(dgt);
    const sawList = [...seen].sort((a, b) => a - b);
    const pass = missing.length === 0;
    const d = { digitsSeen: sawList };
    return pass ? ok(`7-segment cycled through all digits 0–9 (${sawList.join('')}).`, d)
                : no(`7-segment did not show all digits — missing ${missing.join(',')}. Saw: ${sawList.join('') || '(none)'}. Check segment wiring & patterns.`, d);
}

const CHECKERS = { blink: checkBlink, inputLed: checkInputLed, sevenSeg: checkSevenSeg };

/** Grade one submission against its challenge spec. */
export async function gradeArduino(sketch, diagram, challenge) {
    const spec = SPECS[challenge];
    if (!spec) return no(`No testbench defined for challenge "${challenge}" yet. Implemented: ${Object.keys(SPECS).join(', ')}.`);

    let built;
    try { built = await compile(sketch); } catch (e) { return no(`Compile request error: ${e.message}`); }
    if (!built || !built.hex) return no(`Compile failed:\n${(built?.stderr || 'unknown error').trim()}`);

    const sim = makeSim(built.hex);
    try {
        return CHECKERS[spec.type](sim, diagram, spec);
    } catch (e) {
        return no(`Grader runtime error: ${e.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════
// Differential grading (the smart, general way): compare the student's
// observable behaviour to a REFERENCE solution under the same stimulus.
// No per-challenge assertion code — authoring a challenge = "provide a
// working solution". LEDs are observed THROUGH the wiring, so any pin works.
// ════════════════════════════════════════════════════════════════════════
const ANALOG_IN_RE = /photoresistor|potentiometer|ldr|ntc|light|joystick|gas|flame|slide-potentiometer/i;
const DIGITAL_IN_RE = /button|switch|pir|tilt|keypad/i;
const DIFF_TOL = 0.15;   // duty tolerance (also fine for digital 0/1)

// ── WS2812 / NeoPixel one-wire decoder ──────────────────────────────────────
// Ported from the avr8js playground's src/shared/ws2812.ts (MIT, Uri Shaked).
// Decodes the bit-banged DIN signal into 24-bit pixel values.
const WS_ZERO_HIGH = 400, WS_ONE_HIGH = 800, WS_ZERO_LOW = 850, WS_ONE_LOW = 450;
const WS_MARGIN = 160, WS_RESET_TIME = 50000;
const PIN_HIGH = 1, PIN_LOW = 0, PIN_INPUT_PULLUP = 3;

class WS2812Controller {
    constructor(numPixels = 0) {
        this.numPixels = numPixels;
        this.pixels = new Uint32Array(numPixels);
        this.pixelIndex = 0; this.currentValue = 0; this.bitIndex = 0;
        this.lastState = 2 /* Input */; this.lastTimestamp = 0;
        this.detectZero = false; this.detectOne = false; this.overflow = false;
    }
    feedValue(pinState, cpuNanos) {
        if (pinState === this.lastState) return;
        const delta = cpuNanos - this.lastTimestamp;
        if (!this.overflow && (this.lastState === PIN_HIGH || this.lastState === PIN_INPUT_PULLUP)) {
            if (delta >= WS_ZERO_HIGH - WS_MARGIN && delta <= WS_ZERO_HIGH + WS_MARGIN) this.detectZero = true;
            if (delta >= WS_ONE_HIGH - WS_MARGIN && delta <= WS_ONE_HIGH + WS_MARGIN) this.detectOne = true;
            if (pinState === PIN_LOW && this.bitIndex === 23) {
                // last bit of a pixel may never see its LOW period — predict it
                this.pixels[this.pixelIndex] = this.currentValue | (this.detectOne ? 1 : 0);
            }
        }
        if (this.lastState === PIN_LOW) {
            if (this.detectZero && delta >= WS_ZERO_LOW - WS_MARGIN) this.feedBit(0);
            else if (this.detectOne && delta >= WS_ONE_LOW - WS_MARGIN) this.feedBit(1);
            if (delta >= WS_RESET_TIME) {
                this.detectZero = this.detectOne = this.overflow = false;
                this.bitIndex = 0; this.currentValue = 0; this.pixelIndex = 0;
            }
            this.detectZero = false; this.detectOne = false;
        }
        this.lastState = pinState; this.lastTimestamp = cpuNanos;
    }
    feedBit(value) {
        if (value) this.currentValue |= 1 << (23 - this.bitIndex);
        this.bitIndex++;
        if (this.bitIndex === 24) {
            this.pixels[this.pixelIndex++] = this.currentValue;
            this.bitIndex = 0; this.currentValue = 0;
        }
        if (this.pixelIndex >= this.numPixels) this.overflow = true;
    }
}

// Observable output components -> named signals (duty for LED/RGB/bar/7-seg, toggle
// frequency for buzzer, pixel signatures for NeoPixel strips/rings/matrices).
// Inputs (buttons/switches/sensors/pots) are driven.
function outputTargets(diagram) {
    const conns = diagram.connections || [];
    const trace = (ep) => traceBoardPin(diagram, Array.isArray(ep) ? ep : [ep]);
    const duty = [], freq = [], neo = [], i2c = [];
    for (const p of diagram.parts || []) {
        const t = p.type;
        if (/^wokwi-led$/i.test(t)) duty.push({ id: p.id, pin: trace(partEndpoints(conns, p.id)) });
        else if (/rgb-led/i.test(t)) for (const ch of ['R', 'G', 'B']) duty.push({ id: `${p.id}.${ch}`, pin: trace(`${p.id}:${ch}`) });
        else if (/led-bar-graph/i.test(t)) for (const ep of partEndpoints(conns, p.id)) { const m = /:A(\d+)$/.exec(ep); if (m) duty.push({ id: `${p.id}.A${m[1]}`, pin: trace(ep) }); }
        else if (/7segment|seven|7seg/i.test(t)) for (const L of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) duty.push({ id: `${p.id}.${L}`, pin: trace(`${p.id}:${L}`) });
        else if (/buzzer|speaker|piezo/i.test(t)) freq.push({ id: p.id, pin: trace(partEndpoints(conns, p.id)) });
        else if (/neopixel|led-ring/i.test(t)) {
            const a = p.attrs || {};
            const count = a.pixels ? +a.pixels : (a.rows && a.cols ? (+a.rows) * (+a.cols) : 1);
            neo.push({ id: p.id, pin: trace(`${p.id}:DIN`), count });
        }
        else if (/lcd1602|lcd2004/i.test(t)) {
            // I2C backpack: only usable when SDA -> A4 and SCL -> A5
            const wired = trace(`${p.id}:SDA`) === 'A4' && trace(`${p.id}:SCL`) === 'A5';
            i2c.push({ id: p.id, kind: /2004/.test(t) ? 'lcd2004' : 'lcd1602', wired });
        }
        else if (/ds1307|rtc/i.test(t)) {
            const wired = trace(`${p.id}:SDA`) === 'A4' && trace(`${p.id}:SCL`) === 'A5';
            i2c.push({ id: p.id, kind: 'ds1307', wired });
        }
    }
    return { duty: duty.filter(d => d.pin), freq: freq.filter(f => f.pin), neo: neo.filter(n => n.pin), i2c };
}

function inputTargets(diagram) {
    const conns = diagram.connections || [];
    const digitalIns = [], analogIns = [];
    for (const p of diagram.parts || []) {
        const pin = traceBoardPin(diagram, partEndpoints(conns, p.id));
        if (ANALOG_IN_RE.test(p.type)) { const m = /^A(\d)$/.exec(pin || ''); if (m) analogIns.push({ id: p.id, ch: +m[1] }); }
        else if (DIGITAL_IN_RE.test(p.type) && pin) digitalIns.push({ id: p.id, pin });
    }
    return { digitalIns, analogIns };
}

/** Run one design under an auto stimulus; record each output component's signal timeline. */
async function captureTrace(sketch, diagram, { durationMs, sampleMs }) {
    const built = await compile(sketch);
    if (!built || !built.hex) return { error: `Compile failed:\n${(built?.stderr || '').trim()}` };
    const sim = makeSim(built.hex);
    const { duty, freq, neo, i2c } = outputTargets(diagram);
    const { digitalIns, analogIns } = inputTargets(diagram);

    // I2C devices: LCDs are observed (text signature); the RTC just answers reads.
    // Unwired parts are NOT attached to the bus, so the display stays blank / the
    // clock never answers — exactly like a miswired board.
    const lcdT = [];
    for (const dev of i2c) {
        if (dev.kind === 'ds1307') {
            if (dev.wired) sim.i2cBus.registerDevice(DS1307_ADDR, new DS1307Controller(sim.ms));
        } else {
            const ctrl = new LCDController(dev.kind === 'lcd2004' ? 4 : 2, dev.kind === 'lcd2004' ? 20 : 16);
            if (dev.wired) sim.i2cBus.registerDevice(LCD_I2C_ADDR, ctrl);
            lcdT.push({ id: dev.id, ctrl, values: [] });  // observed even when unwired (stays blank)
        }
    }

    const dutyT = duty.map(d => { const pb = pinToPortBit(d.pin); return { id: d.id, port: sim.ports[pb[0]], bit: pb[1], values: [] }; });
    const freqT = freq.map(f => {
        const pb = pinToPortBit(f.pin);
        const o = { id: f.id, port: sim.ports[pb[0]], bit: pb[1], edges: 0, prev: 0, values: [] };
        o.last = o.port.pinState(o.bit);
        o.port.addListener(() => { const s = o.port.pinState(o.bit); if (s !== o.last) { o.edges++; o.last = s; } });
        return o;
    });
    const NANOS_PER_CYCLE = 1e9 / FREQ;
    const neoT = neo.map(n => {
        const pb = pinToPortBit(n.pin);
        const o = { id: n.id, port: sim.ports[pb[0]], bit: pb[1], ctrl: new WS2812Controller(n.count), values: [] };
        o.port.addListener(() => o.ctrl.feedValue(o.port.pinState(o.bit), sim.cpu.cycles * NANOS_PER_CYCLE));
        return o;
    });
    // coarse per-sample signature of the whole pixel array (3 bits/channel)
    const neoSignature = (px) => {
        let s = '';
        for (let i = 0; i < px.length; i++) {
            const v = px[i];
            s += (((v >> 21) & 7) << 6 | ((v >> 13) & 7) << 3 | ((v >> 5) & 7)).toString(36).padStart(2, '0');
        }
        return s;
    };

    sim.runMs(60);
    const steps = Math.floor(durationMs / sampleMs);
    const subStep = 0.5, subCount = Math.max(1, Math.round(sampleMs / subStep)), winSec = sampleMs / 1000;
    for (let s = 0; s < steps; s++) {
        const tMs = s * sampleMs;
        digitalIns.forEach((inp, idx) => sim.drive(inp.pin, (Math.floor((tMs + idx * 250) / 450) % 2) === 0));
        analogIns.forEach((ai, idx) => sim.setAnalog(ai.ch, ((tMs + idx * 700) % 3000) / 3000)); // slow ramp
        const high = dutyT.map(() => 0);
        for (let k = 0; k < subCount; k++) {
            sim.runMs(subStep);
            dutyT.forEach((t, i) => { if (t.port.pinState(t.bit) === 1) high[i]++; });
        }
        dutyT.forEach((t, i) => t.values.push(high[i] / subCount));
        freqT.forEach(t => { const d = t.edges - t.prev; t.prev = t.edges; t.values.push(Math.min(1, ((d / 2) / winSec) / 1000)); }); // Hz/1000
        neoT.forEach(t => t.values.push(neoSignature(t.ctrl.pixels)));
        lcdT.forEach(t => t.values.push(t.ctrl.text()));
    }
    const signals = [...dutyT, ...freqT, ...neoT, ...lcdT].map(t => ({ id: t.id, values: t.values }));
    return { signals, serial: sim.serial() };
}

/** Count "hard" mismatches between two timelines.
 *  Numbers (duty/frequency): ±DIFF_TOL with transition forgiveness.
 *  Strings (pixel signatures): equal to the reference within a ±1-sample phase
 *  shift (transition forgiveness would forgive everything on fast animations). */
function timelineDiff(a, b) {
    if (typeof a[0] === 'string' || typeof b[0] === 'string') {
        let hard = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] === b[i]) continue;
            if (i > 0 && a[i] === b[i - 1]) continue;
            if (i < b.length - 1 && a[i] === b[i + 1]) continue;
            hard++;
        }
        return hard;
    }
    const differs = (x, y) => Math.abs(x - y) > DIFF_TOL;
    let hard = 0;
    for (let i = 0; i < a.length; i++) {
        if (!differs(a[i], b[i])) continue;
        const nearA = (i > 0 && differs(a[i - 1], a[i])) || (i < a.length - 1 && differs(a[i + 1], a[i]));
        const nearB = (i > 0 && differs(b[i - 1], b[i])) || (i < b.length - 1 && differs(b[i + 1], b[i]));
        if (!(nearA || nearB)) hard++;
    }
    return hard;
}

/** Distinct, trimmed, non-empty serial lines. */
function serialLines(s) {
    return new Set((s || '').split('\n').map(x => x.replace(/\r/g, '').trim()).filter(Boolean));
}

/** Grade by behavioural equivalence to a reference (no per-challenge spec needed). */
export async function gradeDifferential(student, reference, opts = {}) {
    const durationMs = opts.durationMs || 3000, sampleMs = opts.sampleMs || 20;
    // Reference and student are fully independent — compile + simulate concurrently
    // instead of back-to-back (roughly halves latency on a cache miss).
    const [refT, stuT] = await Promise.all([
        captureTrace(reference.sketch, reference.diagram, { durationMs, sampleMs }),
        captureTrace(student.sketch, student.diagram, { durationMs, sampleMs }),
    ]);
    if (refT.error) return no(`Reference solution failed: ${refT.error}`);
    if (stuT.error) return no(`Your code failed to compile:\n${stuT.error}`);

    // Prefer observing hardware output components (LED / RGB / bar-graph / 7-seg /
    // buzzer). Components not on an MCU pin (e.g. relay-switched LED) yield no signal
    // and fall through to serial.
    if (refT.signals.length > 0) {
        let totalHard = 0, totalSamples = 0; const per = {};
        for (const rs of refT.signals) {
            const ss = stuT.signals.find(s => s.id === rs.id);
            if (!ss) return no(`Your circuit is missing / not wiring the "${rs.id.split('.')[0]}" output.`);
            const hard = timelineDiff(rs.values, ss.values);
            per[rs.id] = hard; totalHard += hard; totalSamples += rs.values.length;
        }
        const ratio = totalHard / (totalSamples || 1);
        return ratio <= 0.05
            ? ok('Matches the reference behaviour (component outputs agree under the test stimulus).', { signals: refT.signals.length })
            : no(`Behaviour differs from the reference — ${(ratio * 100).toFixed(0)}% of samples mismatch.`, { per });
    }

    // Fall back to Serial output — covers most sensor/serial examples. (Weaker than
    // LED observation: it grades what is printed, not the physical device.)
    const refLines = serialLines(refT.serial);
    if (refLines.size === 0) {
        return no('This challenge has no LED or Serial output to observe — it needs a device-specific grader (display/motor/bus).');
    }
    const stuLines = serialLines(stuT.serial);
    let hit = 0; for (const l of refLines) if (stuLines.has(l)) hit++;
    const ratio = hit / refLines.size;
    return ratio >= 0.7
        ? ok(`Serial output matches the reference (${hit}/${refLines.size} expected lines).`, { serial: `${hit}/${refLines.size}` })
        : no(`Serial output differs from the reference (${hit}/${refLines.size} expected lines matched).`, { serial: `${hit}/${refLines.size}` });
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    if (process.argv[2] === '--diff') {
        const [, , , si, sd, ri, rd] = process.argv;
        const student = { sketch: readFileSync(si, 'utf8'), diagram: JSON.parse(readFileSync(sd, 'utf8')) };
        const reference = { sketch: readFileSync(ri, 'utf8'), diagram: JSON.parse(readFileSync(rd, 'utf8')) };
        const r = await gradeDifferential(student, reference);
        console.log(JSON.stringify(r));
        process.exit(r.pass ? 0 : 1);
    }
    const [, , inoPath, diagramPath, challenge] = process.argv;
    const sketch = readFileSync(inoPath, 'utf8');
    const diagram = JSON.parse(readFileSync(diagramPath, 'utf8'));
    const r = await gradeArduino(sketch, diagram, challenge);
    console.log(JSON.stringify(r));
    process.exit(r.pass ? 0 : 1);
}

// debug-only export
export { captureTrace as _captureForDebug };
