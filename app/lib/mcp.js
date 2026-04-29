// app/lib/mcp.js
// Общие хелперы для работы с Aspro.Cloud MCP и OpenRouter.
// Используются и чатом, и дашбордом.

let cachedTools = null;
let cachedToolsTime = 0;
const TOOLS_CACHE_TTL = 5 * 60 * 1000;

export async function mcpRequest(method, params = {}, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-account-code": process.env.ASPRO_ACCOUNT_CODE,
    Authorization: `Bearer ${process.env.ASPRO_API_KEY}`,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const res = await fetch(process.env.ASPRO_MCP_URL || "https://mcp.aspro.cloud/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP ${method} failed (${res.status}): ${text}`);
  }

  const newSessionId = res.headers.get("mcp-session-id") || sessionId;
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  let data;
  if (contentType.includes("text/event-stream")) {
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      throw new Error(`MCP ${method} returned SSE without data: ${raw}`);
    }
    data = JSON.parse(dataLine.slice(5).trim());
  } else {
    data = JSON.parse(raw);
  }

  return { data, sessionId: newSessionId };
}

export async function initMcpSession() {
  const { sessionId } = await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "aspro-chat", version: "1.0.0" },
  });

  await mcpRequest("notifications/initialized", {}, sessionId);

  return sessionId;
}

export async function getMcpTools(sessionId) {
  if (cachedTools && Date.now() - cachedToolsTime < TOOLS_CACHE_TTL) {
    return cachedTools;
  }

  const { data } = await mcpRequest("tools/list", {}, sessionId);

  if (data.result && data.result.tools) {
    cachedTools = data.result.tools;
    cachedToolsTime = Date.now();

    const cr = data.result.tools.find((t) => t.name === "create_record");
    if (cr) {
      console.log("[DIAG] create_record schema:", JSON.stringify(cr.inputSchema, null, 2));
    }
    const ur = data.result.tools.find((t) => t.name === "update_record");
    if (ur) {
      console.log("[DIAG] update_record schema:", JSON.stringify(ur.inputSchema, null, 2));
    }

    return cachedTools;
  }

  return [];
}

export async function callMcpTool(sessionId, toolName, args) {
  if (
    (toolName === "create_record" || toolName === "update_record") &&
    args &&
    typeof args === "object" &&
    !args.data
  ) {
    const { module, entity, id, preview, confirm, ...rest } = args;
    if (Object.keys(rest).length > 0) {
      const wrapped = { data: rest };
      if (module !== undefined) wrapped.module = module;
      if (entity !== undefined) wrapped.entity = entity;
      if (id !== undefined) wrapped.id = id;
      if (preview !== undefined) wrapped.preview = preview;
      if (confirm !== undefined) wrapped.confirm = confirm;
      console.log("[FIX] Rewrapped flat args into data:", JSON.stringify(wrapped));
      args = wrapped;
    }
  }

  if (
    (toolName === "create_record" || toolName === "update_record") &&
    (!args ||
      typeof args !== "object" ||
      !args.data ||
      typeof args.data !== "object" ||
      Object.keys(args.data).length === 0)
  ) {
    console.log(`[FIX] ${toolName} called without data, returning hint to model`);
    return (
      `Ошибка: ${toolName} вызван без данных. Передай поля записи (name, budget, pipeline_id и т.д.) ` +
      `внутри объекта "data". Пример: {"module":"crm","entity":"lead","data":{"name":"Тест","budget":100000}}. ` +
      `Используй describe_entity, чтобы узнать точные имена полей нужной сущности, и повтори вызов с заполненным "data".`
    );
  }

  if (toolName === "create_record" || toolName === "update_record") {
    console.log(`[DIAG] ${toolName} ARGS:`, JSON.stringify(args, null, 2));
  }

  const { data } = await mcpRequest(
    "tools/call",
    { name: toolName, arguments: args },
    sessionId
  );

  if (toolName === "create_record" || toolName === "update_record") {
    console.log(
      `[DIAG] ${toolName} RESPONSE:`,
      JSON.stringify(data, null, 2).slice(0, 3000)
    );
  }

  if (data.error) {
    return `Ошибка: ${data.error.message || JSON.stringify(data.error)}`;
  }

  if (data.result && data.result.content) {
    return data.result.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }

  return JSON.stringify(data.result || data);
}

