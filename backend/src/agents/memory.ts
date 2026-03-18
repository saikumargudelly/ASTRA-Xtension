// ─── NEXUS Memory System ─────────────────────────────────────────────────────
// Simplified: removed dead tier functions (workingSet/Get, recall, consolidate,
// semanticStore, semanticQuery, executeMemoryStep) — none are called in the live
// request path. The semantic tier requires an embeddings pipeline that does not
// exist yet. Keeping episodic store/query (SQLite + ChromaDB) and the public API.
//
// Live request path: /plan-actions → nothing (memory not yet wired to live loop)
// Called externally: storeMemoryDirect / queryMemoryDirect via route handlers if needed.

import type { MemoryEntry } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { addToChroma, queryChroma } from '../db/chroma.js';

// ─── Episodic Memory (SQLite primary, ChromaDB semantic layer) ─────────────
export async function episodicStore(
    id: string,
    text: string,
    metadata?: Record<string, string>,
): Promise<void> {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO memories (id, text, metadata_json) VALUES (?, ?, ?)')
        .run(id, text, JSON.stringify(metadata ?? {}));
    try {
        await addToChroma(id, text, metadata);
    } catch {
        // ChromaDB optional — SQLite is sufficient
    }
}

export async function episodicQuery(
    query: string,
    topK = 5,
): Promise<MemoryEntry[]> {
    try {
        const results = await queryChroma(query, topK);
        return results.map((r) => ({
            id: r.id, text: r.text, metadata: r.metadata, score: r.score, createdAt: '',
        }));
    } catch {
        // Fallback: SQLite substring search
        const db = getDb();
        const rows = db.prepare(
            `SELECT id, text, metadata_json, created_at FROM memories
             WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`,
        ).all(`%${query}%`, topK) as Array<{
            id: string; text: string; metadata_json: string; created_at: string;
        }>;
        return rows.map((row) => ({
            id: row.id,
            text: row.text,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
            createdAt: row.created_at,
        }));
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function storeMemoryDirect(
    text: string,
    metadata?: Record<string, string>,
): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await episodicStore(id, text, metadata);
    return { id };
}

export async function queryMemoryDirect(
    query: string,
    topK = 5,
): Promise<MemoryEntry[]> {
    return episodicQuery(query, topK);
}
