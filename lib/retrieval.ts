import { db } from "./db";
import { embedOne } from "./embeddings";

export type RetrievedChunk = {
  slug: string;
  title: string;
  content: string;
  distance: number; // cosine distance, 0 = identical, ~1 = unrelated
};

// Find the top-k chunks most similar to `query`.
// Uses pgvector's <=> operator (cosine distance) on the ivfflat index.
export async function findRelevantChunks(
  query: string,
  k: number = 3,
): Promise<RetrievedChunk[]> {
  const vec = await embedOne(query);
  const vecLiteral = `[${vec.join(",")}]`;

  const { rows } = await db.query<{
    article_slug: string;
    article_title: string;
    content: string;
    distance: string; // pg returns NUMERIC as string to preserve precision
  }>(
    `SELECT article_slug,
            article_title,
            content,
            (embedding <=> $1::vector) AS distance
       FROM chunks
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
    [vecLiteral, k],
  );

  return rows.map((r) => ({
    slug: r.article_slug,
    title: r.article_title,
    content: r.content,
    distance: Number(r.distance),
  }));
}
