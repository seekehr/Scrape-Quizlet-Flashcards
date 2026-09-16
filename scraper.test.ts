import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  extractFlashcardSet,
  folderLinksFromAnchors,
  formatFlashcards,
  safeFileName,
  setLinksFromAnchors,
  waitForQuizletPage,
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

test("waits through a delayed security-page redirect", async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<body>Initial response is still loading</body>");

  const transitions = (async () => {
    await page.waitForTimeout(100);
    await page.setContent(`
      <title>Just a moment...</title>
      <body><h2>One more step...</h2><p>Verifying you are human</p></body>
    `);
    await page.waitForTimeout(300);
    await page.setContent(`
      <title>Folders | Quizlet</title>
      <body><main><h1>Folders</h1><p>The real Quizlet content is now loaded.</p></main></body>
    `);
  })();

  await Promise.all([waitForQuizletPage(page, false, 5_000), transitions]);
  assert.equal(await page.title(), "Folders | Quizlet");
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

test("extracts cards from Quizlet's current terms-list markup", async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <h1>Momentum</h1>
    <span>Terms in this set (2)</span>
    <section data-testid="terms-list">
      <div aria-label="Term" class="SetPageTermsList-term">
        <div data-testid="set-page-term-card-side"><span class="TermText">momentum</span></div>
        <div data-testid="set-page-term-card-side"><span class="TermText">mass × velocity</span></div>
      </div>
      <div aria-label="Term" class="SetPageTermsList-term">
        <div data-testid="set-page-term-card-side"><span class="TermText">impulse</span></div>
        <div data-testid="set-page-term-card-side"><span class="TermText">force × time</span></div>
      </div>
    </section>
  `);

  const result = await extractFlashcardSet(page, {
    id: "67890",
    name: "Momentum",
    url: "https://quizlet.com/67890/momentum-flash-cards/",
  });

  assert.deepEqual(result.cards, [
    { term: "momentum", definition: "mass × velocity" },
    { term: "impulse", definition: "force × time" },
  ]);
});
