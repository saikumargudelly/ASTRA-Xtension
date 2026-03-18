// ─── NEXUS 3-Tier Memory System ───────────────────────────────────────────────
//
// Tier 1 — Working Memory  → Redis (TTL 1h, session-scoped, <1ms)
// Tier 2 — Episodic Memory → ChromaDB (semantic vector search, 90-day TTL)
// Tier 3 — Semantic Memory → PostgreSQL + pgvector (permanent facts/prefs)
//
// All tiers degrade gracefully when the backing store is unavailable.

import type { AgentStep, StepResult, MemoryEntry } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { addToChroma, queryChroma } from '../db/chroma.js';
import { redisGet, redisSet, redisDel, redisScan } from '../db/redis.js';
import { pgQuery, pgQueryOne, isPostgresAvailable } from '../db/postgres.js';

// ─── Working Memory (Tier 1 — Redis) ──────────────────────────────────────────
const WORKING_TTL = 3600; // 1 hour

export interface WorkingMemoryEntry {
    key: string;
    value: unknown;
    sessionId?: string;
    createdAt: number;
}

export async function workingSet(
    key: string,
    value: unknown,
    sessionId?: string,
    ttl = WORKING_TTL,
): Promise<void> {
    const entry: WorkingMemoryEntry = { key, value, sessionId, createdAt: Date.now() };
    await redisSet(sessionId ? `${sessionId}:${key}` : key, JSON.stringify(entry), ttl);
}

export async function workingGet<T = unknown>(
    key: string,
    sessionId?: string,
): Promise<T | null> {
    const raw = await redisGet(sessionId ? `${sessionId}:${key}` : key);
    if (!raw) return null;
    try {
        const entry = JSON.parse(raw) as WorkingMemoryEntry;
        return entry.value as T;
    } catch {
        return null;
    }
}

export async function workingDelete(key: string, sessionId?: string): Promise<void> {
    await redisDel(sessionId ? `${sessionId}:${key}` : key);
}

// ─── Episodic Memory (Tier 2 — ChromaDB) ──────────────────────────────────────
export async function episodicStore(
    id: string,
    text: string,
    metadata?: Record<string, string>,
): Promise<void> {
    // SQLite as primary, ChromaDB as semantic layer
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
        const chromaResults = await queryChroma(query, topK);
        return chromaResults.map((r) => ({
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            score: r.score,
            createdAt: '',
        }));
    } catch {
        // Fallback to SQLite text search
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

// ─── Semantic Memory (Tier 3 — PostgreSQL + pgvector) ─────────────────────────
export interface SemanticEntry {
    id: string;
    text: string;
    type: 'fact' | 'preference' | 'entity' | 'knowledge';
    source?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
}

export async function semanticStore(
    text: string,
    type: SemanticEntry['type'] = 'fact',
    source?: string,
    metadata?: Record<string, unknown>,
): Promise<string | null> {
    if (!isPostgresAvailable()) return null;

    const rows = await pgQuery<{ id: string }>(
        `INSERT INTO semantic_memory (text, type, source, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
        [text, type, source ?? null, JSON.stringify(metadata ?? {})],
    );
    return rows[0]?.id ?? null;
}

export async function semanticQuery(
    query: string,
    topK = 5,
    type?: SemanticEntry['type'],
): Promise<SemanticEntry[]> {
    if (!isPostgresAvailable()) return [];

    // Text-based fallback (embedding search requires embeddings pipeline)
    const typeFilter = type ? `AND type = $2` : '';
    const params: unknown[] = [`%${query}%`];
    if (type) params.push(type);

    return pgQuery<SemanticEntry>(
        `SELECT id, text, type, source, metadata, created_at as "createdAt"
     FROM semantic_memory
     WHERE text ILIKE $1 ${typeFilter}
     ORDER BY created_at DESC
     LIMIT ${topK}`,
        params,
    );
}

// ─── Unified Recall (all 3 tiers) ─────────────────────────────────────────────
export async function recall(
    query: string,
    topK = 10,
    sessionId?: string,
): Promise<{
    working: WorkingMemoryEntry[];
    episodic: MemoryEntry[];
    semantic: SemanticEntry[];
}> {
    const [episodic, semantic] = await Promise.all([
        episodicQuery(query, Math.ceil(topK / 2)),
        semanticQuery(query, Math.floor(topK / 2)),
    ]);

    // For working memory, scan all session keys (best-effort)
    const working: WorkingMemoryEntry[] = [];
    if (sessionId) {
        const keys = await redisScan(`${sessionId}:*`);
        for (const key of keys.slice(0, 5)) {
            const value = await workingGet(key.replace(`${sessionId}:`, ''), sessionId);
            if (value) working.push({ key, value, sessionId, createdAt: Date.now() });
        }
    }

    return { working, episodic, semantic };
}

// ─── Memory Consolidation ──────────────────────────────────────────────────────
export async function consolidateSession(sessionId: string): Promise<void> {
    // Move important working memory facts to episodic
    const keys = await redisScan(`${sessionId}:*`);
    for (const key of keys) {
        const entry = await workingGet<WorkingMemoryEntry>(key.replace(`${sessionId}:`, ''), sessionId);
        if (entry) {
            const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
            await episodicStore(
                `${sessionId}-${key}`,
                `[Session ${sessionId}] ${text}`,
                { sessionId, key },
            );
        }
    }
}

// ─── Agent Step Interface (backward-compatible) ────────────────────────────────
export async function executeMemoryStep(step: AgentStep): Promise<StepResult> {
    const start = Date.now();
    try {
        switch (step.action) {
            case 'store': {
                const text = String(step.params.text ?? '');
                const metadata = (step.params.metadata as Record<string, string>) ?? {};
                if (!text) throw new Error('store requires text content');

                const id = crypto.randomUUID();
                await episodicStore(id, text, metadata);

                // Also attempt semantic tier for preference-type memories
                if (metadata.type === 'preference') {
                    await semanticStore(text, 'preference', 'user', metadata);
                }

                return { stepId: step.id, success: true, data: { id, stored: true }, durationMs: Date.now() - start };
            }

            case 'retrieve': {
                const query = String(step.params.query ?? '');
                const topK = Number(step.params.topK ?? 5);
                if (!query) throw new Error('retrieve requires a query');

                const results = await episodicQuery(query, topK);
                return { stepId: step.id, success: true, data: { results, count: results.length }, durationMs: Date.now() - start };
            }

            case 'working_set': {
                const key = String(step.params.key ?? '');
                const value = step.params.value;
                const sessionId = step.params.sessionId as string | undefined;
                await workingSet(key, value, sessionId);
                return { stepId: step.id, success: true, data: { stored: true }, durationMs: Date.now() - start };
            }

            case 'working_get': {
                const key = String(step.params.key ?? '');
                const sessionId = step.params.sessionId as string | undefined;
                const value = await workingGet(key, sessionId);
                return { stepId: step.id, success: true, data: { value }, durationMs: Date.now() - start };
            }

            case 'recall': {
                const query = String(step.params.query ?? '');
                const topK = Number(step.params.topK ?? 10);
                const sessionId = step.params.sessionId as string | undefined;
                const results = await recall(query, topK, sessionId);
                return { stepId: step.id, success: true, data: results, durationMs: Date.now() - start };
            }

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

// ─── Direct API Functions (backward-compatible) ────────────────────────────────
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
