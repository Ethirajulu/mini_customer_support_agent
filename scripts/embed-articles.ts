import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { embed, EMBEDDING_DIM } from "@/lib/embeddings";

const ARTICLES_DIR = join(process.cwd(), "content", "help-articles");

type Article = {
  slug: string;
  title: string;
  content: string;
};

// Tiny frontmatter parser. Our YAML is simple (key: value lines only) so we
// avoid an extra dependency. Returns the parsed title and the body without
// the --- block. If anything looks weird, falls back to the raw text.
function parseFrontmatter(raw: string): { title: string | null; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { title: null, body: raw };
  const titleLine = match[1].match(/^title:\s*(.+?)\s*$/m);
  return {
    title: titleLine?.[1].replace(/^["']|["']$/g, "") ?? null,
    body: match[2].trim(),
  };
}

async function loadArticles(): Promise<Article[]> {
  const files = await readdir(ARTICLES_DIR);
  const mds = files.filter((f) => f.endsWith(".md")).sort();

  return Promise.all(
    mds.map(async (file) => {
      const raw = await readFile(join(ARTICLES_DIR, file), "utf-8");
      const { title, body } = parseFrontmatter(raw);
      const slug = file.replace(/\.md$/, "");
      return { slug, title: title ?? slug, content: body };
    }),
  );
}

// What we feed the embedding model. See Decision 1 in the docs.
function toEmbedText(a: Article): string {
  return `${a.title}\n\n${a.content}`;
}

// pgvector accepts the literal "[0.1,0.2,...]" string form. The pg driver
// doesn't know about vectors natively, so we serialize manually.
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

async function main() {
  console.log(`Reading articles from ${ARTICLES_DIR}`);
  const articles = await loadArticles();
  console.log(`  found ${articles.length} articles\n`);

  console.log(`Embedding ${articles.length} articles via nomic-embed-text...`);
  const texts = articles.map(toEmbedText);
  const t0 = Date.now();
  const vectors = await embed(texts);
  const ms = Date.now() - t0;
  console.log(
    `  done in ${ms}ms (avg ${Math.round(ms / articles.length)}ms/article)\n`,
  );

  if (vectors.length !== articles.length) {
    throw new Error(
      `Embedding count mismatch: got ${vectors.length}, expected ${articles.length}`,
    );
  }

  console.log("Writing to Postgres...");
  const client = await db.connect();
  try {
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const v = vectors[i];
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(
          `${a.slug}: embedding has ${v.length} dims, expected ${EMBEDDING_DIM}`,
        );
      }

      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM chunks WHERE article_slug = $1", [
          a.slug,
        ]);
        await client.query(
          `INSERT INTO chunks
             (article_slug, article_title, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5)`,
          [a.slug, a.title, 0, a.content, toVectorLiteral(v)],
        );
        await client.query("COMMIT");
        console.log(`  ✓ ${a.slug}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    // Prune chunks whose source markdown was deleted on disk.
    const slugs = articles.map((a) => a.slug);
    const pruned = await client.query(
      "DELETE FROM chunks WHERE article_slug <> ALL($1::text[])",
      [slugs],
    );
    if (pruned.rowCount && pruned.rowCount > 0) {
      console.log(`\nPruned ${pruned.rowCount} orphaned chunks`);
    }
  } finally {
    client.release();
  }

  const { rows } = await db.query<{ count: string }>(
    "SELECT COUNT(*)::text FROM chunks",
  );
  console.log(`\nDone. ${rows[0].count} chunks in DB.`);

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
