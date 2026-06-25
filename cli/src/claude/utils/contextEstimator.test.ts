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
    isXunfeiProvider,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    LARGE_CONTEXT_WINDOW_TOKENS,
    XUNFEI_CONTEXT_WINDOW_TOKENS
} from './contextEstimator'

function assistantUsage(inputTokens: number, ts = '2026-01-01T00:00:00.000Z'): string {
    return JSON.stringify({
        type: 'assistant', isSidechain: false, timestamp: ts,
        message: {
            role: 'assistant', content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        }
    })
}

function assistantNoUsage(text: string, stopReason: string | null = 'end_turn'): string {
    return JSON.stringify({
        type: 'assistant', isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason }
    })
}

function sidechainUsage(inputTokens: number): string {
    return JSON.stringify({
        type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: inputTokens, output_tokens: 1 } }
    })
}

function userMsg(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
}

describe('contextEstimator', () => {
    let tmpDir: string
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'hapi-est-')) })
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

    describe('inferContextWindow', () => {
        it('null → 200k', () => {
            expect(inferContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
        })
        it('[1m] 后缀 → 1M', () => {
            expect(inferContextWindow('sonnet[1m]')).toBe(LARGE_CONTEXT_WINDOW_TOKENS)
        })
        it('普通 → 200k', () => {
            expect(inferContextWindow('sonnet')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
        })
    })

    describe('isXunfeiProvider', () => {
        const orig = process.env.ANTHROPIC_BASE_URL
        afterEach(() => {
            if (orig === undefined) delete process.env.ANTHROPIC_BASE_URL
            else process.env.ANTHROPIC_BASE_URL = orig
        })
        it('讯飞端点识别', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com'
            expect(isXunfeiProvider()).toBe(true)
        })
        it('其它端点不识别', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn'
            expect(isXunfeiProvider()).toBe(false)
        })
        it('讯飞强制 200k 即使 [1m]', () => {
            process.env.ANTHROPIC_BASE_URL = 'https://maas-coding-api.cn-huabei-1.xf-yun.com'
            expect(inferContextWindow('sonnet[1m]')).toBe(XUNFEI_CONTEXT_WINDOW_TOKENS)
        })
    })

    describe('estimateContextFromTranscript', () => {
        it('文件不存在 → null', () => {
            expect(estimateContextFromTranscript(join(tmpDir, 'nope.jsonl'), 'sonnet')).toBeNull()
        })

        it('有真实 usage 优先用（含 cache）', () => {
            const p = join(tmpDir, 'a.jsonl')
            writeFileSync(p, [userMsg('hi'), assistantUsage(1000)].join('\n'))
            const r = estimateContextFromTranscript(p, 'sonnet')!
            expect(r.source).toBe('usage')
            expect(r.usedTokens).toBe(1000)
        })

        it('取最近一条真实 usage', () => {
            const p = join(tmpDir, 'b.jsonl')
            writeFileSync(p, [
                assistantUsage(100, '2026-01-01T00:00:00.000Z'),
                assistantUsage(500, '2026-01-02T00:00:00.000Z')
            ].join('\n'))
            expect(estimateContextFromTranscript(p, 'sonnet')!.usedTokens).toBe(500)
        })

        it('忽略 sidechain usage', () => {
            const p = join(tmpDir, 'c.jsonl')
            writeFileSync(p, [sidechainUsage(99999), assistantNoUsage('main')].join('\n'))
            const r = estimateContextFromTranscript(p, 'sonnet')!
            // sidechain 99999 被忽略，走字符估算
            expect(r.source).toBe('estimate')
            expect(r.usedTokens).toBeLessThan(99999)
        })

        it('无 usage 时字符估算', () => {
            const p = join(tmpDir, 'd.jsonl')
            const t = 'a'.repeat(350)  // user 350 + assistant 350 = 700 字符
            writeFileSync(p, [userMsg(t), assistantNoUsage(t)].join('\n'))
            const r = estimateContextFromTranscript(p, 'sonnet')!
            expect(r.source).toBe('estimate')
            expect(r.usedTokens).toBe(Math.ceil(700 / 3.5 * 1.1))
        })

        it('流式去重：intermediate 不累加', () => {
            const p = join(tmpDir, 'e.jsonl')
            writeFileSync(p, [
                userMsg('hello'),                              // 5
                assistantNoUsage('p1', null),                  // intermediate，忽略
                assistantNoUsage('final answer', 'end_turn')   // final，12
            ].join('\n'))
            const r = estimateContextFromTranscript(p, 'sonnet')!
            expect(r.source).toBe('estimate')
            // 只算 user(5) + final(12) = 17
            expect(r.usedTokens).toBe(Math.ceil(17 / 3.5 * 1.1))
        })
    })
})
