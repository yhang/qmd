import { createRequire } from "node:module";
import { containsCJK } from "../i18n/cjk.js";

type Jieba = { cut: (text: string, hmm?: boolean) => string[] };

const require_ = createRequire(import.meta.url);
let jieba: Jieba | null = null;
let loadError: string | null = null;

try {
  const mod = require_("@node-rs/jieba") as { Jieba: { withDict(d: Uint8Array): Jieba } };
  const { dict } = require_("@node-rs/jieba/dict") as { dict: Uint8Array };
  jieba = mod.Jieba.withDict(dict);
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
  jieba = null;
}

export function isJiebaAvailable(): boolean {
  return jieba !== null;
}

export function getJiebaStatus(): { available: boolean; reason?: string } {
  return jieba ? { available: true } : { available: false, reason: loadError ?? "not installed" };
}

type SegmenterSetting = "identity" | "jieba" | "auto";
let segmenterSettingCache: SegmenterSetting | null = null;
const warnedUnknownValues = new Set<string>();

function resolveSegmenterSetting(): SegmenterSetting {
  if (segmenterSettingCache !== null) return segmenterSettingCache;
  const raw = (process.env.QMD_FTS_SEGMENTER ?? "identity").toLowerCase();
  if (raw === "identity" || raw === "jieba" || raw === "auto") {
    segmenterSettingCache = raw;
    return raw;
  }
  if (!warnedUnknownValues.has(raw)) {
    warnedUnknownValues.add(raw);
    console.warn(`[qmd] unknown QMD_FTS_SEGMENTER='${raw}', falling back to 'identity'`);
  }
  segmenterSettingCache = "identity";
  return "identity";
}

export function __resetSegmenterSettingCache(): void {
  segmenterSettingCache = null;
  warnedUnknownValues.clear();
}

export function isJiebaActive(): boolean {
  const setting = resolveSegmenterSetting();
  if (setting === "identity") return false;
  return isJiebaAvailable();
}

export const JIEBA_COMPATIBLE_TOKENIZERS = new Set(["porter", "unicode61"]);

export function shouldApplyJiebaSegmentation(tokenizerFamily: string): boolean {
  return JIEBA_COMPATIBLE_TOKENIZERS.has(tokenizerFamily) && isJiebaActive();
}

const CJK_RUN =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9F]+/gu;

export function segmentCJK(text: string): string {
  if (!jieba || !containsCJK(text)) return text;
  return text.replace(CJK_RUN, (run) => jieba!.cut(run, true).join(" "));
}
