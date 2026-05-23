"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";

export default function Home() {
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

  const isBusy = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
  };

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            OrderFlow Support
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Ask about orders, returns, subscriptions, and more.
          </p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          {messages.length === 0 && (
            <EmptyState onPick={(prompt) => sendMessage({ text: prompt })} />
          )}

          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}

          {status === "submitted" && (
            <Message role="assistant">
              <TypingDots />
            </Message>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
              Something went wrong. Try again.
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            className="flex-1 rounded-full border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:focus:border-zinc-50"
            autoFocus
          />
          {isBusy ? (
            <button
              type="button"
              onClick={() => stop()}
              className="rounded-full bg-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

type ToolCallPart = {
  type: "data-tool-call";
  id?: string;
  data: { name: string; input: Record<string, unknown> };
};

type ToolResultPart = {
  type: "data-tool-result";
  id?: string;
  data:
    | { ok: true; result: unknown }
    | { ok: false; error: string };
};

function MessageRow({ message }: { message: UIMessage }) {
  // Build a lookup of tool results by id so we can pair them with their
  // matching tool_call when rendering. Results may arrive after the call,
  // so the call renders in a loading state until its result lands.
  const resultsById = new Map<string, ToolResultPart["data"]>();
  for (const part of message.parts) {
    if (part.type === "data-tool-result" && "id" in part && part.id) {
      resultsById.set(part.id, (part as unknown as ToolResultPart).data);
    }
  }

  return (
    <Message role={message.role}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <span key={i} className="whitespace-pre-wrap">
              {part.text}
            </span>
          );
        }
        if (part.type === "data-tool-call") {
          const callPart = part as unknown as ToolCallPart;
          const result = callPart.id ? resultsById.get(callPart.id) : undefined;
          return (
            <ToolBadge
              key={i}
              name={callPart.data.name}
              input={callPart.data.input}
              result={result}
            />
          );
        }
        // data-tool-result is rendered as part of its matching tool_call,
        // so skip it here to avoid double rendering.
        return null;
      })}
    </Message>
  );
}

function Message({
  role,
  children,
}: {
  role: "user" | "assistant" | "system";
  children: React.ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
            : "bg-white text-zinc-900 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-zinc-800"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function ToolBadge({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown>;
  result: ToolResultPart["data"] | undefined;
}) {
  const isLoading = result === undefined;
  const isError = result && !result.ok;

  const headline = isLoading
    ? toolLoadingLabel(name, input)
    : isError
      ? `Error: ${(result as { ok: false; error: string }).error}`
      : toolSuccessLabel(name, (result as { ok: true; result: unknown }).result);

  return (
    <div
      className={`my-2 rounded-lg border px-3 py-2 text-xs ${
        isError
          ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
          : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
      }`}
    >
      <div className="flex items-center gap-2 font-mono font-medium">
        {isLoading ? <Spinner /> : isError ? <span>✗</span> : <span>✓</span>}
        <span>{name}</span>
      </div>
      <div className="ml-5 mt-1 text-zinc-600 dark:text-zinc-400">
        {headline}
      </div>
      {Object.keys(input).length > 0 && (
        <div className="ml-5 mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
          {formatInput(input)}
        </div>
      )}
    </div>
  );
}

function formatInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(" · ");
}

function toolLoadingLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_articles":
      return `Searching help center for "${input.query ?? "..."}"`;
    case "lookup_order_status":
      return `Looking up ${input.order_id ?? "order"}`;
    case "create_ticket":
      return `Creating support ticket`;
    case "escalate_to_human":
      return `Escalating to human agent`;
    default:
      return `Running ${name}`;
  }
}

function toolSuccessLabel(name: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (name) {
    case "search_articles": {
      const items = (r?.results as { slug: string }[]) ?? [];
      if (items.length === 0) return "No articles found";
      return `Found ${items.length} article${items.length > 1 ? "s" : ""}: ${items.map((i) => i.slug).join(", ")}`;
    }
    case "lookup_order_status": {
      return `${r.order_id} · ${r.status} · ${r.customer_name}`;
    }
    case "create_ticket": {
      return `${r.ticket_id} created (priority: ${r.priority})`;
    }
    case "escalate_to_human": {
      return `Escalated · ${r.reason}`;
    }
    default:
      return "Done";
  }
}

function Spinner() {
  return (
    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-700 dark:border-t-zinc-400" />
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
    </span>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const suggestions = [
    "How do I refund an order?",
    "What's the status of ORD-1002?",
    "I want to talk to a human",
    "I got the wrong item in ORD-1004",
  ];
  return (
    <div className="flex flex-col items-center gap-6 py-16 text-center">
      <div>
        <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          How can we help?
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pick a question to get started, or type your own below.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
