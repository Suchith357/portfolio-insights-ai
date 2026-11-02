/**
 * Local quota-free embedding fallback (PortfolioIQ AI foundation).
 *
 * Used by the OPENROUTER runtime when hosted embedding quota/rate limits make
 * rebuilds and query embeddings impossible (observed live: free-tier 429s).
 * It is a REAL vector embedding — deterministic feature hashing (the
 * "hashing trick") over word unigrams + bigrams with sublinear term
 * frequency, signed bins and L2 normalisation — so it works directly with the
 * existing FAISS IndexFlatIP cosine store. It is NOT a random vector and NOT
 * plain keyword matching: documents and queries live in the same 384-d
 * vector space and are ranked by cosine similarity.
 *
 * LIMITATIONS (must stay visible to operators): this space is LEXICAL, not
 * semantic — paraphrases with little word overlap score lower than a neural
 * embedding model would. The active provider is stamped into the index
 * metadata (`local/hash-bow-384`), surfaced by /api/ai/status, and a hosted
 * rebuild (POST /api/admin/ai/index/rebuild after quota recovery) restores
 * semantic vectors. Geometry never mixes: a hosted index and a local query
 * vector can never be searched together (vector-store checks the stamp).
 *
 * Determinism: no randomness, no network, no model files — the same text
 * always produces the same vector on any machine, so index and query
 * embeddings always share one geometry.
 */

export const LOCAL_EMBED_MODEL = "local/hash-bow-384";
export const LOCAL_EMBED_DIM = 384;

/** Minimal English stopword list — removed so question wording does not
 *  dominate the vector; content words (incl. ₹/numbers/dates) are kept. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
  "do", "does", "for", "from", "had", "has", "have", "how", "if", "in",
  "into", "is", "it", "its", "may", "not", "of", "on", "or", "our", "s",
  "so", "than", "that", "the", "their", "them", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "which", "who",
  "will", "with", "would", "you", "your",
]);

/** FNV-1a 32-bit hash (stable across platforms and Node versions). */
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase, split on non-alphanumerics (keeps ₹ amounts, tickers, FY2026). */
function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Embed one text into a unit-length 384-d vector.
 * Features = word unigrams + adjacent bigrams; weight = sublinear TF
 * (1 + ln(count)); each feature lands in one signed bin (two independent
 * hashes decide bin and sign, so collisions cancel instead of stack).
 */
export function localEmbed(text: string): number[] {
  const vec = new Array<number>(LOCAL_EMBED_DIM).fill(0);
  const tokens = tokenize((text ?? "").slice(0, 8000));

  const counts = new Map<string, number>();
  const bump = (feature: string, amount = 1) => counts.set(feature, (counts.get(feature) ?? 0) + amount);
  for (const t of tokens) bump(t);
  for (let i = 1; i < tokens.length; i++) bump(`${tokens[i - 1]}_${tokens[i]}`);

  for (const [feature, count] of counts) {
    const weight = 1 + Math.log(count);
    const idx = fnv1a(feature, 0x811c9dc5) % LOCAL_EMBED_DIM;
    const sign = fnv1a(feature, 0x9e3779b9) & 1 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign * weight;
  }

  // L2 normalise (cosine-ready); an all-stopword/empty text stays a zero
  // vector — callers treat zero similarity as "no match", never as noise.
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec;
  const norm = Math.sqrt(sumSq);
  return vec.map((v) => v / norm);
}

/** Embed a batch (order-preserving, same contract as the hosted client). */
export function localEmbedMany(texts: string[]): number[][] {
  return texts.map(localEmbed);
}
