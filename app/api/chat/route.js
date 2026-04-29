// app/api/chat/route.js
// Обрабатывает сообщения: подключается к Aspro.Cloud MCP, отправляет в OpenRouter

import {
  initMcpSession,
  getMcpTools,
  mcpToolsToOpenAI,
  callOpenRouter,
  callMcpTool,
  runConversation,
} from "../../lib/mcp";

export const maxDuration = 60;

const FETCH_HELP_TOOL = {
  type: "function",
  function: {
    name: "fetch_aspro_help",
    description:
      "Получить содержимое страницы из документации Аспро.Cloud по URL. Используй для ответов на вопросы о функциях, настройке и работе с CRM Аспро.Cloud. Базовый URL: https://aspro.cloud/help/",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Полный URL страницы документации, например https://aspro.cloud/help/articles/3281--zadachi/",
        },
      },
      required: ["url"],
    },
  },
};

const CREATE_RECORD_TOOL = {
  type: "function",
  function: {
    name: "create_crm_record",
    description:
      "Создать новую запись в CRM Аспро.Cloud (сделку, контакт и т.д.). " +
      "Перед вызовом используй describe_entity чтобы узнать точные имена полей. " +
      "Передавай поля записи напрямую как параметры этого инструмента.",
    parameters: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description: "Имя модуля, например 'crm'",
        },
        entity: {
          type: "string",
          description:
            "Имя сущности, например 'lead' для сделок, 'contact' для контактов",
        },
        name: {
          type: "string",
          description: "Название записи",
        },
        budget: {
          type: "number",
          description: "Бюджет (для сделок)",
        },
        pipeline_id: {
          type: "number",
          description: "ID воронки",
        },
        pipeline_stage_id: {
          type: "number",
          description: "ID этапа воронки",
        },
        assignee_id: {
          type: "number",
          description: "ID ответственного сотрудника",
        },
      },
      required: ["module", "entity", "name"],
      additionalProperties: true,
    },
  },
};

const UPDATE_RECORD_TOOL = {
  type: "function",
  function: {
    name: "update_crm_record",
    description:
      "Обновить существующую запись в CRM Аспро.Cloud. " +
      "Передавай ID записи и поля для обновления напрямую как параметры.",
    parameters: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description: "Имя модуля, например 'crm'",
        },
        entity: {
          type: "string",
          description: "Имя сущности, например 'lead'",
        },
        id: {
          type: "number",
          description: "ID записи для обновления",
        },
      },
      required: ["module", "entity", "id"],
      additionalProperties: true,
    },
  },
};

async function createCrmRecord(args, sessionId) {
  const { module, entity, ...fields } = args;

  if (!module || !entity) {
    return "Ошибка: укажи module и entity. Например module='crm', entity='lead'";
  }

  if (Object.keys(fields).length === 0) {
    return "Ошибка: не переданы поля записи. Передай хотя бы name. Используй describe_entity чтобы узнать доступные поля.";
  }

  console.log(
    `[CREATE] module=${module}, entity=${entity}, data=${JSON.stringify(fields)}`
  );

  const result = await callMcpTool(sessionId, "create_record", {
    module,
    entity,
    data: fields,
    confirm: true,
  });

  console.log(`[CREATE] result: ${result.slice(0, 500)}`);
  return result;
}

async function updateCrmRecord(args, sessionId) {
  const { module, entity, id, ...fields } = args;

  if (!module || !entity || !id) {
    return "Ошибка: укажи module, entity и id записи для обновления.";
  }

  if (Object.keys(fields).length === 0) {
    return "Ошибка: не переданы поля для обновления. Используй describe_entity чтобы узнать доступные поля.";
  }

  console.log(
    `[UPDATE] module=${module}, entity=${entity}, id=${id}, data=${JSON.stringify(fields)}`
  );

  const result = await callMcpTool(sessionId, "update_record", {
    module,
    entity,
    id,
    data: fields,
    confirm: true,
  });

  console.log(`[UPDATE] result: ${result.slice(0, 500)}`);
  return result;
}

