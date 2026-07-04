/**
 * Local grader server for the playground prototype.
 *
 * The "Grade" button in the app POSTs { sketch, diagram, challenge } here, where
 * `challenge` is the loaded example's slug. We grade the submission against the
 * PRISTINE example of the same slug (golden differential — the reference is the
 * unedited example), falling back to that example's spec when there's no LED to
 * observe.
 *
 * Run alongside the app:  node grader/server.mjs   (listens on :4180)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gradeArduino, gradeDifferential, SPECS } from './grade.mjs';

const PORT = 4180;
const EX = new URL('../examples/', import.meta.url);

const cors = { 'Access-Control-Allow-Origin': '*' };

async function grade(slug, sketch, diagram) {
    if (!slug) return { pass: false, message: 'No challenge selected (open an example first).' };
    let ref;
    try {
        ref = {
            sketch: readFileSync(new URL(`${slug}/${slug}.ino`, EX), 'utf8'),
            diagram: JSON.parse(readFileSync(new URL(`${slug}/diagram.json`, EX), 'utf8')),
        };
    } catch {
        return { pass: false, message: `No reference solution found for "${slug}".` };
    }
    let result = await gradeDifferential({ sketch, diagram }, ref);
    if (!result.pass && /no LED to observe/i.test(result.message) && SPECS[slug]) {
        result = await gradeArduino(sketch, diagram, slug);
    }
    return result;
}

createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }
    if (req.method === 'POST' && req.url === '/grade') {
        try {
            let body = '';
            for await (const c of req) body += c;
            const { sketch, diagram, challenge } = JSON.parse(body);
            const diagramObj = typeof diagram === 'string' ? JSON.parse(diagram) : diagram;
            const result = await grade(challenge, sketch, diagramObj);
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ pass: false, message: `Grader error: ${e.message}` }));
        }
    }
    res.writeHead(404, cors); res.end('not found');
}).listen(PORT, () => console.log(`Playground grader -> http://localhost:${PORT}  (POST /grade)`));
