import { ChromaClient, Collection } from 'chromadb';

const COLLECTION_NAME = 'astra_memories';

let client: ChromaClient;
let collection: Collection;

export async function getChromaCollection(): Promise<Collection> {
    if (!collection) {
        const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
        client = new ChromaClient({ path: chromaUrl });
        collection = await client.getOrCreateCollection({
            name: COLLECTION_NAME,
            metadata: { description: 'ASTRA memory embeddings' },
        });
    }
    return collection;
}

export async function addToChroma(
    id: string,
    text: string,
    metadata?: Record<string, string>,
): Promise<void> {
    const col = await getChromaCollection();
    await col.add({
        ids: [id],
        documents: [text],
        metadatas: metadata ? [metadata] : undefined,
    });
}

export async function queryChroma(
    queryText: string,
    topK = 5,
): Promise<{ id: string; text: string; score: number; metadata?: Record<string, string> }[]> {
    const col = await getChromaCollection();

    const results = await col.query({
        queryTexts: [queryText],
        nResults: topK,
    });

    const items: { id: string; text: string; score: number; metadata?: Record<string, string> }[] = [];

    if (results.ids[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
            items.push({
                id: results.ids[0][i],
                text: results.documents[0]?.[i] ?? '',
                score: results.distances?.[0]?.[i] ?? 0,
                metadata: (results.metadatas?.[0]?.[i] as Record<string, string>) ?? undefined,
            });
        }
    }

    return items;
}
