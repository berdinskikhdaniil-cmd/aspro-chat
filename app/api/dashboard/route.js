// app/api/dashboard/route.js
// Собирает данные для дашборда: задачи активного спринта + сделки воронки «Коммерция Продажи».
// Делает два отдельных запроса к модели (спринт и сделки), чтобы каждый ответ был короче
// и не обрезался по лимиту токенов.

import {
  initMcpSession,
  getMcpTools,
  mcpToolsToOpenAI,
  runConversation,
} from "../../lib/mcp";

export const maxDuration = 60;

const MAX_TOKENS = 16384;

const SYSTEM_BASE = `Ты — сборщик данных для дашборда CRM-системы Аспро.Cloud.
У тебя есть доступ к данным портала через MCP-инструменты.

Правила:
- Используй MCP-инструменты, чтобы получить реальные данные из CRM.
- В качестве итогового ответа верни ТОЛЬКО валидный JSON, без пояснений и без обёртки в markdown-кодблок.
- Все значения id, title, status, assignee, company, amount, name приводи к строке.
- Если поле неизвестно (например, нет компании или ответственного), используй пустую строку.
- Не придумывай данные, которых нет в CRM.`;

const SPRINT_PROMPT = `Получи список задач из текущего активного спринта. Верни JSON в формате:
{"name": "...", "tasks": [{"id": "...", "title": "...", "status": "...", "assignee": "..."}]}

Если активного спринта нет — верни {"name": "", "tasks": []}.`;

const DEALS_PROMPT = `Получи список сделок из воронки «Коммерция Продажи» и сгруппируй их по этапам. Верни JSON в формате:
{"pipeline": "Коммерция Продажи", "stages": [{"name": "...", "deals": [{"id": "...", "title": "...", "company": "...", "amount": "..."}]}]}

При запросе сделок из воронки используй параметр limit: 50 в list_records. Если записей больше — делай повторные вызовы с offset, пока не получишь все.

Верни только название сделки и этап. Не включай описания, комментарии и другие длинные поля — только id, title, stage_name, company.

Если воронка пуста — верни {"pipeline": "Коммерция Продажи", "stages": []}.`;

// Восстанавливает обрезанный JSON: закрывает незакрытую строку и докидывает
// недостающие } / ] в правильном порядке, опираясь на стек открывающих скобок.
function repairJson(text) {
  const stack = [];
  let inStr = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr && c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }

  let repaired = text;
  if (inStr) repaired += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  // Удаляем висячие запятые перед закрывающими скобками.
  repaired = repaired.replace(/,(\s*[\]}])/g, "$1");
  return repaired;
}

function extractJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Пустой ответ модели");
  }

  let candidate = text.trim();

  // Снимаем markdown-обёртку ```json ... ``` (в т.ч. без закрывающих ``` если ответ обрезан).
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) {
    candidate = fenced[1].trim();
  } else {
    candidate = candidate
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
  }

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new Error(`В ответе модели не найден JSON: ${text.slice(0, 300)}`);
  }
  const lastClose = candidate.lastIndexOf("}");

  // 1. Чистый слайс до последней } — для well-formed ответа с шумом по краям.
  if (lastClose > start) {
    try {
      return JSON.parse(candidate.slice(start, lastClose + 1));
    } catch {}
  }

  // 2. Чиним хвост целиком: если ответ обрезан посреди записи, не теряем её.
  const tail = candidate.slice(start);
  try {
    return JSON.parse(repairJson(tail));
  } catch (e) {
    throw new Error(
      `Не удалось распарсить JSON (${e.message}). Начало ответа: ${text.slice(0, 400)}`
    );
  }
}

async function fetchSection({ sessionId, tools, userPrompt }) {
  const reply = await runConversation({
    sessionId,
    messages: [
      { role: "system", content: SYSTEM_BASE },
      { role: "user", content: userPrompt },
    ],
    tools,
    maxRounds: 12,
    maxTokens: MAX_TOKENS,
  });
  return extractJson(reply);
}

export async function POST() {
  return GET();
}

export async function GET() {
  try {
    const sessionId = await initMcpSession();
    const mcpTools = await getMcpTools(sessionId);
    const tools = mcpToolsToOpenAI(mcpTools);

    let sprint;
    try {
      sprint = await fetchSection({
        sessionId,
        tools,
        userPrompt: SPRINT_PROMPT,
      });
    } catch (e) {
      console.error("Dashboard sprint error:", e.message);
      return Response.json(
        { error: `Не удалось получить спринт: ${e.message}` },
        { status: 502 }
      );
    }

    let deals;
    try {
      deals = await fetchSection({
        sessionId,
        tools,
        userPrompt: DEALS_PROMPT,
      });
    } catch (e) {
      console.error("Dashboard deals error:", e.message);
      return Response.json(
        { error: `Не удалось получить сделки: ${e.message}` },
        { status: 502 }
      );
    }

    return Response.json({ sprint, deals });
  } catch (error) {
    console.error("Dashboard error:", error);
    return Response.json(
      { error: `Ошибка: ${error.message}` },
      { status: 500 }
    );
  }
}
