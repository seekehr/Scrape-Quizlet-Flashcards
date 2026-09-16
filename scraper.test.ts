import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  extractFlashcardSet,
  folderLinksFromAnchors,
  formatFlashcards,
  safeFileName,
  setLinksFromAnchors,
} from "./scraper.js";

test("discovers and deduplicates Quizlet folder links", () => {
  const links = folderLinksFromAnchors(
    [
      { href: "/user/example/folders/biology?i=abc", text: " Biology " },
      { href: "https://quizlet.com/user/example/folders/biology", text: "Duplicate" },
      { href: "/user/example/sets", text: "Not a folder" },
      { href: "https://example.com/user/example/folders/nope", text: "External" },
    ],
    "https://quizlet.com/user/example/folders",
  );

  assert.deepEqual(links, [
    {
      name: "Duplicate",
      url: "https://quizlet.com/user/example/folders/biology",
    },
  ]);
});

test("discovers localized set links and deduplicates by set id", () => {
  const links = setLinksFromAnchors(
    [
      { href: "/12345/cell-biology-flash-cards/?i=abc", text: "Cell biology" },
      { href: "/gb/12345/cell-biology-flash-cards/", text: "Duplicate" },
      { href: "/latest", text: "Not a set" },
    ],
    "https://quizlet.com/user/example/folders/biology",
  );

  assert.equal(links.length, 1);
  assert.equal(links[0]?.id, "12345");
  assert.equal(links[0]?.url, "https://quizlet.com/gb/12345/cell-biology-flash-cards/");
});

test("formats cards and produces Windows-safe names", () => {
  assert.equal(safeFileName('CON', "fallback"), "fallback");
  assert.equal(safeFileName('Chapter 1: Cells?', "fallback"), "Chapter 1- Cells-");
  assert.equal(
    formatFlashcards([
      { term: "  cell\nmembrane ", definition: " controls   entry " },
      { term: "Nucleus", definition: "Contains DNA" },
    ]),
    "1. cell membrane : controls entry\n2. Nucleus : Contains DNA",
  );
});

test("extracts and validates term-definition pairs from rendered UI", async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <h1>Cell Biology</h1>
    <section class="SetPageTerms-termsList">
      <div class="SetPageTerm-content">
        <span class="SetPageTerm-wordText"><span class="TermText">Cell</span></span>
        <span class="SetPageTerm-definitionText"><span class="TermText">Basic unit of life</span></span>
      </div>
      <div class="SetPageTerm-content">
        <span class="SetPageTerm-wordText"><span class="TermText">DNA</span></span>
        <span class="SetPageTerm-definitionText"><span class="TermText">Genetic material</span></span>
      </div>
    </section>
  `);

  const result = await extractFlashcardSet(page, {
    id: "12345",
    name: "Cell Biology",
    url: "https://quizlet.com/12345/cell-biology-flash-cards/",
  });

  assert.deepEqual(result.cards, [
    { term: "Cell", definition: "Basic unit of life" },
    { term: "DNA", definition: "Genetic material" },
  ]);
});
