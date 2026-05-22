"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

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
            <Message key={message.id} role={message.role}>
              {message.parts.map((part, i) =>
                part.type === "text" ? (
                  <span key={i} className="whitespace-pre-wrap">
                    {part.text}
                  </span>
                ) : null,
              )}
            </Message>
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
    "Where's my package?",
    "Cancel my subscription",
    "I got the wrong item",
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
