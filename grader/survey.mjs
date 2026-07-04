/** Coverage survey: grade every example's own solution and categorise the result. */
import { readFileSync } from 'node:fs';
import { gradeArduino, gradeDifferential, SPECS } from './grade.mjs';

const EX = new URL('../examples/', import.meta.url);
const slugs = JSON.parse(readFileSync(new URL('manifest.json', EX), 'utf8'));

function files(slug) {
    return {
        sketch: readFileSync(new URL(`${slug}/${slug}.ino`, EX), 'utf8'),
        diagram: JSON.parse(readFileSync(new URL(`${slug}/diagram.json`, EX), 'utf8')),
    };
}

async function grade(slug) {
    const ref = files(slug);
    let r = await gradeDifferential(ref, ref);       // self-grade (student == reference)
    if (!r.pass && /no LED or Serial/i.test(r.message) && SPECS[slug]) r = await gradeArduino(ref.sketch, ref.diagram, slug);
    return r;
}

function bucket(r) {
    if (r.pass && /LED outputs/.test(r.message)) return 'OK (LED)';
    if (r.pass && /Serial output/.test(r.message)) return 'OK (serial)';
    if (r.pass) return 'OK';
    if (/Compile failed|Reference solution failed/i.test(r.message)) return 'BLOCKED: won\'t compile (library)';
    if (/no LED or Serial|device-specific/i.test(r.message)) return 'BLOCKED: needs device model';
    return 'FAIL: ' + r.message.split('\n')[0].slice(0, 50);
}

const tally = {};
for (const slug of slugs) {
    const r = await grade(slug);
    const b = bucket(r);
    tally[b] = (tally[b] || 0) + 1;
    console.log(`${slug.padEnd(20)} ${b}`);
}
console.log('\n=== SUMMARY ===');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)}  ${k}`);