function htmlToText(html, baseUrl) {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
      const m = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = m ? (m[1] ?? m[2] ?? m[3]) : "";
      if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) {
        return inner;
      }
      let url = href;
      if (baseUrl) {
        try { url = new URL(href, baseUrl).toString(); } catch {}
      }
      return `${inner} [${url}]`;
    })
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&[a-z0-9#]+;/gi, " ");

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

async function fetchAsproHelp({ url }) {
  if (!url || typeof url !== "string") {
    return "Ошибка: не указан url";
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `Ошибка: некорректный URL: ${url}`;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Ошибка: разрешены только http(s) URL";
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "aspro.cloud" && host !== "www.aspro.cloud") {
    return `Ошибка: разрешён только домен aspro.cloud, получен: ${host}`;
  }

  let res;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "aspro-chat/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
  } catch (e) {
    return `Ошибка при загрузке ${parsed.toString()}: ${e.message}`;
  }

  if (!res.ok) {
    return `Не удалось загрузить ${parsed.toString()}: HTTP ${res.status}`;
  }

  const html = await res.text();
  const text = htmlToText(html, parsed.toString());
  return text.slice(0, 8000);
}

export async function POST(req) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return Response.json({ error: "messages array required" }, { status: 400 });
    }

    let sessionId;
    try {
      sessionId = await initMcpSession();
    } catch (e) {
      console.error("MCP init error:", e.message);
      const result = await callOpenRouter(messages, [FETCH_HELP_TOOL]);
      const text =
        result.choices?.[0]?.message?.content ||
        "Не удалось подключиться к Aspro.Cloud. Проверьте настройки.";
      return Response.json({ reply: text });
    }

    const mcpTools = await getMcpTools(sessionId);

    const filteredMcpTools = mcpTools.filter(
      (t) => t.name !== "create_record" && t.name !== "update_record"
    );

    const tools = [
      ...mcpToolsToOpenAI(filteredMcpTools),
      CREATE_RECORD_TOOL,
      UPDATE_RECORD_TOOL,
      FETCH_HELP_TOOL,
    ];

    const systemMessage = {
      role: "system",
      content: `Ты — эксперт-консультант по CRM-системе Аспро.Cloud. Ты отлично знаешь продукт и помогаешь пользователям решать их бизнес-задачи.

ВАЖНО — как думать:
1. Сначала пойми БИЗНЕС-ЗАДАЧУ пользователя, а не его буквальные слова. Если он говорит "тайные агенты" — он имеет в виду доступ для внешних людей. Если говорит "следить за сделкой" — он хочет дать клиенту видимость процесса.
2. Подбери подходящий модуль/функцию Аспро.Cloud. Вот ключевые возможности системы:
   - Кабинет клиента — доступ для внешних пользователей (клиентов, подрядчиков) к сделкам, проектам, задачам, счетам
   - CRM (сделки, воронки, контрагенты) — управление продажами
   - Проекты — управление реализацией, этапы, вехи
   - Agile — спринты, бэклог, скрам-доски
   - Задачи — рабочие процессы, статусы, ответственные
   - Финансы — счета, акты, платежи
   - Коммуникации — мессенджер, чаты с клиентами
   - Бизнес-процессы — автоматизация действий
   - База знаний — внутренняя документация
   - Тайм-трекер — учёт времени
   - Документы — шаблоны, генерация документов
3. Дай конкретный ответ с пошаговой инструкцией.
4. Подтверди ответ источником — загрузи статью из документации.

У тебя есть доступ к:
- Данным CRM через MCP-инструменты (сделки, задачи, проекты и т.д.)
- Документации Аспро.Cloud через инструмент fetch_aspro_help

Работа с записями CRM:
- Для создания записей используй инструмент create_crm_record. Передавай поля записи напрямую как параметры: name, budget, pipeline_id, pipeline_stage_id, assignee_id и т.д. НЕ оборачивай их в объект data — инструмент сделает это сам.
- Для обновления используй update_crm_record: передавай id записи и поля для изменения напрямую как параметры.
- Перед созданием/обновлением ВСЕГДА вызови describe_entity для нужного module/entity, чтобы узнать точные имена полей.
- Если получил ошибку — прочитай её, исправь поля и попробуй снова. Не сдавайся после первой неудачи и не говори пользователю «не могу», пока реально не исчерпал попытки исправления.

Всегда отвечай на русском. Будь конкретным и практичным — как опытный внедренец CRM.`,
    };

    const reply = await runConversation({
      sessionId,
      messages: [systemMessage, ...messages],
      tools,
      customTools: {
        fetch_aspro_help: fetchAsproHelp,
        create_crm_record: (args) => createCrmRecord(args, sessionId),
        update_crm_record: (args) => updateCrmRecord(args, sessionId),
      },
    });

    return Response.json({ reply: reply || "Нет ответа от модели." });
  } catch (error) {
    console.error("Chat error:", error);
    return Response.json(
      { error: `Ошибка: ${error.message}` },
      { status: 500 }
    );
  }
}
