import React from "react";
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import { estimateContextFromTranscript, type ContextEstimate } from "./utils/contextEstimator";
import { getProjectPath } from "./utils/path";
import { join } from "node:path";
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from "@/modules/common/remote/RemoteLauncherBase";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    allowedTools?: string[];
}

/**
 * 读 transcript 估算 context 占用（复用于 usage 回填和主动压缩检查）。
 */
function estimateContext(session: Session): ContextEstimate | null {
    if (!session.sessionId) {
        return null;
    }
    const transcriptPath = join(getProjectPath(session.path), `${session.sessionId}.jsonl`);
    const model = session.getModel();
    return estimateContextFromTranscript(transcriptPath, model);
}

/**
 * assistant 消息缺 usage 时，读 transcript 估算 context 占用并回填到 message.usage。
 * 仅当 usage 缺失或无 input_tokens 时介入；有真实 usage（官方 Anthropic）则不动。
 * 回填后走既有链路（converter → hub → web reducer），web 状态栏即可正常显示。
 */
function backfillAssistantUsageFromEstimate(
    logMessage: { type: string; message?: Record<string, unknown> } & Record<string, unknown>,
    session: Session
): void {
    const message = logMessage.message;
    if (!message || typeof message !== 'object') {
        return;
    }

    // 已有有效 usage 则不干预
    const existingUsage = message.usage;
    if (existingUsage && typeof existingUsage === 'object') {
        const inputTokens = (existingUsage as Record<string, unknown>).input_tokens;
        if (typeof inputTokens === 'number' && inputTokens > 0) {
            return;
        }
    }

    const estimate = estimateContext(session);
    if (!estimate) {
        return;
    }

    message.usage = {
        input_tokens: estimate.usedTokens,
        output_tokens: 0,
        context_window: estimate.contextWindow,
        // 标记为估算值，web 端按需识别（不影响现有 reducer 逻辑）
        estimated: true,
        source: estimate.source
    };
    logger.debug(
        `[remote] 回填 usage（${estimate.source}）: used=${estimate.usedTokens}, window=${estimate.contextWindow}`
    );
}

/**
 * 讯飞主动压缩阈值（占用百分比）。讯飞端 ~200k 硬上限，
 * 不返回 usage 导致 Claude Code auto-compact 失灵，必须在爆之前主动压缩。
 * 90% = 180k，留 20k 余量给压缩请求本身。
 */
const XUNFEI_AUTO_COMPACT_THRESHOLD = 90;

/**
 * 检查并在必要时触发讯飞专属主动压缩。
 * 仅对讯飞供应商生效；占用超阈值时往 session.queue 注入 /compact。
 * 用 compactArmed 防抖：触发后保持 armed，直到占用降到阈值以下（压缩完成）才解除。
 */
function maybeAutoCompactForXunfei(
    session: Session,
    armedRef: { armed: boolean }
): void {
    const estimate = estimateContext(session);
    if (!estimate || estimate.provider !== 'xunfei') {
        return;
    }

    const usedPercentage = (estimate.usedTokens / estimate.contextWindow) * 100;

    // 已 armed 且占用已降到阈值以下 → 压缩完成，解除防抖
    if (armedRef.armed) {
        if (usedPercentage < XUNFEI_AUTO_COMPACT_THRESHOLD) {
            armedRef.armed = false;
            logger.debug(`[remote] 讯飞压缩完成，占用降至 ${usedPercentage.toFixed(1)}%，解除防抖`);
        }
        return;
    }

    // 未 armed 且超阈值 → 触发压缩
    if (usedPercentage < XUNFEI_AUTO_COMPACT_THRESHOLD) {
        return;
    }

    armedRef.armed = true;
    logger.debug(
        `[remote] 讯飞 context 占用 ${usedPercentage.toFixed(1)}% ≥ ${XUNFEI_AUTO_COMPACT_THRESHOLD}%，触发主动压缩`
    );

    // 注入 /compact 到队列。mode 从 session 当前配置构造（/compact 是特殊命令，mode 影响小）
    const permissionMode = session.getPermissionMode() ?? 'default';
    const compactMode: EnhancedMode = {
        permissionMode,
        model: session.getModel() ?? undefined,
        effort: session.getEffort() ?? undefined
    };
    session.queue.unshiftIsolated('/compact', compactMode);
    session.client.sendSessionEvent({
        type: 'message',
        message: `⚠️ 讯飞上下文占用 ${Math.round(usedPercentage)}%，自动压缩中…`
    });
}


class ClaudeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: Session;
    private abortController: AbortController | null = null;
    private abortFuture: Future<void> | null = null;
    private permissionHandler: PermissionHandler | null = null;
    private handleSessionFound: ((sessionId: string) => void) | null = null;

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    private async abort(): Promise<void> {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        await this.abortFuture?.promise;
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[remote]: doAbort');
        await this.abort();
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[remote]: doSwitch');
        await this.requestExit('switch', async () => {
            await this.abort();
        });
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[remote]: Exiting client via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[remote]: Switching to local mode via double space');
        await this.handleSwitchRequest();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudeRemoteLauncher] Starting remote launcher');
        logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const permissionHandler = new PermissionHandler(session);
        this.permissionHandler = permissionHandler;

        const messageQueue = new OutgoingMessageQueue(
            (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
        );

        permissionHandler.setOnPermissionRequest((toolCallId: string) => {
            messageQueue.releaseToolCall(toolCallId);
        });

        const sdkToLogConverter = new SDKToLogConverter({
            sessionId: session.sessionId || 'unknown',
            cwd: session.path,
            version: process.env.npm_package_version
        }, permissionHandler.getResponses());

        const handleSessionFound = (sessionId: string) => {
            sdkToLogConverter.updateSessionId(sessionId);
        };
        this.handleSessionFound = handleSessionFound;
        session.addSessionFoundCallback(handleSessionFound);

        let planModeToolCalls = new Set<string>();
        let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
        // 讯飞主动压缩防抖：触发后保持 armed，直到占用降到阈值以下（压缩完成）才解除
        const compactArmed = { armed: false };

        function onMessage(message: SDKMessage) {
            formatClaudeMessageForInk(message, messageBuffer);
            permissionHandler.onMessage(message);

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                            logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                            planModeToolCalls.add(c.id! as string);
                        }
                    }
                }
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use') {
                            logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                            ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        }
                    }
                }
            }
            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            ongoingToolCalls.delete(c.tool_use_id);
                            messageQueue.releaseToolCall(c.tool_use_id);
                        }
                    }
                }
            }

            let msg = message;

            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    msg = {
                        ...umessage,
                        message: {
                            ...umessage.message,
                            content: umessage.message.content.map((c) => {
                                if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                    if (c.content === PLAN_FAKE_REJECT) {
                                        logger.debug('[remote]: hack plan mode exit');
                                        logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                        return {
                                            ...c,
                                            is_error: false,
                                            content: 'Plan approved',
                                            mode: c.mode
                                        };
                                    } else {
                                        return c;
                                    }
                                }
                                return c;
                            })
                        }
                    };
                }
            }

            const logMessage = sdkToLogConverter.convert(msg);
            // 第三方供应商（智谱/讯飞等）常不返回 usage，导致 Web 端 context 显示失灵。
            // assistant 消息缺 usage 时，读 transcript 估算并回填，让 web 正常显示占用。
            if (logMessage?.type === 'assistant') {
                backfillAssistantUsageFromEstimate(logMessage, session);
            }
            if (logMessage) {
                if (logMessage.type === 'user' && logMessage.message?.content) {
                    const content = Array.isArray(logMessage.message.content)
                        ? logMessage.message.content
                        : [];

                    for (let i = 0; i < content.length; i++) {
                        const c = content[i];
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            const responses = permissionHandler.getResponses();
                            const response = responses.get(c.tool_use_id);

                            if (response) {
                                const permissions: PermissionsField = {
                                    date: response.receivedAt || Date.now(),
                                    result: response.approved ? 'approved' : 'denied'
                                };

                                if (response.mode) {
                                    permissions.mode = response.mode;
                                }

                                if (response.allowTools && response.allowTools.length > 0) {
                                    permissions.allowedTools = response.allowTools;
                                }

                                content[i] = {
                                    ...c,
                                    permissions
                                };
                            }
                        }
                    }
                }

                if (logMessage.type === 'assistant' && message.type === 'assistant') {
                    const assistantMsg = message as SDKAssistantMessage;
                    const toolCallIds: string[] = [];

                    if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                        for (const block of assistantMsg.message.content) {
                            if (block.type === 'tool_use' && block.id) {
                                toolCallIds.push(block.id);
                            }
                        }
                    }

                    if (toolCallIds.length > 0) {
                        const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                        if (!isSidechain) {
                            messageQueue.enqueue(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return;
                        }
                    }
                }

                messageQueue.enqueue(logMessage);
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                            const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                            if (logMessage2) {
                                messageQueue.enqueue(logMessage2);
                            }
                        }
                    }
                }
            }

            // result 消息 = 一轮对话结束。此时检查讯飞 context 占用，超阈值主动压缩。
            // 压缩完成后下一轮的 usage 会骤降，compactArmed 据此解除。
            if (message.type === 'result') {
                maybeAutoCompactForXunfei(session, compactArmed);
            }
        }

        try {
            let pending: {
                message: string;
                mode: EnhancedMode;
            } | null = null;

            let previousSessionId: string | null = null;
            while (!this.exitReason) {
                logger.debug('[remote]: launch');
                messageBuffer.addMessage('═'.repeat(40), 'status');

                const isNewSession = session.sessionId !== previousSessionId;
                if (isNewSession) {
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                    permissionHandler.reset();
                    sdkToLogConverter.resetParentChain();
                    logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                } else {
                    messageBuffer.addMessage('Continuing Claude session...', 'status');
                    logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
                }

                previousSessionId = session.sessionId;
                const controller = new AbortController();
                this.abortController = controller;
                this.abortFuture = new Future<void>();
                let modeHash: string | null = null;
                let mode: EnhancedMode | null = null;
                try {
                    await claudeRemote({
                        sessionId: session.sessionId,
                        path: session.path,
                        allowedTools: session.allowedTools ?? [],
                        mcpServers: session.mcpServers,
                        hookSettingsPath: session.hookSettingsPath,
                        canCallTool: permissionHandler.handleToolCall,
                        isAborted: (toolCallId: string) => {
                            return permissionHandler.isAborted(toolCallId);
                        },
                        nextMessage: async () => {
                            // Flush any pending outgoing messages before consuming the next user
                            // turn. Without this, scheduleProcessing()'s setTimeout(fn,0) fires
                            // after the microtask that sends messages-consumed, causing the hub
                            // to stamp invokedAt on the next user message before it stores the
                            // current turn's queued agent messages — making them sort permanently
                            // below the next user message.
                            await messageQueue.flush();

                            if (pending) {
                                let p = pending;
                                pending = null;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                return p;
                            }

                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    logger.debug('[remote]: mode has changed, pending message');
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                return {
                                    message: msg.message,
                                    mode: msg.mode
                                };
                            }

                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onCompletionEvent: (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);
                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                        },
                        onReady: () => {
                            logger.debug(
                                `[claudeRemoteLauncher][async-debug] onReady callback ` +
                                `(hasPending=${Boolean(pending)}, queueSize=${session.queue.size()})`
                            );
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event sent to hub');
                            } else {
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event suppressed (pending input exists)');
                            }
                        },
                        signal: controller.signal,
                    });

                    session.consumeOneTimeFlags();

                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                } catch (e) {
                    logger.debug('[remote]: launch error', e);
                    if (!this.exitReason) {
                        const detail = e instanceof Error ? e.message : String(e);
                        session.client.sendSessionEvent({ type: 'message', message: `Process exited unexpectedly: ${detail}` });
                        continue;
                    }
                } finally {
                    logger.debug('[remote]: launch finally');

                    for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                        const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                        if (converted) {
                            logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                            session.client.sendClaudeSessionMessage(converted);
                        }
                    }
                    ongoingToolCalls.clear();

                    logger.debug('[remote]: flushing message queue');
                    await messageQueue.flush();
                    messageQueue.destroy();
                    logger.debug('[remote]: message queue flushed');

                    this.abortController = null;
                    this.abortFuture?.resolve(undefined);
                    this.abortFuture = null;
                    logger.debug('[remote]: launch done');
                    permissionHandler.reset();
                    modeHash = null;
                    mode = null;
                }
            }
        } finally {
            if (this.permissionHandler) {
                this.permissionHandler.reset();
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.handleSessionFound) {
            this.session.removeSessionFoundCallback(this.handleSessionFound);
            this.handleSessionFound = null;
        }

        if (this.permissionHandler) {
            this.permissionHandler.reset();
        }

        if (this.abortFuture) {
            this.abortFuture.resolve(undefined);
        }
    }
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudeRemoteLauncher(session);
    return launcher.launch();
}
