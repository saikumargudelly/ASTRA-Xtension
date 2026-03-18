// ─── PostgreSQL DB Client (Tier 3 Semantic Memory) ────────────────────────────
// pg Pool singleton with pgvector support and automatic schema migration.

import { Pool, type PoolClient } from 'pg';

const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgresql://nexus:nexus@localhost:5432/nexus';

let pool: Pool | null = null;
let postgresAvailable = false;

// ─── Singleton Pool ────────────────────────────────────────────────────────────
function getPool(): Pool {
    if (pool) return pool;

    pool = new Pool({
        connectionString: POSTGRES_URL,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 3000,
    });

    pool.on('error', (err) => {
        if (err.message.includes('ECONNREFUSED') || err.message.includes('connect')) {
            postgresAvailable = false;
        } else {
            console.error('[PostgreSQL] Pool error:', err.message);
        }
    });

    return pool;
}

// ─── Schema Migration ──────────────────────────────────────────────────────────
export async function migrateSchema(): Promise<void> {
    let client: PoolClient | null = null;
    try {
        client = await getPool().connect();
        postgresAvailable = true;

        // Enable pgvector extension
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

        // Semantic memory table
        await client.query(`
      CREATE TABLE IF NOT EXISTS semantic_memory (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text        TEXT NOT NULL,
        embedding   vector(1536),
        type        VARCHAR(50) DEFAULT 'fact',
        source      VARCHAR(100),
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT now(),
        updated_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

        // Index for vector similarity search
        await client.query(`
      CREATE INDEX IF NOT EXISTS semantic_memory_embedding_idx
      ON semantic_memory USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);

        // Full-text search index
        await client.query(`
      CREATE INDEX IF NOT EXISTS semantic_memory_text_idx
      ON semantic_memory USING gin(to_tsvector('english', text))
    `);

        // User preferences table
        await client.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key         VARCHAR(255) UNIQUE NOT NULL,
        value       JSONB NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

        // Task history table
        await client.query(`
      CREATE TABLE IF NOT EXISTS task_history (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    VARCHAR(255),
        intent        TEXT,
        category      VARCHAR(50),
        success       BOOLEAN,
        duration_ms   INTEGER,
        agent_count   INTEGER,
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT now()
      )
    `);

        console.log('[PostgreSQL] Schema migration completed');
    } catch (err) {
        const message = (err as Error)?.message ?? '';
        const isConnectionError =
            !message ||
            message.includes('ECONNREFUSED') ||
            message.includes('ETIMEDOUT') ||
            message.includes('ENOTFOUND') ||
            message.includes('EHOSTUNREACH') ||
            message.includes('ECONNRESET') ||
            message.includes('Connection terminated') ||
            message.includes('connect') ||
            message.includes('getaddrinfo') ||
            message.includes('timeout') ||
            message.includes('socket');
        if (isConnectionError) {
            postgresAvailable = false;
            console.warn('[PostgreSQL] Not available — semantic memory disabled. Start with: docker compose up postgres -d');
        } else {
            console.error('[PostgreSQL] Migration error:', message);
        }
    } finally {
        client?.release();
    }
}

// ─── Query Helpers ─────────────────────────────────────────────────────────────
export async function pgQuery<T = unknown>(
    sql: string,
    params: unknown[] = [],
): Promise<T[]> {
    if (!postgresAvailable) return [];
    try {
        const client = await getPool().connect();
        try {
            const result = await client.query(sql, params);
            return result.rows as T[];
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[PostgreSQL] Query error:', (err as Error).message);
        return [];
    }
}

export async function pgQueryOne<T = unknown>(
    sql: string,
    params: unknown[] = [],
): Promise<T | null> {
    const rows = await pgQuery<T>(sql, params);
    return rows[0] ?? null;
}

// ─── Convenience Methods ───────────────────────────────────────────────────────
export async function getPreference(key: string): Promise<unknown | null> {
    const row = await pgQueryOne<{ value: unknown }>(
        'SELECT value FROM user_preferences WHERE key = $1',
        [key],
    );
    return row?.value ?? null;
}

export async function setPreference(key: string, value: unknown): Promise<void> {
    await pgQuery(
        `INSERT INTO user_preferences (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, JSON.stringify(value)],
    );
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
export async function closePostgres(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        postgresAvailable = false;
        console.log('[PostgreSQL] Pool closed');
    }
}

export function isPostgresAvailable(): boolean {
    return postgresAvailable;
}
