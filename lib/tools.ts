import { promises as fs } from "node:fs";
import { join } from "node:path";
import { findRelevantChunks } from "./retrieval";

// ───── Generic tool definition (provider-agnostic) ─────
//
// Each provider adapter translates this into its native format at the boundary.
// JSON Schema is the same across Anthropic / OpenAI / Ollama — only the
// wrapper field name differs (`input_schema` vs `parameters`).

type JSONSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  enum?: readonly string[];
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required: string[];
};

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export type Tool = {
  name: string;
  description: string;
  input_schema: ToolSchema;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
};

// ───── Data file helpers ─────

const DATA_DIR = join(process.cwd(), "data");
const ORDERS_PATH = join(DATA_DIR, "orders.json");
const TICKETS_PATH = join(DATA_DIR, "tickets.json");

type Order = {
  order_id: string;
  status: string;
  customer_name: string;
  customer_email: string;
  placed_at: string;
  shipped_at?: string;
  delivered_at?: string;
  refunded_at?: string;
  items: { name: string; qty: number; price: number }[];
  subtotal: number;
  shipping: number;
  total: number;
  refund_amount?: number;
  shipping_address: string;
  carrier: string | null;
  tracking_number: string | null;
  notes?: string;
};

type Ticket = {
  ticket_id: string;
  subject: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  created_at: string;
};

async function loadOrders(): Promise<Order[]> {
  const raw = await fs.readFile(ORDERS_PATH, "utf-8");
  return JSON.parse(raw) as Order[];
}

async function loadTickets(): Promise<Ticket[]> {
  try {
    const raw = await fs.readFile(TICKETS_PATH, "utf-8");
    return JSON.parse(raw) as Ticket[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function saveTickets(tickets: Ticket[]): Promise<void> {
  await fs.writeFile(TICKETS_PATH, JSON.stringify(tickets, null, 2));
}

// ───── The four tools ─────

const searchArticles: Tool = {
  name: "search_articles",
  description: `Search the help-center knowledge base for articles relevant to the user's question. Use this when the user asks how to do something, what our policies are, or general "how does X work?" questions.

DO NOT use this when:
- The user asks about a specific order they placed → use lookup_order_status
- The user explicitly asks to speak with a human → use escalate_to_human
- The user wants you to take an action that needs human follow-up → use create_ticket

Example queries that should trigger this tool:
- "How do I cancel my subscription?"
- "What's your return policy?"
- "Do you ship internationally?"
- "What payment methods do you accept?"`,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The user's question or topic, in natural language. Pass roughly what the user asked.",
      },
    },
    required: ["query"],
  },
  execute: async ({ query }) => {
    if (typeof query !== "string" || query.trim() === "") {
      return { ok: false, error: "query must be a non-empty string" };
    }
    const chunks = await findRelevantChunks(query, 3);
    return {
      ok: true,
      data: {
        results: chunks.map((c) => ({
          slug: c.slug,
          title: c.title,
          distance: Number(c.distance.toFixed(3)),
          content: c.content,
        })),
      },
    };
  },
};

const lookupOrderStatus: Tool = {
  name: "lookup_order_status",
  description: `Look up the status and details of a specific order placed by the customer. Use this whenever the user asks about a particular order — typically when they mention an order ID (like "ORD-1234") or ask "where is my order?" / "what's the status of my package?".

If the user asks about their order but does NOT provide an order ID, ask them for it before calling this tool. Do not guess.

Returns full order details including status, items, shipping address, tracking number, and any notes.`,
  input_schema: {
    type: "object",
    properties: {
      order_id: {
        type: "string",
        description:
          'The order ID, e.g. "ORD-1003". Format is uppercase "ORD-" prefix followed by digits.',
      },
    },
    required: ["order_id"],
  },
  execute: async ({ order_id }) => {
    if (typeof order_id !== "string" || !order_id.trim()) {
      return { ok: false, error: "order_id must be a non-empty string" };
    }
    const orders = await loadOrders();
    const match = orders.find((o) => o.order_id === order_id);
    if (!match) {
      return {
        ok: false,
        error: `No order found with id "${order_id}". Ask the user to double-check the ID.`,
      };
    }
    return { ok: true, data: match };
  },
};

