/**
 * Backend client for the challenge bank.
 *
 * The renderer's project sidebar and loader talk to the MakerCode backend
 * (FastAPI) through this shim: the challenge LIST and each challenge's starter
 * TEMPLATE (code + wiring) come from the backend, and the Grade button submits
 * back to it. Point it at your backend with `window.API_BASE_URL`.
 */
const API_BASE = (globalThis as { API_BASE_URL?: string }).API_BASE_URL || 'http://localhost:8000';

async function getJSON(url: string): Promise<any> {
    try {
        const r = await fetch(url);
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

async function discover() {
    const list = (await getJSON(`${API_BASE}/api/arduino_questions`)) as
        Array<{ id: string; title: string; difficulty: string }> | null;
    if (!list) return { success: true, ok: true, projects: [], stats: {} };
    const projects = list.map((c) => ({
        name: `${c.id} — ${c.title}`,
        slug: c.id,
        category: c.difficulty || 'Challenges',
        board: 'uno',
        description: c.difficulty || '',
        dirPath: c.id,            // the challenge id, used by load() + grading
        tags: [] as string[],
    }));
    return { success: true, ok: true, projects, stats: {} };
}

// `load()` is used for BOTH speculative preloading (preloadProject, fired on
// startup for the last-opened project) and actually opening a challenge to
// view/grade. Both share this one function, so a slow background preload of a
// stale challenge could resolve after the user has already switched to a
// different one and clobber __challengeId with the wrong id. Guard with a
// monotonic sequence: only the most recently ISSUED call (not the one that
// happens to resolve first) is allowed to set the "current" challenge id.
let loadSeq = 0;

async function load(payload: any) {
    const id: string = (payload?.dirPath ?? payload?.slug ?? '').split('/').pop() ?? '';
    const seq = ++loadSeq;
    const q = (await getJSON(`${API_BASE}/api/arduino_question/${id}`)) ?? {};
    if (seq === loadSeq) {
        (globalThis as any).__challengeId = id;   // so the Grade button knows which challenge to submit
        (globalThis as any).__challengeQuestion = q.question ?? ''; // stash for any UI that wants to show it
    }
    const files = [
        { name: 'question.md', content: q.question ?? '', language: 'markdown' },
        { name: 'sketch.ino', content: q.template_code ?? '', language: 'cpp' },
        { name: 'diagram.json', content: q.template_diagram ?? '', language: 'json' },
    ];
    return {
        success: true,
        ok: true,
        loaded: { name: q.title ?? id, board: 'uno', files, hex: null as string | null },
    };
}

export const browserIpcRenderer: any = {
    async invoke(channel: string, payload: any) {
        if (channel === 'project:discover') return discover();
        if (channel === 'project:load') return load(payload);
        return {};
    },
    on() {},
    off() {},
    send() {},
    removeListener() {},
    removeAllListeners() {},
};
