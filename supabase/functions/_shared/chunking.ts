export interface ChunkResult {
  chunks: string[];
  truncated: boolean;
  truncationReason?: string;
  sourceChars: number;
}

export const CHUNK_SIZE = 1800;
export const CHUNK_OVERLAP = 180;
/**
 * Raised from the original 100. At 1800 characters per chunk the old cap
 * silently discarded everything past ~180 KB of source text — an 80-file
 * repository was reduced to a fraction of itself with no indication anywhere
 * in the UI. Truncation is now both later and reported.
 */
export const MAX_CHUNKS = 400;

export function splitChunks(
  content: string,
  { size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS } = {},
): ChunkResult {
  const normalized = content.replace(/\r/g, '').trim();
  const stride = Math.max(1, size - overlap);
  const chunks: string[] = [];

  for (let start = 0; start < normalized.length; start += stride) {
    const chunk = normalized.slice(start, start + size).trim();
    // Trailing slivers carry no retrievable meaning.
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
