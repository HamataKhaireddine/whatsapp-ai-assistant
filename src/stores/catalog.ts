import { readFileSync } from "node:fs";

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  tags: string[];
  description: string;
}

export interface SearchOptions {
  query?: string;
  category?: string;
  maxPrice?: number;
  inStockOnly?: boolean;
  limit?: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "for", "my", "me", "i", "do", "you", "have", "any", "some", "is", "are", "with",
  "and", "or", "of", "to", "in", "on", "what", "show", "find", "looking", "need", "want", "please", "something",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)); // naive singular
}

/** Small in-memory catalog with keyword relevance scoring. Swap for a DB / vector search in production. */
export class Catalog {
  constructor(private readonly products: Product[]) {}

  static fromFile(path: string): Catalog {
    return new Catalog(JSON.parse(readFileSync(path, "utf8")) as Product[]);
  }

  get size(): number {
    return this.products.length;
  }

  categories(): string[] {
    return [...new Set(this.products.map((p) => p.category))].sort();
  }

  getById(id: string): Product | undefined {
    return this.products.find((p) => p.id.toLowerCase() === id.trim().toLowerCase());
  }

  search(opts: SearchOptions = {}): Product[] {
    const terms = tokenize(opts.query ?? "");
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));

    return this.products
      .filter((p) => !opts.category || p.category.toLowerCase() === opts.category.toLowerCase())
      .filter((p) => opts.maxPrice === undefined || p.price <= opts.maxPrice)
      .filter((p) => !opts.inStockOnly || p.stock > 0)
      .map((p) => ({ p, ...(terms.length === 0 ? { score: 1, coverage: 1 } : score(p, terms)) }))
      .filter((r, _, all) => r.score > 0 && r.coverage >= Math.ceil(Math.max(...all.map((x) => x.coverage)) * 0.6))
      .sort((a, b) => b.coverage - a.coverage || b.score - a.score || a.p.price - b.p.price)
      .slice(0, limit)
      .map(({ p }) => p);
  }
}

/** `coverage` = how many distinct query terms matched; `score` = weighted field matches. */
function score(p: Product, terms: string[]): { score: number; coverage: number } {
  const name = tokenize(p.name);
  const tags = p.tags.flatMap(tokenize);
  const desc = tokenize(p.description);
  const cat = tokenize(p.category);
  let s = 0;
  let coverage = 0;
  for (const t of new Set(terms)) {
    const before = s;
    if (name.includes(t)) s += 3;
    if (tags.includes(t)) s += 2;
    if (cat.includes(t)) s += 2;
    if (desc.includes(t)) s += 1;
    if (s > before) coverage++;
  }
  return { score: s, coverage };
}
