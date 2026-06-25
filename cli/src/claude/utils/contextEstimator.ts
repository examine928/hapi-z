/**
 * 上下文占用估算器
 *
 * 部分第三方供应商（讯飞等）不稳定返回 usage，甚至整条会话全是 0。
 * 此时 web 端拿不到 contextSize，状态栏无法显示占用。
 *
 * 本模块读取 Claude Code 的 transcript jsonl 估算当前 context：
 * 1. 优先用最近一条主链 assistant 的真实 usage（供应商返回了就用）
 * 2. usage 缺失/为 0 时，按去重后的主链消息字符数估算 token
 *
 * 注意：字符估算不精确（不含 system prompt、工具 schema），但比"无数据"
 * 更有用——至少能反映 context 随对话增长的趋势。
 */

import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';

export interface ContextEstimate {
    usedTokens: number;
    contextWindow: number;
    source: 'usage' | 'estimate';
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const XUNFEI_CONTEXT_WINDOW_TOKENS = 200_000;

/** 中英混合场景的字符/token 系数（纯英文约 4，纯中文约 1.5，混合折中） */
const CHARS_PER_TOKEN = 3.5;
/** 系统开销余量系数（system prompt、工具定义等隐藏 token） */
const OVERHEAD_FACTOR = 1.1;

/** 讯飞供应商检测（通过 ANTHROPIC_BASE_URL） */
export function isXunfeiProvider(): boolean {
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? '';
    return baseUrl.includes('xf-yun.com') || baseUrl.includes('xunfei');
}

/**
 * 推断上下文窗口大小
 * - 讯飞：固定 200k（端点不支持 1M，即使选了 [1m]）
 * - 其它：[1m] 后缀 → 1M，否则 200k
 */
export function inferContextWindow(model: string | null | undefined): number {
    if (isXunfeiProvider()) {
        return XUNFEI_CONTEXT_WINDOW_TOKENS;
    }
    if (!model) {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }
    return model.endsWith('[1m]') ? LARGE_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

interface ParsedUsage {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface TranscriptEntry {
    type?: string;
    isSidechain?: boolean;
    timestamp?: string;
    isApiErrorMessage?: boolean;
    message?: {
        role?: string;
        content?: unknown;
        usage?: ParsedUsage;
        stop_reason?: string | null;
    };
}

function parseLine(line: string): TranscriptEntry | null {
    try {
        return JSON.parse(line) as TranscriptEntry;
    } catch {
        return null;
    }
}

/** 找最近一条主链 assistant 的真实 usage（input_tokens > 0） */
function findLatestRealUsage(lines: string[]): ParsedUsage | null {
    let latest: { usage: ParsedUsage; time: number } | null = null;
    for (const line of lines) {
        const entry = parseLine(line);
        if (!entry || entry.type !== 'assistant' || entry.isSidechain === true || entry.isApiErrorMessage === true) {
            continue;
        }
        const usage = entry.message?.usage;
        if (!usage || typeof usage.input_tokens !== 'number' || usage.input_tokens <= 0) {
            continue;
        }
        const time = entry.timestamp ? Date.parse(entry.timestamp) : 0;
        if (!latest || time >= latest.time) {
            latest = { usage, time };
        }
    }
    return latest?.usage ?? null;
}

/** 从 content block 累计字符数（支持 text/tool_use/tool_result/thinking） */
function countContentChars(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;
    let total = 0;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') total += b.text.length;
        if (b.type === 'tool_use' && b.input !== undefined) {
            total += typeof b.input === 'string' ? b.input.length : safeJsonLength(b.input);
        }
        if (b.type === 'tool_result') total += countContentChars(b.content);
        if (typeof b.thinking === 'string') total += b.thinking.length;
    }
    return total;
}

function safeJsonLength(value: unknown): number {
    try { return JSON.stringify(value).length; } catch { return 0; }
}

/**
 * 累计主链消息字符数（流式去重）。
 * 参考 ccstatusline jsonl-metrics 的去重逻辑：
 * 只算 stop_reason 非 null 的（每轮 final）+ 最后一条 null（当前未完成轮）。
 */
function countMainChainChars(lines: string[]): number {
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
        const e = parseLine(line);
        if (e) entries.push(e);
    }

    // assistant：主链 + 流式去重
    const assistants = entries.filter((e) => e.type === 'assistant' && e.isSidechain !== true);
    const hasStopReason = assistants.some((e) =>
        e.message ? Object.hasOwn(e.message, 'stop_reason') : false
    );
    const toCount = hasStopReason
        ? assistants.filter((e, i) => {
              const sr = e.message?.stop_reason;
              return Boolean(sr) || (sr === null && i === assistants.length - 1);
          })
        : assistants;

    let total = 0;
    for (const e of toCount) total += countContentChars(e.message?.content);
    // user 消息：无 stop_reason，全算主链
    for (const e of entries) {
        if (e.type === 'user' && e.isSidechain !== true) {
            total += countContentChars(e.message?.content);
        }
    }
    return total;
}

/**
 * 从 transcript 估算 context 占用。
 * 优先真实 usage，无则字符估算。
 */
export function estimateContextFromTranscript(
    transcriptPath: string,
    model: string | null | undefined
): ContextEstimate | null {
    const contextWindow = inferContextWindow(model);

    if (!existsSync(transcriptPath)) {
        return null;
    }

    let lines: string[];
    try {
        const content = readFileSync(transcriptPath, 'utf-8');
        lines = content.split('\n').filter((l) => l.length > 0);
    } catch (error) {
        logger.debug(`[contextEstimator] 读取失败: ${transcriptPath}`, error);
        return null;
    }

    if (lines.length === 0) {
        return { usedTokens: 0, contextWindow, source: 'estimate' };
    }

    // 1. 优先真实 usage
    const usage = findLatestRealUsage(lines);
    if (usage) {
        const usedTokens =
            usage.input_tokens! +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
        return { usedTokens, contextWindow, source: 'usage' };
    }

    // 2. 兜底：字符估算
    const totalChars = countMainChainChars(lines);
    const usedTokens = Math.ceil((totalChars / CHARS_PER_TOKEN) * OVERHEAD_FACTOR);
    return { usedTokens, contextWindow, source: 'estimate' };
}
