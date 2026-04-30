import { isJiebaActive } from "./segmentCJK.js";

const ALLOWED_TOKENIZERS = new Set([
  "porter unicode61",
  "unicode61",
  "unicode61 remove_diacritics 2",
  "trigram",
  "trigram case_sensitive 0",
  "trigram remove_diacritics 1",
  "ascii",
]);

const AUTO_VALUE = "auto";

export function resolveTokenizer(): string {
  const raw = process.env.QMD_FTS_TOKENIZER?.trim() ?? "porter unicode61";
  if (raw === AUTO_VALUE) {
    return isJiebaActive() ? "porter unicode61" : "trigram";
  }
  if (ALLOWED_TOKENIZERS.has(raw)) return raw;
  process.stderr.write(
    `QMD Warning: invalid QMD_FTS_TOKENIZER="${raw}", using default 'porter unicode61'.\n`
  );
  return "porter unicode61";
}

export function getTokenizerFamily(tokenizerSpec: string): string {
  return tokenizerSpec.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}
