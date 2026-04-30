export type EmbedFormatId = "gemma" | "qwen3" | "bge-m3" | "raw";

export type EmbedFormat = {
  query: (q: string) => string;
  doc: (text: string, title?: string) => string;
};

export const FORMATS: Record<EmbedFormatId, EmbedFormat> = {
  gemma: {
    query: (q) => `task: search result | query: ${q}`,
    doc: (t, h) => `title: ${h || "none"} | text: ${t}`,
  },
  qwen3: {
    query: (q) => `Instruct: Retrieve relevant documents for the given query\nQuery: ${q}`,
    doc: (t, h) => (h ? `${h}\n${t}` : t),
  },
  "bge-m3": {
    query: (q) => q,
    doc: (t, h) => (h ? `${h}\n${t}` : t),
  },
  raw: {
    query: (q) => q,
    doc: (t, h) => (h ? `${h}\n${t}` : t),
  },
};

const FORMAT_IDS = new Set<EmbedFormatId>(["gemma", "qwen3", "bge-m3", "raw"]);

export function detectEmbedFormat(uri: string): EmbedFormatId {
  const override = process.env.QMD_EMBED_FORMAT?.trim().toLowerCase();
  if (override && FORMAT_IDS.has(override as EmbedFormatId)) {
    return override as EmbedFormatId;
  }
  if (/qwen.*embed|embed.*qwen/i.test(uri)) return "qwen3";
  if (/bge-?m3/i.test(uri)) return "bge-m3";
  if (/embeddinggemma|gemma.*embed/i.test(uri)) return "gemma";
  return "raw";
}
