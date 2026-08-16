export const CHUNK_SIZE = 1800;
export const CHUNK_OVERLAP = 180;
export const MAX_CHUNKS = 400;

export function splitChunks(content, { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS } = {}) {
  const normalized = content.replace(/\r/g, '').trim();
  const stride = Math.max(1, size - overlap);
  const chunks = [];

  for (let start = 0; start < normalized.length; start += stride) {
    const chunk = normalized.slice(start, start + size).trim();
    if (chunk.length >= 80) chunks.push(chunk);
    if (chunks.length > maxChunks) break;
  }

  const truncated = chunks.length > maxChunks;
  return {
    chunks: truncated ? chunks.slice(0, maxChunks) : chunks,
    truncated,
    truncationReason: truncated
      ? `Source exceeded the ${maxChunks}-chunk limit; only the first ${maxChunks * stride} characters were embedded.`
      : undefined,
    sourceChars: normalized.length,
  };
}
