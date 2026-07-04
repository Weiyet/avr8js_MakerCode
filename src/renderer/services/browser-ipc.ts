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

async function load(payload: any) {
    const id: string = (payload?.dirPath ?? payload?.slug ?? '').split('/').pop() ?? '';
    (globalThis as any).__challengeId = id;   // so the Grade button knows which challenge to submit
    const q = (await getJSON(`${API_BASE}/api/arduino_question/${id}`)) ?? {};
    const files = [
        { name: 'question.md', content: q.question ?? '', language: 'markdown' },
        { name: 'sketch.ino', content: q.template_code ?? '', language: 'cpp' },
        { name: 'diagram.json', content: q.template_diagram ?? '', language: 'json' },
    ];
    // stash the question markdown for any UI that wants to show it
    (globalThis as any).__challengeQuestion = q.question ?? '';
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
