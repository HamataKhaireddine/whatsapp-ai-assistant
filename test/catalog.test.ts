import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "./helpers.js";
import { tokenize } from "../src/stores/catalog.js";

const catalog = loadCatalog();

test("seed catalog has 15 well-formed products with unique ids", () => {
  assert.equal(catalog.size, 15);
  const ids = catalog.search({ limit: 20 }).map((p) => p.id);
  assert.equal(new Set(ids).size, 15);
});

test("keyword search ranks the most relevant product first", () => {
  const [first] = catalog.search({ query: "grain free salmon dog food" });
  assert.equal(first?.id, "P001");
});

test("search prefers products matching more query terms", () => {
  const [first] = catalog.search({ query: "cat toy" });
  assert.equal(first?.id, "P009");
});

test("filters: max price, category and in-stock", () => {
  const cheap = catalog.search({ query: "food", maxPrice: 20 });
  assert.ok(cheap.length > 0);
  assert.ok(cheap.every((p) => p.price <= 20));

  const cats = catalog.search({ category: "cat", limit: 20 });
  assert.ok(cats.every((p) => p.category === "cat"));

  const inStock = catalog.search({ query: "treats", inStockOnly: true });
  assert.ok(inStock.every((p) => p.stock > 0));
  assert.ok(!inStock.some((p) => p.id === "P015"), "out-of-stock dental chews must be excluded");
});

test("no match returns an empty list", () => {
  assert.deepEqual(catalog.search({ query: "aquarium heater" }), []);
});

test("getById is case-insensitive", () => {
  assert.equal(catalog.getById("p003")?.name, "Indoor Cat Chicken Formula (4 kg)");
  assert.equal(catalog.getById("P999"), undefined);
});

test("tokenize drops stopwords and naive plurals", () => {
  assert.deepEqual(tokenize("Do you have any toys for my cats?"), ["toy", "cat"]);
});
