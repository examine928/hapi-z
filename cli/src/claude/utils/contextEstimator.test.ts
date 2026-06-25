/**
 * contextEstimator 单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    estimateContextFromTranscript,
    inferContextWindow,
    detectProvider,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    LARGE_CONTEXT_WINDOW_TOKENS,
    XUNFEI_CONTEXT_WINDOW_TOKENS
} from './contextEstimator'

/**
 * 构造一条 assistant 主链消息（带 usage）
 */
function assistantWithUsage(
    inputTokens: number,
    cacheRead = 0,
    cacheCreation = 0,
    timestamp = '2026-01-01T00:00:00.000Z'
): string {
    return JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        timestamp,
        message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
                input_tokens: inputTokens,
                output_tokens: 5,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheCreation
            }
        }
    })
}

/**
 * 构造一条无 usage 的 assistant 消息（模拟第三方供应商）
 */
function assistantWithoutUsage(text: string, timestamp = '2026-01-01T00:00:00.000Z'): string {
    return JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        timestamp,
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }]
        }
    })
}

/**
 * 构造一条 sidechain assistant（应被忽略）
 */
function sidechainAssistant(inputTokens: number): string {
    return JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'sidechain' }],
            usage: { input_tokens: inputTokens, output_tokens: 1 }
        }
    })
}

function userMessage(text: string): string {
    return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text }
    })
}