const createTicket: Tool = {
  name: "create_ticket",
  description: `Create a support ticket when an issue needs human follow-up — for example: damage claims, refund requests for specific orders, billing disputes, complaints, or anything you can't fully resolve from help articles alone. Returns a ticket ID the customer should reference in future contact.

IMPORTANT: If the issue concerns a specific order (the user mentions an order ID like "ORD-1234" or refers to a purchase), you MUST call lookup_order_status FIRST before creating the ticket. The ticket description should include the verified order details (customer name, items, status, dates) from the lookup. Do NOT create order-related tickets based only on what the user said — verify first, then ticket.

When the user has clearly described a concrete order problem (damaged item, wrong item, missing item, "I want a refund for X", etc.) and the order ID is verified, OPEN THE TICKET. Do not ask the user for additional clarification first — the human agent who picks up the ticket can ask follow-ups. Asking the user to repeat information they've already provided is bad customer service.

Damage and "wrong item" reports should always be priority "high" because they involve product replacement or refund processing.

Priority guidance:
- "low": general questions, minor inconveniences, things that can wait a few days
- "normal": standard issues, most refunds and returns (default if unsure)
- "high": damaged items, wrong items shipped, orders that didn't arrive, payment problems
- "urgent": safety concerns, fraud, account compromise, repeated failed resolution attempts

DO NOT use this when:
- The question can be answered from a help article → use search_articles
- The user just wants information about their order → use lookup_order_status`,
  input_schema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description:
          "A short, descriptive title for the ticket (under ~80 chars). E.g. 'Refund request for ORD-1004 (chipped mug)'.",
      },
      description: {
        type: "string",
        description:
          "A detailed description of the issue. Include any relevant order ID, dates, what the user wants done, and any context from the conversation that the human agent will need.",
      },
      priority: {
        type: "string",
        description:
          "One of: low, normal, high, urgent. See tool description for guidance on each.",
        enum: ["low", "normal", "high", "urgent"],
      },
    },
    required: ["subject", "description", "priority"],
  },
  execute: async ({ subject, description, priority }) => {
    if (typeof subject !== "string" || !subject.trim()) {
      return { ok: false, error: "subject must be a non-empty string" };
    }
    if (typeof description !== "string" || !description.trim()) {
      return { ok: false, error: "description must be a non-empty string" };
    }
    const validPriorities = ["low", "normal", "high", "urgent"] as const;
    if (
      typeof priority !== "string" ||
      !(validPriorities as readonly string[]).includes(priority)
    ) {
      return {
        ok: false,
        error: `priority must be one of: ${validPriorities.join(", ")}`,
      };
    }

    const tickets = await loadTickets();
    const maxNum = tickets.reduce((max, t) => {
      const n = parseInt(t.ticket_id.replace(/^TKT-/, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);

    const ticket: Ticket = {
      ticket_id: `TKT-${String(maxNum + 1).padStart(4, "0")}`,
      subject,
      description,
      priority: priority as Ticket["priority"],
      created_at: new Date().toISOString(),
    };

    await saveTickets([...tickets, ticket]);
    return { ok: true, data: ticket };
  },
};

const escalateToHuman: Tool = {
  name: "escalate_to_human",
  description: `Hand off the conversation to a human agent immediately. Use this ONLY when:
- The user explicitly asks to speak with a person ("can I talk to a human?", "I want a real agent")
- The situation involves something sensitive that shouldn't be handled by AI (fraud reports, legal matters, accessibility issues)
- You've tried to help and the user is still frustrated or stuck after 2+ turns

DO NOT use this casually. For issues that need a paper trail or follow-up by a human, use create_ticket instead — that's the normal path. Escalation interrupts the user's flow and should be reserved for the cases above.`,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "A one-sentence reason for the escalation. E.g. 'Customer requested human agent'; 'Suspected fraudulent charge — beyond AI scope'.",
      },
    },
    required: ["reason"],
  },
  execute: async ({ reason }) => {
    if (typeof reason !== "string" || !reason.trim()) {
      return { ok: false, error: "reason must be a non-empty string" };
    }
    return {
      ok: true,
      data: {
        escalated: true,
        reason,
        message:
          "A human agent will reach out shortly. Please reference this conversation when they contact you.",
      },
    };
  },
};

// ───── Public registry ─────

export const TOOLS: Tool[] = [
  searchArticles,
  lookupOrderStatus,
  createTicket,
  escalateToHuman,
];

export const TOOLS_BY_NAME: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
