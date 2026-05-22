const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export const EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_DIM = 768;

type EmbedResponse = { embeddings: number[][] };

export async function embed(input: string | string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
  });

  if (!res.ok) {
    throw new Error(
      `Ollama /api/embed failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = (await res.json()) as EmbedResponse;
  return data.embeddings;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed(text);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding has ${vec.length} dimensions, expected ${EMBEDDING_DIM}`,
    );
  }
  return vec;
}
