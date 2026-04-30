import { isPredominantlyCJK } from "./i18n/cjk.js";

type ExpandPrompt = (q: string, intent?: string) => string;

const PROMPTS: Record<"en" | "zh", ExpandPrompt> = {
  en: (q, intent) =>
    intent
      ? `/no_think Expand this search query: ${q}\nQuery intent: ${intent}`
      : `/no_think Expand this search query: ${q}`,
  zh: (q, intent) => {
    const head = `/no_think 将以下中文搜索查询扩展为多行结构化输出。
保留 "lex:"/"vec:"/"hyde:" 英文前缀，正文用中文。
- lex 行给 1-3 个关键词（适合 BM25）
- vec 行给 1-3 条自然语言改写（适合向量检索）
- hyde 行给 1 句假设性答案段落
查询：${q}`;
    return intent ? `${head}\n查询意图：${intent}` : head;
  },
};

export type ExpandLangSetting = "auto" | "en" | "zh" | "force" | "skip";

export function resolvePromptLang(query: string): "en" | "zh" {
  const raw = (process.env.QMD_EXPAND_LANG ?? "auto").toLowerCase();
  if (raw === "en") return "en";
  if (raw === "zh") return "zh";
  return isPredominantlyCJK(query) ? "zh" : "en";
}

export function buildExpandPrompt(query: string, intent?: string): string {
  const override = process.env.QMD_EXPAND_PROMPT;
  if (override) {
    return override.replaceAll("{query}", query).replaceAll("{intent}", intent ?? "");
  }
  return PROMPTS[resolvePromptLang(query)](query, intent);
}

export type SkipLlmOptions = {
  usingDefaultGenerateModel?: boolean;
};

export function shouldSkipLlmExpansion(query: string, options?: SkipLlmOptions): boolean {
  const raw = (process.env.QMD_EXPAND_LANG ?? "auto").toLowerCase();
  if (raw === "skip") return true;
  if (raw === "force" || raw === "en" || raw === "zh") return false;
  if (process.env.QMD_EXPAND_PROMPT) return false;
  const usingDefault = options?.usingDefaultGenerateModel ?? true;
  return isPredominantlyCJK(query) && usingDefault;
}
