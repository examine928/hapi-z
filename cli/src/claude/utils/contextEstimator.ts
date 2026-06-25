/**
 * 上下文占用估算器
 *
 * 第三方供应商（智谱 GLM / 讯飞等）经常不返回 usage 字段，导致 Web 端
 * reducer 算出 contextSize=0，状态栏一直显示"剩余 100%"。
 *
 * 本模块读取 Claude Code 的 transcript jsonl，估算当前上下文占用：
 * 1. 优先用最近一条主链 assistant 消息的 usage（供应商返回了就用真实值）
 * 2. usage 缺失时，累计所有消息文本字符数，按启发式系数估算 token
 *
 * 注意：字符估算是近似值，不含 system prompt、工具定义、cache 等隐藏 token，
 * 会偏低。但相比"完全失明显示 100%"是巨大改进。
 */

import { existsSync, readFileSync } from 'node:fs';
import { logger } from '@/ui/logger';

/** 估算接口 */
export interface ContextEstimate {
    /** 已用 token 数（真实 usage 或估算值） */
    usedTokens: number;
    /** 上下文窗口大小（token） */
    contextWindow: number;
    /** 数据来源标记，用于日志和显示降级 */
    source: 'usage' | 'estimate';
    /** 当前供应商类型，影响窗口上限和是否启用主动压缩 */
    provider: ProviderKind;
}

/** 已知第三方供应商类型 */
export type ProviderKind = 'xunfei' | 'other';

/** 默认上下文窗口（无法从模型名推断时的兜底） */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
/** 1M 上下文窗口 */
export const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;
/**
 * 讯飞实际上下文上限。讯飞端点（xf-yun.com）对所有模型强制 ~200k，
 * 即使 HAPI 里选了 [1m] 也不生效（错误：input token limit is 202752）。
 * 略小于 200k，留安全余量。
 */
export const XUNFEI_CONTEXT_WINDOW_TOKENS = 200_000;

/** 中英混合场景的保守字符/token 系数 */
const CHARS_PER_TOKEN = 3;
/** 系统开销余量系数（system prompt、工具定义等隐藏 token） */
const OVERHEAD_FACTOR = 1.1;

/**
 * 检测当前供应商类型。
 * 通过 ANTHROPIC_BASE_URL 环境变量判断（用户启动 runner 前 export）。
 */
export function detectProvider(): ProviderKind {
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? '';
    // 讯飞端点：maas-coding-api.*.xf-yun.com
    if (baseUrl.includes('xf-yun.com') || baseUrl.includes('xunfei')) {
        return 'xunfei';
    }
    return 'other';
}

/**
 * 根据供应商和模型推断上下文窗口大小。
 * 讯飞强制使用 XUNFEI_CONTEXT_WINDOW_TOKENS（忽略 [1m]，因为讯飞端不支持）。
 */
export function inferContextWindow(
    model: string | null | undefined,
    provider: ProviderKind = detectProvider()
): number {
    // 讯飞：无视模型名，固定 200k
    if (provider === 'xunfei') {
        return XUNFEI_CONTEXT_WINDOW_TOKENS;
    }
    if (!model) {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }
    return model.endsWith('[1m]') ? LARGE_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

interface ParsedUsage {
    input_tokens?: number;
    output_tokens?: number;
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
    };
}

/** 解析单行 jsonl，失败返回 null */
function parseLine(line: string): TranscriptEntry | null {
    try {
        return JSON.parse(line) as TranscriptEntry;
    } catch {
        return null;
    }
}

/**
 * 在 transcript 行中找最近一条主链 assistant 消息的 usage
 * 主链 = isSidechain 非 true；忽略 API 错误合成消息
 */
function findLatestMainChainUsage(lines: string[]): ParsedUsage | null {
    let latest: { usage: ParsedUsage; time: number } | null = null;

    for (const line of lines) {
        const entry = parseLine(line);
        if (!entry || entry.type !== 'assistant') {
            continue;
        }
        if (entry.isSidechain === true || entry.isApiErrorMessage === true) {
            continue;
        }
        const usage = entry.message?.usage;
        if (!usage || typeof usage.input_tokens !== 'number') {
            continue;
        }
        const time = entry.timestamp ? Date.parse(entry.timestamp) : 0;
        if (!latest || time >= latest.time) {
            latest = { usage, time };
        }
    }

    return latest?.usage ?? null;
}

/**
 * 从消息 content 中累计文本字符数
 * 支持 string 和 content block 数组两种形态
 */
function countContentChars(content: unknown): number {
    if (typeof content === 'string') {
        return content.length;
    }
    if (!Array.isArray(content)) {
        return 0;
    }

    let total = 0;
    for (const block of content) {
        if (!block || typeof block !== 'object') {
            continue;
        }
        const b = block as Record<string, unknown>;

        // text 块
        if (typeof b.text === 'string') {
            total += b.text.length;
        }
        // tool_use 块：input 通常含较大 payload（如 Read 的文件内容），按 JSON 估算
        if (b.type === 'tool_use' && b.input !== undefined) {
            total += measureInputChars(b.input);
        }
        // tool_result 块：content 可能是 string 或数组
        if (b.type === 'tool_result') {
            total += countContentChars(b.content);
        }
        // thinking 块
        if (typeof b.thinking === 'string') {
            total += b.thinking.length;
        }
    }
    return total;
}

/** 估算 tool_use input 的字符数（JSON 序列化） */
function measureInputChars(input: unknown): number {
    if (input === null || input === undefined) {
        return 0;
    }
    if (typeof input === 'string') {
        return input.length;
    }
    try {
        return JSON.stringify(input).length;
    } catch {
        return 0;
    }
}

/** 累计 transcript 所有消息的文本字符数 */
function countTranscriptChars(lines: string[]): number {
    let total = 0;
    for (const line of lines) {
        const entry = parseLine(line);
        if (!entry?.message) {
            continue;
        }
        total += countContentChars(entry.message.content);
    }
    return total;
}

/** 过滤空行，返回有效 jsonl 行 */
function readLines(transcriptPath: string): string[] {
    const content = readFileSync(transcriptPath, 'utf-8');
    return content.split('\n').filter((line) => line.length > 0);
}

/**
 * 从 transcript jsonl 估算当前 context 占用
 *
 * @param transcriptPath transcript 文件绝对路径
 * @param model 模型名，用于推断 context_window
 * @returns 估算结果，或 null（文件不存在/无法读取）
 */
export function estimateContextFromTranscript(
    transcriptPath: string,
    model: string | null | undefined
): ContextEstimate | null {
    const provider = detectProvider();
    const contextWindow = inferContextWindow(model, provider);

    if (!existsSync(transcriptPath)) {
        logger.debug(`[contextEstimator] transcript 不存在: ${transcriptPath}`);
        return null;
    }

    let lines: string[];
    try {
        lines = readLines(transcriptPath);
    } catch (error) {
        logger.debug(`[contextEstimator] 读取 transcript 失败: ${transcriptPath}`, error);
        return null;
    }

    if (lines.length === 0) {
        return { usedTokens: 0, contextWindow, source: 'estimate', provider };
    }

    // 1. 优先用真实 usage
    const usage = findLatestMainChainUsage(lines);
    if (usage && typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
        const usedTokens =
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
        return { usedTokens, contextWindow, source: 'usage', provider };
    }

    // 2. 兜底：字符估算
    const totalChars = countTranscriptChars(lines);
    const usedTokens = Math.ceil((totalChars / CHARS_PER_TOKEN) * OVERHEAD_FACTOR);
    return { usedTokens, contextWindow, source: 'estimate', provider };
}
