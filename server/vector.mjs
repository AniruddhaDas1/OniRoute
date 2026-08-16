import { db, LOCAL_USER_ID } from './db.mjs';

/**
 * Computes cosine similarity between two float vectors.
 * Handles 1536-dimensional vectors in sub-millisecond time.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * High-speed in-memory semantic search over vector chunks.
 */
export function searchVectorChunks(userId = LOCAL_USER_ID, queryEmbedding, kbId = null, topK = 6) {
  const candidates = db.getVectorChunksForSearch(userId, kbId);
  if (!candidates.length) return [];

  const scored = candidates.map((chunk) => ({
    id: chunk.id,
    content: chunk.content,
    metadata: chunk.metadata,
    similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}
