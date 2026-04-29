"use client";

import { useState, useRef, useEffect } from "react";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard");
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="dashboard-state">
        <div className="dashboard-spinner" />
        <p>Собираем данные из CRM…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-state">
        <div className="dashboard-error-icon">⚠️</div>
        <h3>Не удалось загрузить дашборд</h3>
        <p className="dashboard-error-msg">{error}</p>
        <button className="dashboard-retry" onClick={load}>
          Повторить
        </button>
      </div>
    );
  }

  const sprint = data?.sprint || { name: "", tasks: [] };
  const deals = data?.deals || { pipeline: "", stages: [] };

  const tasksByStatus = {};
  (sprint.tasks || []).forEach((t) => {
    const status = t.status || "Без статуса";
    if (!tasksByStatus[status]) tasksByStatus[status] = [];
    tasksByStatus[status].push(t);
  });
  const statusColumns = Object.entries(tasksByStatus);

  return (
    <div className="dashboard">
      <section className="dashboard-section">
        <div className="dashboard-section-header">
          <h2>Спринт-борд</h2>
          <span className="dashboard-section-meta">
            {sprint.name || "Активный спринт не найден"}
          </span>
        </div>
        {statusColumns.length === 0 ? (
          <div className="dashboard-empty">Задач в спринте нет</div>
        ) : (
          <div className="kanban">
            {statusColumns.map(([status, tasks]) => (
              <div key={status} className="kanban-column">
                <div className="kanban-column-header">
                  <span className="kanban-column-title">{status}</span>
                  <span className="kanban-column-count">{tasks.length}</span>
                </div>
                <div className="kanban-column-body">
                  {tasks.map((task) => (
                    <div key={task.id} className="task-card">
                      <div className="task-card-title">{task.title}</div>
                      {task.assignee && (
                        <div className="task-card-assignee">👤 {task.assignee}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="dashboard-section">
        <div className="dashboard-section-header">
          <h2>Воронка сделок</h2>
          <span className="dashboard-section-meta">
            {deals.pipeline || "Коммерция Продажи"}
          </span>
        </div>
        {(deals.stages || []).length === 0 ? (
          <div className="dashboard-empty">Сделок в воронке нет</div>
        ) : (
          <div className="kanban">
            {deals.stages.map((stage) => (
              <div key={stage.name} className="kanban-column">
                <div className="kanban-column-header">
                  <span className="kanban-column-title">{stage.name}</span>
                  <span className="kanban-column-count">
                    {(stage.deals || []).length}
                  </span>
                </div>
                <div className="kanban-column-body">
                  {(stage.deals || []).map((deal) => (
                    <div key={deal.id} className="deal-card">
                      <div className="deal-card-title">{deal.title}</div>
                      {deal.company && (
                        <div className="deal-card-company">🏢 {deal.company}</div>
                      )}
                      {deal.amount && (
                        <div className="deal-card-amount">{deal.amount}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ChatView() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      const data = await res.json();

      if (data.error) {
        setMessages([...newMessages, { role: "assistant", content: `⚠️ ${data.error}` }]);
      } else {
        setMessages([...newMessages, { role: "assistant", content: data.reply }]);
      }
    } catch (err) {
      setMessages([
        ...newMessages,
        { role: "assistant", content: `⚠️ Ошибка соединения: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    setMessages([]);
  }

  return (
    <>
      {messages.length > 0 && (
        <div className="chat-toolbar">
          <button className="clear-btn" onClick={clearChat}>
            Очистить чат
          </button>
        </div>
      )}

      <main className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-icon">🤖</div>
            <h2>Привет! Я ваш ИИ-ассистент</h2>
            <p>Я подключён к Аспро.Cloud и могу помочь с данными из CRM.</p>
            <div className="suggestions">
              {[
                "Сколько открытых сделок?",
                "Покажи задачи в работе",
                "Какие сделки закрыты за неделю?",
                "Сколько контактов в базе?",
              ].map((text) => (
                <button
                  key={text}
                  className="suggestion"
                  onClick={() => {
                    setInput(text);
                    inputRef.current?.focus();
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === "user" ? "👤" : "🤖"}
            </div>
            <div className="message-content">
              {msg.role === "assistant" ? (
                <div
                  className="message-text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
              ) : (
                <div className="message-text">{msg.content}</div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      <footer className="input-area">
        <form onSubmit={sendMessage} className="input-form">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Спросите что-нибудь о вашей CRM..."
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            ➤
          </button>
        </form>
        <div className="powered-by">
          Работает на OpenRouter + Aspro.Cloud MCP
        </div>
      </footer>
    </>
  );
}

export default function Page() {
  const [tab, setTab] = useState("dashboard");

  return (
    <div className={`app ${tab === "dashboard" ? "app--wide" : ""}`}>
      <header className="header">
        <div className="header-left">
          <img src="/logo.svg" alt="Aspro.Cloud" className="logo" />
          <div>
            <h1>Aspro.Cloud AI</h1>
            <span className="subtitle">Ассистент CRM</span>
          </div>
        </div>
        <nav className="tabs">
          <button
            className={`tab ${tab === "dashboard" ? "tab--active" : ""}`}
            onClick={() => setTab("dashboard")}
          >
            Дашборд
          </button>
          <button
            className={`tab ${tab === "chat" ? "tab--active" : ""}`}
            onClick={() => setTab("chat")}
          >
            ИИ-бот
          </button>
        </nav>
      </header>

      {tab === "dashboard" ? <Dashboard /> : <ChatView />}
    </div>
  );
}