describe('contextEstimator', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'hapi-ctx-est-'))
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
    })

    describe('inferContextWindow', () => {
        it('null/undefined 返回默认 200k', () => {
            expect(inferContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
            expect(inferContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
        })

        it('[1m] 后缀返回 1M', () => {
            expect(inferContextWindow('sonnet[1m]')).toBe(LARGE_CONTEXT_WINDOW_TOKENS)
            expect(inferContextWindow('claude-opus-4-7[1m]')).toBe(LARGE_CONTEXT_WINDOW_TOKENS)
        })

        it('无 [1m] 后缀返回 200k', () => {
            expect(inferContextWindow('sonnet')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
            expect(inferContextWindow('claude-opus-4-7')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
        })

        it('讯飞供应商强制 200k，即使模型名带 [1m]', () => {
            expect(inferContextWindow('sonnet[1m]', 'xunfei')).toBe(XUNFEI_CONTEXT_WINDOW_TOKENS)
            expect(inferContextWindow('sonnet', 'xunfei')).toBe(XUNFEI_CONTEXT_WINDOW_TOKENS)
            expect(inferContextWindow(null, 'xunfei')).toBe(XUNFEI_CONTEXT_WINDOW_TOKENS)
        })
    })

    describe('detectProvider', () => {
        const origBaseUrl = process.env.ANTHROPIC_BASE_URL
        afterEach(() => {
            if (origBaseUrl === undefined) {
                delete process.env.ANTHROPIC_BASE_URL
            } else {
                process.env.ANTHROPIC_BASE_URL = origBaseUrl
            }
        })

        it('讯飞端点（xf-yun.com）识别为 xunfei', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com'
            expect(detectProvider()).toBe('xunfei')
        })

        it('含 xunfei 关键字识别为 xunfei', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://api.xunfei.cn'
            expect(detectProvider()).toBe('xunfei')
        })

        it('其它端点识别为 other', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn'
            expect(detectProvider()).toBe('other')
        })

        it('未设置 BASE_URL 识别为 other', () => {
            delete process.env.ANTHROPIC_BASE_URL
            expect(detectProvider()).toBe('other')
        })
    })

    describe('estimateContextFromTranscript', () => {
        it('文件不存在返回 null', () => {
            const result = estimateContextFromTranscript(join(tmpDir, 'nope.jsonl'), 'sonnet')
            expect(result).toBeNull()
        })

        it('空文件返回 0 占用', () => {
            const path = join(tmpDir, 'empty.jsonl')
            writeFileSync(path, '')
            const result = estimateContextFromTranscript(path, 'sonnet')
            expect(result).toMatchObject({ usedTokens: 0, contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'estimate' })
        })

        it('有 usage 时优先用真实值（含 cache）', () => {
            const path = join(tmpDir, 'with-usage.jsonl')
            writeFileSync(path, [
                userMessage('hello'),
                assistantWithUsage(1000, 2000, 500)
            ].join('\n'))
            const result = estimateContextFromTranscript(path, 'sonnet')
            // input 1000 + cache_read 2000 + cache_creation 500 = 3500
            expect(result).toMatchObject({ usedTokens: 3500, contextWindow: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'usage' })
        })

        it('取最近一条主链 assistant 的 usage', () => {
            const path = join(tmpDir, 'latest.jsonl')
            writeFileSync(path, [
                assistantWithUsage(100, 0, 0, '2026-01-01T00:00:00.000Z'),
                assistantWithUsage(500, 0, 0, '2026-01-02T00:00:00.000Z')
            ].join('\n'))
            const result = estimateContextFromTranscript(path, 'sonnet')
            expect(result?.usedTokens).toBe(500)
            expect(result?.source).toBe('usage')
        })

        it('忽略 sidechain 消息的 usage', () => {
            const path = join(tmpDir, 'sidechain.jsonl')
            writeFileSync(path, [
                sidechainAssistant(99999),
                assistantWithoutUsage('main reply')  // 无 usage，触发估算
            ].join('\n'))
            const result = estimateContextFromTranscript(path, 'sonnet')
            // sidechain usage 被忽略，走字符估算
            expect(result?.source).toBe('estimate')
            expect(result?.usedTokens).toBeGreaterThan(0)
            expect(result?.usedTokens).toBeLessThan(99999)
        })

        it('无 usage 时按字符数估算', () => {
            const path = join(tmpDir, 'no-usage.jsonl')
            const longText = 'a'.repeat(300)  // 300 字符
            writeFileSync(path, [
                userMessage(longText),
                assistantWithoutUsage(longText)
            ].join('\n'))
            const result = estimateContextFromTranscript(path, 'sonnet')
            expect(result?.source).toBe('estimate')
            // 总字符 600，÷3=200，×1.1=220
            expect(result?.usedTokens).toBe(Math.ceil(600 / 3 * 1.1))
        })

        it('context_window 随 [1m] 模型变化', () => {
            const path = join(tmpDir, '1m.jsonl')
            writeFileSync(path, assistantWithUsage(100))
            const result = estimateContextFromTranscript(path, 'sonnet[1m]')
            expect(result?.contextWindow).toBe(LARGE_CONTEXT_WINDOW_TOKENS)
        })

        it('讯飞场景：即使模型 [1m] 窗口也强制 200k，provider 标记 xunfei', () => {
            const origBaseUrl = process.env.ANTHROPIC_BASE_URL
            process.env.ANTHROPIC_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com'
            try {
                const path = join(tmpDir, 'xunfei.jsonl')
                writeFileSync(path, assistantWithUsage(5000))
                const result = estimateContextFromTranscript(path, 'sonnet[1m]')
                expect(result?.provider).toBe('xunfei')
                expect(result?.contextWindow).toBe(XUNFEI_CONTEXT_WINDOW_TOKENS)
                expect(result?.usedTokens).toBe(5000)
            } finally {
                if (origBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
                else process.env.ANTHROPIC_BASE_URL = origBaseUrl
            }
        })

        it('混合 content block 类型都能估算字符', () => {
            const path = join(tmpDir, 'mixed.jsonl')
            writeFileSync(path, JSON.stringify({
                type: 'assistant',
                isSidechain: false,
                timestamp: '2026-01-01T00:00:00.000Z',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'hello' },                    // 5 字符
                        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }  // JSON ~28 字符
                    ]
                }
            }))
            const result = estimateContextFromTranscript(path, null)
            expect(result?.source).toBe('estimate')
            expect(result?.usedTokens).toBeGreaterThan(0)
        })
    })
})