const CREATE_RECORD_HINT = `

ОБЯЗАТЕЛЬНО: передавай данные записи в поле "data". Пример вызова для создания сделки:
{
  "module": "crm",
  "entity": "lead",
  "data": {
    "name": "Название сделки",
    "budget": 250000,
    "pipeline_id": 5,
    "pipeline_stage_id": 75,
    "assignee_id": 390289
  }
}
Без поля "data" запись НЕ создастся. Сначала вызови describe_entity, чтобы узнать точные имена полей, потом передай их внутри "data".
НЕ передавай поля записи (name, budget, pipeline_id и т.п.) на верхнем уровне аргументов — только внутри "data".
Если получил ошибку — прочитай её, исправь поля и попробуй ещё раз, не сдавайся после первой попытки.`;

const UPDATE_RECORD_HINT = `

ОБЯЗАТЕЛЬНО: передавай "id" записи и обновляемые поля в "data". Пример вызова:
{
  "module": "crm",
  "entity": "lead",
  "id": 12345,
  "data": {
    "name": "Новое название",
    "budget": 300000
  }
}
Без поля "data" обновление НЕ применится. Используй describe_entity, чтобы свериться с именами полей.
НЕ передавай обновляемые поля на верхнем уровне аргументов — только внутри "data".
Если получил ошибку — прочитай её, исправь поля и попробуй ещё раз, не сдавайся после первой попытки.`;

export function mcpToolsToOpenAI(mcpTools) {
  return mcpTools.map((tool) => {
    let description = tool.description || "";
    if (tool.name === "create_record") {
      description += CREATE_RECORD_HINT;
    } else if (tool.name === "update_record") {
      description += UPDATE_RECORD_HINT;
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description,
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    };
  });
}

export async function callOpenRouter(messages, tools, options = {}) {
  const body = {
    model: process.env.AI_MODEL || "anthropic/claude-sonnet-4",
    messages,
    max_tokens: options.maxTokens || 4096,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_BASE_URL || "https://localhost:3000",
      "X-Title": "Aspro.Cloud AI Assistant",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${text}`);
  }

  return res.json();
}

// Прогоняет диалог в OpenRouter, обрабатывая tool calls через MCP.
// customTools — карта { name: async (args) => string } для не-MCP инструментов:
// если имя совпадает, вызывается локальный обработчик вместо MCP.
// Возвращает финальный текст ассистента.
export async function runConversation({
  sessionId,
  messages,
  tools,
  maxRounds = 10,
  customTools = {},
  maxTokens,
}) {
  const conversationMessages = [...messages];
  const orOptions = maxTokens ? { maxTokens } : {};

  let response = await callOpenRouter(conversationMessages, tools, orOptions);
  let assistantMessage = response.choices?.[0]?.message;
  let rounds = 0;

  while (assistantMessage?.tool_calls && rounds < maxRounds) {
    rounds++;

    conversationMessages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const fn = toolCall.function;
      let args = {};
      try {
        args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
      } catch {
        args = {};
      }

      console.log(`[TOOL] ${fn.name}(${JSON.stringify(args).slice(0, 200)})`);

      let toolResult;
      try {
        if (customTools[fn.name]) {
          toolResult = await customTools[fn.name](args);
        } else {
          toolResult = await callMcpTool(sessionId, fn.name, args);
        }
      } catch (e) {
        toolResult = `Ошибка при вызове ${fn.name}: ${e.message}`;
      }

      conversationMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
      });
    }

    response = await callOpenRouter(conversationMessages, tools, orOptions);
    assistantMessage = response.choices?.[0]?.message;
  }

  return assistantMessage?.content || "";
}
