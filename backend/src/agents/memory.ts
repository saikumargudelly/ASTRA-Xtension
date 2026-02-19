import type { AgentStep, StepResult, MemoryEntry } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { addToChroma, queryChroma } from '../db/chroma.js';

// ─── Memory Agent ───

export async function executeMemoryStep(step: AgentStep): Promise<StepResult> {
    const start = Date.now();

    try {
        switch (step.action) {
            case 'store':
                return await storeMemory(step, start);
            case 'retrieve':
                return await retrieveMemory(step, start);
            default:
                throw new Error(`Unknown memory action: ${step.action}`);
        }
    } catch (err) {
        return {
            stepId: step.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
        };
    }
}

async function storeMemory(step: AgentStep, start: number): Promise<StepResult> {
    const text = String(step.params.text ?? '');
    const metadata = (step.params.metadata as Record<string, string>) ?? {};

    if (!text) {
        throw new Error('store requires text content');
    }

    const db = getDb();
    const id = crypto.randomUUID();

    // Store in SQLite
    db.prepare(
        'INSERT INTO memories (id, text, metadata_json) VALUES (?, ?, ?)',
    ).run(id, text, JSON.stringify(metadata));

    // Store in ChromaDB for semantic search (optional — silently falls back to SQLite)
    try {
        await addToChroma(id, text, metadata);
    } catch { /* ChromaDB not available — SQLite is sufficient */ }

    return {
        stepId: step.id,
        success: true,
        data: { id, stored: true, message: 'Memory stored successfully' },
        durationMs: Date.now() - start,
    };
}

async function retrieveMemory(step: AgentStep, start: number): Promise<StepResult> {
    const query = String(step.params.query ?? '');
    const topK = Number(step.params.topK ?? 5);

    if (!query) {
        throw new Error('retrieve requires a query');
    }

    let results: MemoryEntry[] = [];

    // Try ChromaDB for semantic search
    try {
        const chromaResults = await queryChroma(query, topK);
        results = chromaResults.map((r) => ({
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            score: r.score,
            createdAt: '',
        }));
    } catch {
        // ChromaDB unavailable — fallback to SQLite text search

        // Fallback: SQLite text search
        const db = getDb();
        const rows = db.prepare(
            `SELECT id, text, metadata_json, created_at
       FROM memories
       WHERE text LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
        ).all(`%${query}%`, topK) as Array<{
            id: string;
            text: string;
            metadata_json: string;
            created_at: string;
        }>;

        results = rows.map((row) => ({
            id: row.id,
            text: row.text,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
            createdAt: row.created_at,
        }));
    }

    return {
        stepId: step.id,
        success: true,
        data: { results, count: results.length },
        durationMs: Date.now() - start,
    };
}

// ─── Direct API functions ───
export async function storeMemoryDirect(
    text: string,
    metadata?: Record<string, string>,
): Promise<{ id: string }> {
    const db = getDb();
    const id = crypto.randomUUID();

    db.prepare(
        'INSERT INTO memories (id, text, metadata_json) VALUES (?, ?, ?)',
    ).run(id, text, JSON.stringify(metadata ?? {}));

    try {
        await addToChroma(id, text, metadata);
    } catch { /* ChromaDB optional */ }

    return { id };
}

export async function queryMemoryDirect(
    query: string,
    topK = 5,
): Promise<MemoryEntry[]> {
    try {
        const chromaResults = await queryChroma(query, topK);
        return chromaResults.map((r) => ({
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            score: r.score,
            createdAt: '',
        }));
    } catch {
        const db = getDb();
        const rows = db.prepare(
            `SELECT id, text, metadata_json, created_at
       FROM memories WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`,
        ).all(`%${query}%`, topK) as Array<{
            id: string;
            text: string;
            metadata_json: string;
            created_at: string;
        }>;

        return rows.map((row) => ({
            id: row.id,
            text: row.text,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
            createdAt: row.created_at,
        }));
    }
}
