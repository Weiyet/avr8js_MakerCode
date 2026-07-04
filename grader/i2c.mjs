/**
 * I2C bus + device models for the headless grader.
 * Ported from the avr8js playground's src/shared/{i2c-bus,lcd1602,lcd2004,ds1307}.ts
 * (MIT, Uri Shaked / Anderson Costa), with grading-specific changes:
 *  - DS1307 returns a FIXED epoch advanced by CPU-millis (deterministic runs).
 *  - LCD render returns the visible text (string) for signature comparison.
 */

// ── I2C bus: routes avr8js TWI events to registered devices by address ──────
export class I2CBus {
    constructor(twi) {
        this.twi = twi;
        this.devices = {};
        this.activeDevice = null;
        this.writeMode = false;
        twi.eventHandler = this;
    }
    registerDevice(addr, device) { this.devices[addr] = device; }
    start() { this.twi.completeStart(); }
    stop() {
        if (this.activeDevice) { this.activeDevice.i2cDisconnect(); this.activeDevice = null; }
        this.twi.completeStop();
    }
    connectToSlave(addr, write) {
        let result = false;
        const device = this.devices[addr];
        if (device) {
            result = device.i2cConnect(addr, write);
            if (result) { this.activeDevice = device; this.writeMode = write; }
        }
        this.twi.completeConnect(result);
    }
    writeByte(value) {
        if (this.activeDevice && this.writeMode) this.twi.completeWrite(this.activeDevice.i2cWriteByte(value));
        else this.twi.completeWrite(false);
    }
    readByte(ack) {
        if (this.activeDevice && !this.writeMode) this.twi.completeRead(this.activeDevice.i2cReadByte(ack));
        else this.twi.completeRead(0xff);
    }
}

// ── HD44780 LCD behind a PCF8574 I2C backpack (16x2 or 20x4) ────────────────
export const LCD_I2C_ADDR = 0x27;

export class LCDController {
    constructor(rows = 2, cols = 16) {
        this.rows = rows; this.cols = cols;
        this.cgram = new Uint8Array(64);
        this.ddram = new Uint8Array(128).fill(32);
        this.addr = 0; this.shift = 0; this.data = 0;
        this.displayOn = false; this.backlight = false;
        this.firstByte = true; this.cgramMode = false;
        this.incrementMode = true; this.shiftMode = false; this.is8bit = true;
    }
    i2cConnect() { return true; }
    i2cDisconnect() { }
    i2cReadByte() { return 0xff; }
    i2cWriteByte(value) {
        const data = value & 0xF0;
        const rs = !!(value & 0x01);
        this.backlight = !!(value & 0x08);
        if ((value & 0x04) && !(value & 0x02)) this.writeData(data, rs);  // EN strobe
        return true;
    }
    writeData(value, rs) {
        if (!this.is8bit) {
            if (this.firstByte) { this.firstByte = false; this.data = value; return; }
            value = this.data | (value >> 4);
            this.firstByte = true;
        }
        if (rs) this.processData(value); else this.processCommand(value);
    }
    processCommand(value) {
        if (value & 0x20) { this.is8bit = !!(value & 0x10); }
        else if (value & 0x80) { this.cgramMode = false; this.addr = value & 0x7F; }
        else if (value & 0x40) { this.cgramMode = true; this.addr = value & 0x3F; }
        else if (value & 0x10) {
            const shiftDisplay = !!(value & 0x08);
            const dir = (value & 0x04) ? 1 : -1;
            this.cgramMode = false;
            this.addr = (this.addr + dir) % 128;
            if (shiftDisplay) this.shift = (this.shift + dir) % 40;
        }
        else if (value & 0x08) { this.displayOn = !!(value & 0x04); }
        else if (value & 0x04) { this.cgramMode = false; this.incrementMode = !!(value & 0x02); this.shiftMode = !!(value & 0x01); }
        else if (value & 0x02) { this.cgramMode = false; this.addr = 0; this.shift = 0; }
        else if (value & 0x01) {
            this.cgramMode = false; this.incrementMode = true;
            this.addr = 0; this.shift = 0; this.ddram.fill(32);
        }
    }
    processData(value) {
        if (this.cgramMode) {
            this.cgram[this.addr] = value;
            this.addr = (this.addr + 1) % 64;
        } else {
            this.ddram[this.addr] = value;
            this.addr = (this.addr + (this.incrementMode ? 1 : -1)) % 128;
            if (this.shiftMode) this.shift = (this.shift + (this.incrementMode ? 1 : -1)) % 40;
        }
    }
    /** Visible text as one string (rows joined by '\n'). Blank if display off. */
    text() {
        const s = ((this.shift % 40) + 40) % 40;
        const line = (bank, offset) => {
            let out = '';
            for (let i = 0; i < this.cols; i++) out += String.fromCharCode(this.ddram[bank + (offset + s + i) % 40]);
            return out;
        };
        if (!this.displayOn) return ' '.repeat(this.cols * this.rows);
        if (this.rows <= 2) {
            return [line(0, 0), line(64, 0)].slice(0, this.rows).join('\n');
        }
        return [line(0, 0), line(64, 0), line(0, 20), line(64, 20)].join('\n');
    }
}

// ── DS1307 RTC (deterministic: fixed epoch + CPU millis) ────────────────────
export const DS1307_ADDR = 0x68;
const FIXED_EPOCH = Date.UTC(2026, 0, 1, 10, 20, 30); // 2026-01-01 10:20:30 UTC

const toBCD = (v) => ((Math.floor(v / 10) << 4) | (v % 10));

export class DS1307Controller {
    constructor(cpuMillis) {
        this.cpuMillis = cpuMillis || (() => 0);
        this.registerPointer = 0;
        this.ram = new Uint8Array(56);
        this.control = 0;
        this.pendingAddress = true;
    }
    now() { return new Date(FIXED_EPOCH + Math.floor(this.cpuMillis())); }
    i2cConnect() { this.pendingAddress = true; return true; }
    i2cDisconnect() { }
    i2cWriteByte(value) {
        if (this.pendingAddress) { this.registerPointer = value & 0x3F; this.pendingAddress = false; return true; }
        this.writeRegister(this.registerPointer, value);
        this.registerPointer = (this.registerPointer + 1) & 0x3F;
        return true;
    }
    i2cReadByte() {
        const value = this.readRegister(this.registerPointer);
        this.registerPointer = (this.registerPointer + 1) & 0x3F;
        return value;
    }
    readRegister(reg) {
        const now = this.now();
        switch (reg) {
            case 0x00: return toBCD(now.getUTCSeconds());
            case 0x01: return toBCD(now.getUTCMinutes());
            case 0x02: return toBCD(now.getUTCHours());
            case 0x03: return toBCD(now.getUTCDay() + 1);
            case 0x04: return toBCD(now.getUTCDate());
            case 0x05: return toBCD(now.getUTCMonth() + 1);
            case 0x06: return toBCD(now.getUTCFullYear() % 100);
            case 0x07: return this.control;
            default: return (reg >= 0x08 && reg <= 0x3F) ? this.ram[reg - 0x08] : 0xFF;
        }
    }
    writeRegister(reg, value) {
        if (reg === 0x07) this.control = value;
        else if (reg >= 0x08 && reg <= 0x3F) this.ram[reg - 0x08] = value;
        // writes to time registers ignored — deterministic clock
    }
}
