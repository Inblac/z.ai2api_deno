/**
 * 流式与非流式响应处理器
 */

import { config } from "./config.ts";
import {
  Message, Delta, Choice, Usage, OpenAIResponse,
  UpstreamRequest, UpstreamData, UpstreamError, ModelItem,
  UpstreamDataSchema
} from "../models/schemas.ts";
import { debugLog, callUpstreamApi, transformThinkingContent } from "../utils/helpers.ts";
import { SSEParser } from "../utils/sse_parser.ts";
import { extractToolInvocations, removeToolJsonContent } from "../utils/tools.ts";

export function createOpenAIResponseChunk(
  model: string,
  delta?: Delta,
  finishReason?: string
): OpenAIResponse {
  /**创建用于流式的 OpenAI 响应分片*/
  return {
    id: `chatcmpl-${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finishReason
    }]
  };
}

export async function* handleUpstreamError(error: UpstreamError): AsyncGenerator<string, void, unknown> {
  /**处理上游错误响应*/
  debugLog(`上游错误: code=${error.code}, detail=${error.detail}`);

  // 发送结束分片
  const endChunk = createOpenAIResponseChunk(
    config.PRIMARY_MODEL,
    undefined,
    "stop"
  );
  yield `data: ${JSON.stringify(endChunk)}\n\n`;
  yield "data: [DONE]\n\n";
}

export abstract class ResponseHandler {
  protected upstreamReq: UpstreamRequest;
  protected chatId: string;
  protected authToken: string;

  constructor(upstreamReq: UpstreamRequest, chatId: string, authToken: string) {
    this.upstreamReq = upstreamReq;
    this.chatId = chatId;
    this.authToken = authToken;
  }

  protected async _callUpstream(): Promise<Response> {
    /**调用上游 API（含错误处理）*/
    try {
      return await callUpstreamApi(this.upstreamReq, this.chatId, this.authToken);
    } catch (error) {
      debugLog(`调用上游失败: ${error}`);
      throw error;
    }
  }

  protected _handleUpstreamError(response: Response): void {
    /**处理上游错误响应*/
    debugLog(`上游返回错误状态: ${response.status}`);
    if (config.DEBUG_LOGGING) {
      response.text().then(text => {
        debugLog(`上游错误响应: ${text}`);
      });
    }
  }
}

export class StreamResponseHandler extends ResponseHandler {
  private hasTools: boolean;
  private bufferedContent: string = "";
  private toolCalls: any = null;
  private streamEnded: boolean = false; // 防止重复结束流
  // 工具调用增量状态
  private toolUsage: any = null;
  // 用于按edit_index重组工具调用内容
  private toolCallFragments: Map<number, string> = new Map();
  private toolCallFinishReceived: boolean = false;

  constructor(upstreamReq: UpstreamRequest, chatId: string, authToken: string, hasTools: boolean = false) {
    super(upstreamReq, chatId, authToken);
    this.hasTools = hasTools;
  }

  async *handle(): AsyncGenerator<string, void, unknown> {
    /**处理流式响应*/
    debugLog(`开始处理流式响应 (chat_id=${this.chatId})`);

    let response: Response;
    try {
      response = await this._callUpstream();
    } catch {
      yield "data: {\"error\": \"Failed to call upstream\"}\n\n";
      return;
    }

    if (!response.ok) {
      this._handleUpstreamError(response);
      yield "data: {\"error\": \"Upstream error\"}\n\n";
      return;
    }

    // 发送初始角色分片
    const firstChunk = createOpenAIResponseChunk(
      config.PRIMARY_MODEL,
      { role: "assistant" }
    );
    yield `data: ${JSON.stringify(firstChunk)}\n\n`;

    // 处理 SSE 流
    debugLog("开始读取上游SSE流");
    let sentInitialAnswer = false;

    const parser = new SSEParser(response, config.DEBUG_LOGGING);
    try {
      for await (const event of parser.iterJsonData()) {
        // 尝试验证Schema，如果失败则使用原始数据
        let upstreamData: UpstreamData;
        try {
          upstreamData = UpstreamDataSchema.parse(event.data);
        } catch (schemaError) {
          debugLog(`Schema验证失败，使用原始数据: ${schemaError}`);
          // 使用原始数据，添加默认字段
          upstreamData = {
            type: event.data?.type || "unknown",
            data: {
              delta_content: event.data?.data?.delta_content || "",
              edit_content: event.data?.data?.edit_content || "",
              phase: event.data?.data?.phase || "unknown",
              done: event.data?.data?.done || false,
              usage: event.data?.data?.usage,
              error: event.data?.data?.error,
              inner: event.data?.data?.inner
            },
            error: event.data?.error
          };
        }

        // 检查错误
        if (this._hasError(upstreamData)) {
          const error = this._getError(upstreamData);
          if (!this.streamEnded) {
            yield* handleUpstreamError(error);
            this.streamEnded = true;
          }
          break;
        }

        // 精简：不输出逐帧解析详情日志

        // 处理内容
        yield* this._processContent(upstreamData, sentInitialAnswer);

        // 若已结束，立即中断，避免重复结束帧与 [DONE]
        if (this.streamEnded) {
          break;
        }

        // 检查是否完成
        // 如果收到工具调用结束信号且当前不是tool_call阶段，处理工具调用
        if (this.toolCallFinishReceived &&
          upstreamData.data.phase !== "tool_call" &&
          this.hasTools &&
          this.toolCallFragments.size > 0 &&
          !this.streamEnded) {
          debugLog(`处理工具调用片段: ${this.toolCallFragments.size}`);
          yield* this._processMultipleToolCalls();
          break;
        }

        if ((upstreamData.data.done || upstreamData.data.phase === "done") && !this.streamEnded) {
          debugLog(`检测到流结束信号`);

          // 如果有工具调用片段但还没处理，先处理工具调用
          if (this.hasTools && this.toolCallFragments.size > 0) {
            // 结束前处理工具片段
            yield* this._processMultipleToolCalls();
            // _processMultipleToolCalls 内部已经设置了 streamEnded 和发送了 [DONE]
          } else {
            // 发送常规结束信号
            yield* this._sendEndChunk();
            this.streamEnded = true;
          }
          break;
        }
      }
    } catch (streamError) {
      debugLog(`流处理异常`);
      // 确保在异常情况下也能正确结束流
      if (!this.streamEnded) {
        try {
          const errorChunk = createOpenAIResponseChunk(
            config.PRIMARY_MODEL,
            undefined,
            "stop"
          );
          yield `data: ${JSON.stringify(errorChunk)}\n\n`;
          yield "data: [DONE]\n\n";
          this.streamEnded = true;
          // 异常情况下强制结束流
        } catch (endError) {
          debugLog(`结束流时发生错误`);
        }
      }
    } finally {
      parser.close();
      // 最后的保护：确保无论如何都标记为已结束
      if (!this.streamEnded) {
        this.streamEnded = true;
        // finally 标记结束
      }
    }
  }

  private _hasError(upstreamData: UpstreamData): boolean {
    /**Check if upstream data contains error*/
    return Boolean(
      upstreamData.error ||
      upstreamData.data.error ||
      (upstreamData.data.inner && upstreamData.data.inner.error)
    );
  }

  private _getError(upstreamData: UpstreamData): UpstreamError {
    /**Get error from upstream data*/
    return (
      upstreamData.error ||
      upstreamData.data.error ||
      (upstreamData.data.inner?.error || null)
    )!;
  }

  private async *_processContent(
    upstreamData: UpstreamData,
    sentInitialAnswer: boolean
  ): AsyncGenerator<string, void, unknown> {
    /**Process content from upstream data*/
    const content = upstreamData.data.delta_content || upstreamData.data.edit_content;

    // 对于tool_call阶段，即使没有delta_content也要处理edit_content
    if (!content && upstreamData.data.phase !== "tool_call") {
      debugLog(`没有内容且非tool_call阶段，跳过处理。phase=${upstreamData.data.phase}`);
      return;
    }

    if (!content && upstreamData.data.phase === "tool_call") {
      debugLog(`tool_call阶段但没有内容，检查原始数据结构: ${JSON.stringify(upstreamData.data, null, 2).substring(0, 500)}`);
    }


    // 🧩 用户逻辑：处理 phase=tool_call 或包含glm_block结束的other阶段
    if (upstreamData.data.phase === "tool_call" ) {

      const phaseInfo = upstreamData.data.phase === "tool_call" ? "tool_call阶段" : "other阶段(包含glm_block结束)";

      if (!this.hasTools) {
        this.hasTools = true;
      }

      if (upstreamData.data.edit_content) {
        const rawEditIndex = upstreamData.data.edit_index;
        const editIndex = rawEditIndex !== undefined ? rawEditIndex : 0;
        const editContent = upstreamData.data.edit_content;

        this.toolCallFragments.set(editIndex, editContent);
        debugLog(`收集工具片段 edit_index=${editIndex} 总片段数=${this.toolCallFragments.size}`);

      } else {
        // 无片段可收集
      }

      // 工具阶段不走普通内容路径
      return;
    }

    // answer 阶段：保存usage信息，检查结束信号，但继续处理内容
    if (upstreamData.data.phase === "answer") {
      // 保存usage信息
      if ((upstreamData.data as any).usage) {
        this.toolUsage = (upstreamData.data as any).usage;
      }

      // 检查是否是最终结束（finish_reason=stop）
      const finishReason = (upstreamData.data as any).choices?.[0]?.finish_reason;
      if (finishReason === "stop") {
        this.toolCallFinishReceived = true;
      }

      // 如果有finish_reason，不处理内容，否则继续处理answer阶段的正常内容
      if (finishReason) {
        return;
      } else {
        // 继续下面的内容处理逻辑
      }
    }

    // other 阶段处理 usage
    if (upstreamData.data.phase === "other" && upstreamData.data.usage) {
      this.toolUsage = upstreamData.data.usage;
      return;
    }

    // 处理思考内容
    let processedContent = content;
    if (upstreamData.data.phase === "thinking") {
      processedContent = transformThinkingContent(content);
    }

    // 如果工具启用，缓存内容（只有 answer 阶段贡献内容）
    if (this.hasTools) {
      if (upstreamData.data.phase === "answer") {
        this.bufferedContent += processedContent;
      }
    } else {
      // 处理初始 answer 内容
      if (!sentInitialAnswer &&
        upstreamData.data.edit_content &&
        upstreamData.data.phase === "answer") {

        const extractedContent = this._extractEditContent(upstreamData.data.edit_content);
        if (extractedContent) {
          const chunk = createOpenAIResponseChunk(
            config.PRIMARY_MODEL,
            { content: extractedContent }
          );
          yield `data: ${JSON.stringify(chunk)}\n\n`;
          sentInitialAnswer = true;
        }
      }

      // 处理 delta 内容
      if (upstreamData.data.delta_content) {
        if (processedContent) {
          if (upstreamData.data.phase === "thinking") {
            const chunk = createOpenAIResponseChunk(
              config.PRIMARY_MODEL,
              { reasoning_content: processedContent }
            );
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          } else if (upstreamData.data.phase === "answer") {
            const chunk = createOpenAIResponseChunk(
              config.PRIMARY_MODEL,
              { content: processedContent }
            );
            yield `data: ${JSON.stringify(chunk)}\n\n`;
          } // other阶段不返回到content（处理思考内容）
        }
      }
    }
  }

  private _extractEditContent(editContent: string): string {
    /**Extract content from edit_content field*/
    const parts = editContent.split("</details>");
    return parts.length > 1 ? parts[1] : "";
  }

  private async *_processToolCallFragments(): AsyncGenerator<string, void, unknown> {
    /**旧方法 - 请使用 _processMultipleToolCalls*/
    yield* this._processMultipleToolCalls();
  }

  private async *_processMultipleToolCalls(): AsyncGenerator<string, void, unknown> {
    /**处理工具调用分片（流式，精简日志）*/
    debugLog(`处理工具调用片段: 数量=${this.toolCallFragments.size}`);

    if (this.toolCallFragments.size === 0) {
      return;
    }

    const allIndices = Array.from(this.toolCallFragments.keys()).sort((a, b) => a - b);
    const sortedFragments = allIndices.map(index => [index, this.toolCallFragments.get(index)!] as [number, string]);
    const contentArray = sortedFragments.map(([_, content]) => content);

    // 拼接 glm_block 片段
    const tempArray: string[] = [];
    let temp_content = "";
    for (let i = 0; i < contentArray.length; i++) {
      const content = contentArray[i].trim();
      if (content.startsWith('<glm_block')) {
        if (temp_content !== "") {
          tempArray.push(temp_content);
        }
        temp_content = content;
      } else {
        if (temp_content !== "" && content.endsWith('</glm_block>')) {
          const parts = temp_content.split('", "result');
          temp_content = parts[0];
          temp_content += content;
        }
      }
    }
    if (temp_content !== "") {
      tempArray.push(temp_content);
    }
    // 最多取前2个工具调用（有可能array只有1个要素）
    const fullContent = tempArray.slice(0, 1).join("\n");

    const glmBlockRegex = /<glm_block view="">([\s\S]*?)<\/glm_block>/g;
    const toolCalls: Array<{ id: string, name: string, arguments: string }> = [];

    let match;
    while ((match = glmBlockRegex.exec(fullContent)) !== null) {
      try {
        const blockContent = match[1];
        const parsed = JSON.parse(blockContent);
        const metadata = parsed.data?.metadata || parsed.metadata || {};
        const toolId = metadata.id || `call_${Date.now()}_${toolCalls.length + 1}`;
        const toolName = metadata.name || "unknown";
        const argsStr = metadata.arguments || "{}";

        // 解析被转义或未转义的 JSON 字符串
        let finalArgs = "{}";
        try {
          if (typeof argsStr === "string" && argsStr.length > 0 && argsStr !== "{}") {
            if (argsStr.startsWith('"') && argsStr.endsWith('"')) {
              const unescapedArgsStr = JSON.parse(argsStr);
              JSON.parse(unescapedArgsStr);
              finalArgs = unescapedArgsStr;
            } else {
              JSON.parse(argsStr);
              finalArgs = argsStr;
            }
          }
        } catch {
          finalArgs = "{}";
        }

        toolCalls.push({ id: toolId, name: toolName, arguments: finalArgs });
      } catch {
        // 忽略解析失败的片段
      }
    }

    debugLog(`解析到工具调用: ${toolCalls.length} 个`);

    if (toolCalls.length === 0) {
      return;
    }

    // 发送 tool_calls 增量
    for (let i = 0; i < toolCalls.length; i++) {
      const tool = toolCalls[i];

      const initialToolCallDelta = {
        index: i,
        id: tool.id,
        type: "function" as const,
        function: {
          name: tool.name,
          arguments: ""
        }
      };
      const initialChunk = createOpenAIResponseChunk(
        config.PRIMARY_MODEL,
        { tool_calls: [initialToolCallDelta] }
      );
      yield `data: ${JSON.stringify(initialChunk)}\n\n`;

      const argsToolCallDelta = {
        index: i,
        id: tool.id,
        type: "function" as const,
        function: {
          arguments: tool.arguments
        }
      };
      const argsChunk = createOpenAIResponseChunk(
        config.PRIMARY_MODEL,
        { tool_calls: [argsToolCallDelta] }
      );
      yield `data: ${JSON.stringify(argsChunk)}\n\n`;
    }

    // 发送缓存文字（去除 glm_block）
    if (this.bufferedContent && this.bufferedContent.trim() !== "") {
      const cleanContent = this.bufferedContent.replace(/<glm_block[\s\S]*?<\/glm_block>/g, '').trim();
      if (cleanContent !== "") {
        // 提取'\n\n'分隔的第一个字符串
        const firstString = cleanContent.split('\n\n')[0];
        const contentChunk = createOpenAIResponseChunk(
          config.PRIMARY_MODEL,
          { content: firstString }
        );
        yield `data: ${JSON.stringify(contentChunk)}\n\n`;
      }
    }

    const endChunk = createOpenAIResponseChunk(
      config.PRIMARY_MODEL,
      undefined,
      "tool_calls"
    );
    const endPayload = this.toolUsage
      ? { ...endChunk, usage: this.toolUsage }
      : endChunk;
    yield `data: ${JSON.stringify(endPayload)}\n\n`;
    yield "data: [DONE]\n\n";
    this.streamEnded = true;
    debugLog(`工具调用处理完成`);
  }

  private async *_sendEndChunk(): AsyncGenerator<string, void, unknown> {
    /**发送结束分片与 DONE 信号（去重保护）*/
    if (this.streamEnded) {
      debugLog("流已结束，跳过重复的结束信号");
      return;
    }

    let finishReason = "stop";

    if (this.hasTools) {
      // 尝试从缓存内容中提取工具调用
      this.toolCalls = extractToolInvocations(this.bufferedContent);

      if (this.toolCalls) {
        // 以正确格式发送工具调用
        for (let i = 0; i < this.toolCalls.length; i++) {
          const tc = this.toolCalls[i];
          const toolCallDelta = {
            index: i,
            id: tc.id,
            type: tc.type || "function",
            function: tc.function || {},
          };

          const outChunk = createOpenAIResponseChunk(
            config.PRIMARY_MODEL,
            { tool_calls: [toolCallDelta] }
          );
          yield `data: ${JSON.stringify(outChunk)}\n\n`;
        }

        finishReason = "tool_calls";
      } else {
        // 发送普通文本内容
        const trimmedContent = removeToolJsonContent(this.bufferedContent);
        if (trimmedContent) {
          const contentChunk = createOpenAIResponseChunk(
            config.PRIMARY_MODEL,
            { content: trimmedContent }
          );
          yield `data: ${JSON.stringify(contentChunk)}\n\n`;
        }
      }
    }

    // 发送最终分片
    const endChunk = createOpenAIResponseChunk(
      config.PRIMARY_MODEL,
      undefined,
      finishReason
    );
    yield `data: ${JSON.stringify(endChunk)}\n\n`;
    yield "data: [DONE]\n\n";
    this.streamEnded = true;
    debugLog("流式响应完成");
  }
}

export class NonStreamResponseHandler extends ResponseHandler {
  private hasTools: boolean;
  // 非流式工具调用聚合状态
  private nsToolOrder: string[] = [];
  private nsToolNames: Map<string, string> = new Map();
  private nsToolArgs: Map<string, string> = new Map();
  private nsUsage: any = null;
  // 用于按edit_index重组工具调用内容
  private nsToolCallFragments: Map<number, string> = new Map();
  private nsToolCallFinishReceived: boolean = false;

  constructor(upstreamReq: UpstreamRequest, chatId: string, authToken: string, hasTools: boolean = false) {
    super(upstreamReq, chatId, authToken);
    this.hasTools = hasTools;
  }

  private _processNonStreamMultipleToolCalls(): void {
    /**非流式处理工具调用分片（精简日志）*/
    debugLog(`非流式处理工具片段: ${this.nsToolCallFragments.size}`);

    if (this.nsToolCallFragments.size === 0) {
      return;
    }

    const allIndices = Array.from(this.nsToolCallFragments.keys()).sort((a, b) => a - b);
    const sortedFragments = allIndices.map(index => [index, this.nsToolCallFragments.get(index)!] as [number, string]);
    const contentArray = sortedFragments.map(([_, content]) => content);

    const tempArray: string[] = [];
    let temp_content = "";
    for (let i = 0; i < contentArray.length; i++) {
      const content = contentArray[i].trim();
      if (content.startsWith('<glm_block')) {
        if (temp_content !== "") {
          tempArray.push(temp_content);
        }
        temp_content = content;
      } else {
        if (temp_content !== "" && content.endsWith('</glm_block>')) {
          const parts = temp_content.split('", "result');
          temp_content = parts[0];
          temp_content += content;
        }
      }
    }
    if (temp_content !== "") {
      tempArray.push(temp_content);
    }
    //最多取前2个工具调用（有可能array只有1个要素）
    const fullContent = tempArray.slice(0, 1).join("\n");

    const glmBlockRegex = /<glm_block view="">([\s\S]*?)<\/glm_block>/g;
    let match;
    while ((match = glmBlockRegex.exec(fullContent)) !== null) {
      try {
        const blockContent = match[1];
        const parsed = JSON.parse(blockContent);
        const metadata = parsed.data?.metadata || parsed.metadata || {};
        const toolId = metadata.id || `call_${Date.now()}_${this.nsToolOrder.length + 1}`;
        const toolName = metadata.name || "unknown";
        const argsStr = metadata.arguments || "{}";

        let finalArgs = "{}";
        try {
          if (typeof argsStr === "string" && argsStr.length > 0 && argsStr !== "{}") {
            if (argsStr.startsWith('"') && argsStr.endsWith('"')) {
              const unescapedArgsStr = JSON.parse(argsStr);
              JSON.parse(unescapedArgsStr);
              finalArgs = unescapedArgsStr;
            } else {
              JSON.parse(argsStr);
              finalArgs = argsStr;
            }
          }
        } catch {
          finalArgs = "{}";
        }

        if (!this.nsToolOrder.includes(toolId)) {
          this.nsToolOrder.push(toolId);
          this.nsToolNames.set(toolId, toolName);
          this.nsToolArgs.set(toolId, finalArgs);
        }
      } catch {
        // 忽略解析失败的片段
      }
    }

    debugLog(`非流式解析到工具调用: ${this.nsToolOrder.length}`);
  }

  private _processNonStreamToolCallFragments(): void {
    /**非流式处理工具调用分片*/
    debugLog(`非流式开始处理工具调用片段，总片段数: ${this.nsToolCallFragments.size}`);

    // 按edit_index顺序重组所有片段
    const sortedFragments = Array.from(this.nsToolCallFragments.entries())
      .sort(([a], [b]) => a - b);

    const contentArray = sortedFragments.map(([_, content]) => content);
    const fullContent = contentArray.join("");
    debugLog(`非流式重组完整工具调用内容，片段数: ${sortedFragments.length}, 总长度: ${fullContent.length}`);

    // 先提取工具基本信息（从第一个完整的glm_block）
    const glmBlockRegex = /<glm_block view="">([\s\S]*?)<\/glm_block>/g;
    let firstMatch = glmBlockRegex.exec(fullContent);
    let toolId = "";
    let toolName = "";

    if (firstMatch) {
      debugLog(`非流式找到第一个glm_block，内容长度: ${firstMatch[1].length}`);

      try {
        const blockContent = firstMatch[1];
        const parsed = JSON.parse(blockContent);
        const metadata = parsed.data?.metadata || parsed.metadata || {};

        toolId = metadata.id || `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        toolName = metadata.name || "unknown";

        debugLog(`非流式解析工具基本信息: id=${toolId}, name=${toolName}`);
      } catch (parseError) {
        debugLog(`非流式解析第一个glm_block失败: ${parseError}`);
        toolId = `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        toolName = "unknown";
      }
    } else {
      debugLog(`非流式没有找到glm_block！`);
      return;
    }

    // 重新提取同一工具ID的arguments片段进行拼接
    debugLog(`非流式开始提取工具ID=${toolId}的arguments片段...`);
    let allArgsFragments: string[] = [];

    // 重置正则位置
    glmBlockRegex.lastIndex = 0;
    let match;
    let blockCount = 0;

    while ((match = glmBlockRegex.exec(fullContent)) !== null) {
      blockCount++;
      try {
        const blockContent = match[1];
        const parsed = JSON.parse(blockContent);
        const metadata = parsed.data?.metadata || parsed.metadata || {};

        // 只收集相同工具ID的arguments片段
        const blockToolId = metadata.id || "";
        const argsFragment = metadata.arguments || "";

        if (blockToolId === toolId && argsFragment) {
          allArgsFragments.push(argsFragment);
          debugLog(`✅ 非流式匹配工具ID，提取第${allArgsFragments.length}个参数片段: ${argsFragment.substring(0, 100)}...`);
        } else if (blockToolId !== toolId && blockToolId) {
          debugLog(`⚠️ 非流式跳过不匹配的工具ID: ${blockToolId} (当前处理: ${toolId})`);
        } else if (argsFragment) {
          debugLog(`⚠️ 非流式工具ID为空但有arguments，可能是片段: ${argsFragment.substring(0, 50)}...`);
          // 如果工具ID为空但有arguments，可能是arguments的延续片段
          allArgsFragments.push(argsFragment);
        }
      } catch (parseError) {
        debugLog(`非流式解析第${blockCount}个glm_block失败: ${parseError}`);
      }
    }

    // 拼接所有arguments片段
    let fullArgsStr = allArgsFragments.join("");
    debugLog(`非流式拼接工具${toolId}的完整arguments: ${fullArgsStr}`);

    // 备用方案：如果没找到arguments片段，可能arguments是直接分片在JSON中的
    if (allArgsFragments.length === 0 || fullArgsStr.trim() === "") {
      debugLog(`⚠️ 非流式未找到metadata.arguments片段，尝试从JSON内容中提取arguments`);

      // 尝试从完整内容中提取arguments部分
      const argsMatch = fullContent.match(/"arguments":\s*"([^"]*(?:\\.[^"]*)*)"/);
      if (argsMatch) {
        fullArgsStr = argsMatch[1];
        debugLog(`✅ 非流式从JSON内容中提取到arguments: ${fullArgsStr}`);
      } else {
        debugLog(`❌ 非流式无法从JSON内容中提取arguments`);
      }
    }

    // 处理被转义的JSON字符串
    let finalArgs = "{}";
    try {
      if (typeof fullArgsStr === "string" && fullArgsStr.length > 0) {
        try {
          JSON.parse(fullArgsStr);
          finalArgs = fullArgsStr;
          debugLog(`非流式arguments直接解析成功: ${finalArgs}`);
        } catch {
          try {
            const unescaped = JSON.parse(`"${fullArgsStr}"`);
            JSON.parse(unescaped);
            finalArgs = unescaped;
            debugLog(`非流式arguments反转义解析成功: ${finalArgs}`);
          } catch {
            debugLog(`非流式无法解析工具参数，使用空对象: ${fullArgsStr}`);
            finalArgs = "{}";
          }
        }
      }
    } catch (parseError) {
      debugLog(`非流式工具参数解析失败: ${parseError}, 使用空对象`);
      finalArgs = "{}";
    }

    // 设置工具信息
    if (!this.nsToolOrder.includes(toolId)) {
      this.nsToolOrder.push(toolId);
      this.nsToolNames.set(toolId, toolName);
      this.nsToolArgs.set(toolId, finalArgs);
      debugLog(`非流式完成工具 ${toolId} 参数: ${finalArgs}`);
    }
  }

  async handle(): Promise<Response> {
    /**处理非流式响应*/
    debugLog(`开始处理非流式响应 (chat_id=${this.chatId})`);

    let response: Response;
    try {
      response = await this._callUpstream();
    } catch (error) {
      debugLog(`调用上游失败: ${error}`);
      return new Response(
        JSON.stringify({ error: "Failed to call upstream" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!response.ok) {
      this._handleUpstreamError(response);
      return new Response(
        JSON.stringify({ error: "Upstream error" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // 收集完整响应
    const fullContent: string[] = [];
    // 开始收集完整响应内容

    const parser = new SSEParser(response, config.DEBUG_LOGGING);
    try {
      for await (const event of parser.iterJsonData()) {
        // 尝试验证 Schema，如果失败则使用原始数据
        let upstreamData: UpstreamData;
        try {
          upstreamData = UpstreamDataSchema.parse(event.data);
        } catch (schemaError) {
          // 非流式Schema验证失败，使用原始数据
          // 使用原始数据，添加默认字段
          upstreamData = {
            type: event.data?.type || "unknown",
            data: {
              delta_content: event.data?.data?.delta_content || "",
              edit_content: event.data?.data?.edit_content || "",
              phase: event.data?.data?.phase || "unknown",
              done: event.data?.data?.done || false,
              usage: event.data?.data?.usage,
              error: event.data?.data?.error,
              inner: event.data?.data?.inner
            },
            error: event.data?.error
          };
        }

        // 🧩 用户逻辑：工具调用非流式聚合，收集tool_call或包含glm_block结束的other阶段
        if (this.hasTools &&
          (upstreamData.data.phase === "tool_call") &&
          upstreamData.data.edit_content) {
          const rawEditIndex = upstreamData.data.edit_index;
          const editIndex = rawEditIndex !== undefined ? rawEditIndex : 0;
          const editContent = upstreamData.data.edit_content;

          const phaseInfo = upstreamData.data.phase === "tool_call" ? "tool_call阶段" : "other阶段(包含glm_block结束)";
          // 记录片段索引

          // 检查edit_index是否为特殊值
          // edit_index 异常容错

          // 收集edit_content片段
          this.nsToolCallFragments.set(editIndex, editContent);
          debugLog(`非流式收集片段 index=${editIndex}`);

          // 检查关键标记
          // 关键标记检测日志移除

          // 🧩 用户逻辑：检查arguments是否被分片
          // 被截断参数检测日志移除

          continue;
        }

        // answer 阶段：保存usage信息，检查结束信号，但继续处理内容
        if (upstreamData.data.phase === "answer") {
          // 保存usage信息
          if ((upstreamData.data as any).usage) {
            this.nsUsage = (upstreamData.data as any).usage;
            // 记录usage
          }

          // 检查是否是最终结束（finish_reason=stop）
          const finishReason = (upstreamData.data as any).choices?.[0]?.finish_reason;
          if (finishReason === "stop") {
            // 结束信号
            this.nsToolCallFinishReceived = true;
          } else if (finishReason === "tool_calls") {
            // 中间工具信号
          }

          // 如果有finish_reason，不处理内容，否则继续处理answer阶段的正常内容
          if (finishReason) {
            // 跳过内容处理
            continue;
          } else {
            // 继续处理
            // 继续下面的内容处理逻辑
          }
        }

        // other 阶段处理 usage
        if (upstreamData.data.phase === "other" && upstreamData.data.usage) {
          this.nsUsage = upstreamData.data.usage;
          // 保存usage
          continue;
        }

        // 常规内容与思考
        if (upstreamData.data.delta_content) {
          let content = upstreamData.data.delta_content;
          if (upstreamData.data.phase === "thinking") {
            content = transformThinkingContent(content);
          }
          if (content) {
            fullContent.push(content);
          }
        }

        // 如果收到工具调用结束信号且当前不是tool_call阶段，处理工具调用
        if (this.nsToolCallFinishReceived &&
          upstreamData.data.phase !== "tool_call" &&
          this.hasTools &&
          this.nsToolCallFragments.size > 0) {
          debugLog(`非流式处理工具片段: ${this.nsToolCallFragments.size}`);
          this._processNonStreamMultipleToolCalls();
          // 继续收集，但标记已处理
        }

        if (upstreamData.data.done || upstreamData.data.phase === "done") {
          // 完成信号
          break;
        }
      }
    } finally {
      parser.close();
    }

    const finalContent = fullContent.join("");
    // 收集完成

    // 如果还有未处理的工具调用片段，在最终处理前处理它们
    if (this.nsToolCallFinishReceived &&
      this.hasTools &&
      this.nsToolCallFragments.size > 0 &&
      this.nsToolOrder.length === 0) {
      // 最终检查处理片段
      this._processNonStreamMultipleToolCalls();
    }

    // 非流式处理工具调用（基于 SSE 聚合而非正则）
    let toolCalls: any = null;
    let finishReason = "stop";
    
    // 📝 处理文字内容：如果有工具调用，过滤掉glm_block技术内容
    // 仅保留 answer 阶段内容：fullContent 只在 answer 阶段收集，因此这里直接使用
    let messageContent: string | null = finalContent;
    if (this.hasTools && this.nsToolOrder.length > 0) {
      // 有工具调用时，从finalContent中移除glm_block内容，只保留正常文字
      const cleanContent = finalContent.replace(/<glm_block[\s\S]*?<\/glm_block>/g, '').trim();
      messageContent = cleanContent || null;
      // 清理后的消息内容
    }
    
    if (this.hasTools && this.nsToolOrder.length > 0) {
      toolCalls = this.nsToolOrder.map((toolId, index) => {
        let args = this.nsToolArgs.get(toolId) || "{}";

        // 确保参数是有效的JSON字符串
        try {
          JSON.parse(args);
        } catch {
          // 工具参数无效，使用空对象
          args = "{}";
        }

        return {
          id: toolId,
          type: "function",
          function: {
            name: this.nsToolNames.get(toolId) || "unknown",
            arguments: args,
          },
        };
      });
      messageContent = null; // OpenAI 规范：有 tool_calls 时 message.content 必须为 null
      finishReason = "tool_calls";
      // 聚合到工具调用
    }

    // 构建响应
    const responseData: OpenAIResponse = {
      id: `chatcmpl-${Math.floor(Date.now() / 1000)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: config.PRIMARY_MODEL,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: messageContent,
          tool_calls: toolCalls
        },
        finish_reason: finishReason
      }],
      usage: this.nsUsage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    // 非流式响应发送完成
    return new Response(
      JSON.stringify(responseData),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
