import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  FlashcardSetSchema,
  FolderLinkSchema,
  FolderSchema,
  QuizletUrlSchema,
  SetLinkSchema,
  type Flashcard,
  type FlashcardSet,
  type FolderLink,
  type SetLink,
} from "./schemas.js";

const FOLDER_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?user\/[^/]+\/folders\/[^/]+\/?$/i;
const SET_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(\d+)\/[^/]+\/?$/i;
const INVALID_FILE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface ScrapeOptions {
  browserMode?: "auto" | "chrome" | "playwright";
  headless?: boolean;
  outputDirectory?: string;
  profileDirectory?: string;
}

export interface ScrapeFailure {
  folder: string;
  set: string;
  url: string;
  message: string;
}

export interface ScrapeResult {
  foldersFound: number;
  setsFound: number;
  filesWritten: string[];
  failures: ScrapeFailure[];
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function humanizeSlug(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/-flash-cards?$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQuizletUrl(rawUrl: string, baseUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl, baseUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "quizlet.com" && !hostname.endsWith(".quizlet.com")) {
      return undefined;
    }

    url.hash = "";
    url.search = "";
    return url;
  } catch {
    return undefined;
  }
}

export function safeFileName(value: string, fallback: string): string {
  let result = normalizeText(value)
    .replace(INVALID_FILE_CHARACTERS, "-")
    .replace(/\.+$/g, "")
    .trim();

  if (!result || WINDOWS_RESERVED_NAME.test(result)) {
    result = fallback;
  }

  return result.slice(0, 120).replace(/[ .]+$/g, "") || fallback;
}

export function formatFlashcards(cards: Flashcard[]): string {
  return cards
    .map(
      ({ term, definition }, index) =>
        `${index + 1}. ${normalizeText(term)} : ${normalizeText(definition)}`,
    )
    .join("\n");
}

interface BrowserSession {
  context: BrowserContext;
  close: () => Promise<void>;
}

function findChromeExecutable(): string | undefined {
  const candidates: string[] = [];

  if (process.platform === "win32") {
    for (const base of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (base) {
        candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    );
  }

  return candidates.find((candidate) => existsSync(candidate));
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local Chrome debugging port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function waitForChromeDebugger(
  endpoint: string,
  processHandle: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Chrome exited before Playwright could attach (code ${processHandle.exitCode}).`);
    }

    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome has not opened its local debugging endpoint yet.
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for the regular Chrome window to start.");
}

async function launchRegularChrome(profileDirectory: string): Promise<BrowserSession> {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      "Google Chrome was not found. Install Chrome or run with --playwright-browser.",
    );
  }

  const port = await availableLoopbackPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const processHandle = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: false },
  );

  try {
    await waitForChromeDebugger(endpoint, processHandle);
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome started without an attachable browser context.");
    }

    return {
      context,
      close: async () => {
        await browser.close().catch(() => undefined);
        if (processHandle.exitCode === null) {
          processHandle.kill();
        }
      },
    };
  } catch (error) {
    if (processHandle.exitCode === null) {
      processHandle.kill();
    }
    throw error;
  }
}

async function launchBrowser(options: ScrapeOptions): Promise<BrowserSession> {
  const headless = options.headless ?? false;
  const requestedMode = options.browserMode ?? "auto";
  const useRegularChrome =
    requestedMode === "chrome" ||
    (requestedMode === "auto" && !headless && findChromeExecutable() !== undefined);

  if (useRegularChrome) {
    if (headless) {
      throw new Error("Regular Chrome verification mode cannot be used with --headless.");
    }

    const profileDirectory = path.resolve(options.profileDirectory ?? ".quizlet-chrome");
    console.log("Opening regular Chrome with a dedicated reusable profile...");
    return launchRegularChrome(profileDirectory);
  }

  const profileDirectory = path.resolve(options.profileDirectory ?? ".quizlet-browser");
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless,
    viewport: { width: 1440, height: 1000 },
  });
  return {
    context,
    close: () => context.close(),
  };
}

async function dismissCookieBanner(page: Page): Promise<void> {
  const labels = [
    /accept all/i,
    /accept cookies/i,
    /allow all/i,
    /agree/i,
  ];

  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2_000 }).catch(() => undefined);
      return;
    }
  }
}

interface PageSnapshot {
  title: string;
  bodyText: string;
  documentReady: boolean;
  hasChallengeElement: boolean;
  hasContentElement: boolean;
}

async function pageSnapshot(page: Page): Promise<PageSnapshot> {
  return page
    .evaluate(() => ({
      title: document.title,
      bodyText: document.body?.innerText.slice(0, 5_000) ?? "",
      documentReady: document.readyState !== "loading",
      hasChallengeElement: Boolean(
        document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"], #challenge-stage',
        ),
      ),
      hasContentElement: Boolean(
        document.querySelector("main, h1, [role=main]") ||
          document.querySelectorAll("a[href]").length >= 3,
      ),
    }))
    .catch(() => ({
      title: "",
      bodyText: "",
      documentReady: false,
      hasChallengeElement: false,
      hasContentElement: false,
    }));
}

function snapshotIsSecurityChallenge(snapshot: PageSnapshot): boolean {
  const challengeText = `${snapshot.title}\n${snapshot.bodyText}`;
  return (
    snapshot.hasChallengeElement ||
    /just a moment|one more step|checking your browser|security verification|verif(?:y|ying)(?: you are)? human|security system.*triggered|cloudflare.*ray id|ray id:/i.test(
      challengeText,
    )
  );
}

export async function waitForQuizletPage(
  page: Page,
  headless: boolean,
  maximumWaitMs = 5 * 60_000,
): Promise<void> {
  const startedAt = Date.now();
  let deadline = startedAt + Math.min(maximumWaitMs, 30_000);
  let challengeSeen = false;
  let challengeMessagePrinted = false;
  let readySince: number | undefined;
  let lastSnapshot = await pageSnapshot(page);

  while (Date.now() < deadline) {
    lastSnapshot = await pageSnapshot(page);
    const isChallenge = snapshotIsSecurityChallenge(lastSnapshot);

    if (isChallenge) {
      challengeSeen = true;
      readySince = undefined;

      if (!challengeMessagePrinted) {
        console.log(
          headless
            ? "Quizlet requested human verification; waiting briefly for automatic verification..."
            : "Quizlet requested human verification. Complete it in the browser window...",
        );
        challengeMessagePrinted = true;
      }

      deadline = headless
        ? Math.min(deadline, Date.now() + 15_000)
        : startedAt + maximumWaitMs;
    } else if (
      lastSnapshot.documentReady &&
      lastSnapshot.hasContentElement &&
      normalizeText(lastSnapshot.bodyText).length > 20
    ) {
      readySince ??= Date.now();

      // Requiring a short stable period catches Cloudflare redirects that occur
      // just after the first document's DOMContentLoaded event.
      if (Date.now() - readySince >= 2_000) {
        return;
      }
    } else {
      readySince = undefined;
    }

    await page.waitForTimeout(250);
  }

  if (challengeSeen) {
    throw new Error(
      headless
        ? "Quizlet requested human verification. Run without --headless and complete the challenge in the opened browser."
        : "Timed out waiting for Quizlet human verification.",
    );
  }

  const title = normalizeText(lastSnapshot.title) || "untitled page";
  throw new Error(`Quizlet did not finish loading (page title: ${title}).`);
}

async function openPage(page: Page, url: string, headless: boolean): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForQuizletPage(page, headless);
  await dismissCookieBanner(page);
}

async function revealAllItems(page: Page): Promise<void> {
  let previousHeight = 0;
  let stablePasses = 0;

  for (let pass = 0; pass < 40 && stablePasses < 3; pass += 1) {
    for (const label of [/show more/i, /see more/i, /view more/i, /load more/i]) {
      const button = page.getByRole("button", { name: label }).last();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_000 }).catch(() => undefined);
      }
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const height = await page.evaluate(() => document.body.scrollHeight);

    if (height === previousHeight) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      previousHeight = height;
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

interface AnchorData {
  href: string;
  text: string;
}

async function readAnchors(page: Page): Promise<AnchorData[]> {
  return page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute("href") ?? "",
      text: anchor.textContent ?? "",
    })),
  );
}

async function readAnchorsAcrossPage(page: Page): Promise<AnchorData[]> {
  const anchors: AnchorData[] = [];
  const viewportHeight = page.viewportSize()?.height ?? 800;
  const step = Math.max(400, Math.floor(viewportHeight * 0.75));
  let position = 0;
  let pageHeight = await page.evaluate(() => document.body.scrollHeight);

  while (position <= pageHeight && position / step < 500) {
    await page.evaluate((top) => window.scrollTo(0, top), position);
    await page.waitForTimeout(100);
    anchors.push(...(await readAnchors(page)));
    pageHeight = Math.max(
      pageHeight,
      await page.evaluate(() => document.body.scrollHeight),
    );
    position += step;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return anchors;
}

export function folderLinksFromAnchors(
  anchors: AnchorData[],
  baseUrl: string,
): FolderLink[] {
  const links = new Map<string, FolderLink>();

  for (const anchor of anchors) {
    const url = parseQuizletUrl(anchor.href, baseUrl);
    if (!url || !FOLDER_PATH.test(url.pathname)) {
      continue;
    }

    const slug = url.pathname.split("/").filter(Boolean).at(-1) ?? "folder";
    const link = FolderLinkSchema.parse({
      name: normalizeText(anchor.text) || humanizeSlug(slug),
      url: url.href,
    });
    links.set(url.pathname.toLowerCase(), link);
  }

  return [...links.values()];
}

export function setLinksFromAnchors(
  anchors: AnchorData[],
  baseUrl: string,
): SetLink[] {
  const links = new Map<string, SetLink>();

  for (const anchor of anchors) {
    const url = parseQuizletUrl(anchor.href, baseUrl);
    if (!url) {
      continue;
    }

    const match = SET_PATH.exec(url.pathname);
    if (!match?.[1]) {
      continue;
    }

    const slug = url.pathname.split("/").filter(Boolean).at(-1) ?? `set-${match[1]}`;
    const link = SetLinkSchema.parse({
      id: match[1],
      name: normalizeText(anchor.text) || humanizeSlug(slug),
      url: url.href,
    });
    links.set(match[1], link);
  }

  return [...links.values()];
}

async function findFolderLinks(page: Page): Promise<FolderLink[]> {
  await revealAllItems(page);
  return folderLinksFromAnchors(await readAnchorsAcrossPage(page), page.url());
}

async function findSetLinks(page: Page): Promise<SetLink[]> {
  await revealAllItems(page);
  return setLinksFromAnchors(await readAnchorsAcrossPage(page), page.url());
}

async function firstHeading(page: Page, fallback: string): Promise<string> {
  const heading = page.locator("h1").first();
  return normalizeText(
    (await heading.isVisible().catch(() => false))
      ? await heading.innerText().catch(() => fallback)
      : fallback,
  );
}

interface RawCard {
  term: string;
  definition: string;
  key: string;
}

async function cardsFromContainer(
  page: Page,
  containerSelector: string,
): Promise<RawCard[]> {
  return page.locator(containerSelector).evaluateAll((containers) => {
    const termSelectors = [
      '[data-testid="set-page-term-word"]',
      '[data-testid*="term-word"]',
      '[class*="SetPageTerm-wordText"]',
    ];
    const definitionSelectors = [
      '[data-testid="set-page-term-definition"]',
      '[data-testid*="term-definition"]',
      '[class*="SetPageTerm-definitionText"]',
    ];

    return containers.map((container) => {
      let term = "";
      for (const selector of termSelectors) {
        const match = container.querySelector(selector);
        if (match?.textContent?.trim()) {
          term = match.textContent;
          break;
        }
      }

      let definition = "";
      for (const selector of definitionSelectors) {
        const match = container.querySelector(selector);
        if (match?.textContent?.trim()) {
          definition = match.textContent;
          break;
        }
      }

      if (!term || !definition) {
        const textElements = [...container.querySelectorAll('[class*="TermText"]')]
          .map((element) => element.textContent?.trim() ?? "")
          .filter(Boolean);
        term ||= textElements[0] ?? "";
        definition ||= textElements[1] ?? "";
      }

      const identifiedContainer = container.closest("[data-term-id], [data-testid]");
      const key =
        container.getAttribute("data-term-id") ??
        identifiedContainer?.getAttribute("data-term-id") ??
        container.id ??
        "";

      return { term, definition, key };
    });
  });
}

function cardsMatch(left: RawCard, right: RawCard): boolean {
  if (left.key && right.key) {
    return left.key === right.key;
  }
  return (
    normalizeText(left.term) === normalizeText(right.term) &&
    normalizeText(left.definition) === normalizeText(right.definition)
  );
}

function mergeCardBatch(collected: RawCard[], batch: RawCard[]): void {
  const maximumOverlap = Math.min(collected.length, batch.length);
  let overlap = maximumOverlap;

  for (; overlap > 0; overlap -= 1) {
    const start = collected.length - overlap;
    if (batch.slice(0, overlap).every((card, index) => cardsMatch(collected[start + index]!, card))) {
      break;
    }
  }

  collected.push(...batch.slice(overlap));
}

async function collectRawCards(page: Page, selectors: string[]): Promise<RawCard[]> {
  const collected: RawCard[] = [];
  const viewportHeight = page.viewportSize()?.height ?? 800;
  const step = Math.max(300, Math.floor(viewportHeight * 0.6));
  let position = 0;
  let pageHeight = await page.evaluate(() => document.body.scrollHeight);

  while (position <= pageHeight && position / step < 1_000) {
    await page.evaluate((top) => window.scrollTo(0, top), position);
    await page.waitForTimeout(100);

    for (const selector of selectors) {
      const batch = await cardsFromContainer(page, selector);
      if (batch.length > 0) {
        mergeCardBatch(collected, batch);
        break;
      }
    }

    pageHeight = Math.max(
      pageHeight,
      await page.evaluate(() => document.body.scrollHeight),
    );
    position += step;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return collected;
}

async function expectedCardCount(page: Page): Promise<number | undefined> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const match = /terms in this set\s*\(([\d,]+)\)/i.exec(bodyText);
  if (!match?.[1]) {
    return undefined;
  }

  const count = Number.parseInt(match[1].replaceAll(",", ""), 10);
  return Number.isFinite(count) ? count : undefined;
}

export async function extractFlashcardSet(
  page: Page,
  setLink: SetLink,
): Promise<FlashcardSet> {
  await revealAllItems(page);
  const expectedCount = await expectedCardCount(page);

  const selectors = [
    '[data-testid="terms-list"] > [aria-label="Term"]',
    '[data-testid="terms-list"] .SetPageTermsList-term',
    '[data-testid="set-page-terms-list"] [data-testid="set-page-term"]',
    '[class*="SetPageTerms-termsList"] [class*="SetPageTerm-content"]',
    '[data-testid="set-page-term"]',
    '[class*="SetPageTerm-content"]',
  ];

  const rawCards = await collectRawCards(page, selectors);

  if (expectedCount !== undefined && rawCards.length !== expectedCount) {
    throw new Error(
      `The page reports ${expectedCount} terms, but ${rawCards.length} were extracted.`,
    );
  }

  const incompleteCard = rawCards.findIndex(
    ({ term, definition }) => !normalizeText(term) || !normalizeText(definition),
  );
  if (incompleteCard >= 0) {
    throw new Error(`Term ${incompleteCard + 1} is missing text or a definition.`);
  }

  const slug = new URL(setLink.url).pathname.split("/").filter(Boolean).at(-1) ?? setLink.name;
  return FlashcardSetSchema.parse({
    id: setLink.id,
    name: await firstHeading(page, humanizeSlug(slug)),
    url: setLink.url,
    cards: rawCards.map(({ term, definition }) => ({
      term: normalizeText(term),
      definition: normalizeText(definition),
    })),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function scrapeQuizletFolders(
  foldersPageUrl: string,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const validatedUrl = QuizletUrlSchema.parse(foldersPageUrl);
  const pathname = new URL(validatedUrl).pathname;
  if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?user\/[^/]+\/folders\/?$/i.test(pathname)) {
    throw new Error(
      "Expected a Quizlet folders-page URL such as https://quizlet.com/user/name/folders",
    );
  }

  const headless = options.headless ?? false;
  const outputDirectory = path.resolve(options.outputDirectory ?? "data");
  const browserSession = await launchBrowser(options);
  const { context } = browserSession;
  const page = context.pages()[0] ?? (await context.newPage());

  const result: ScrapeResult = {
    foldersFound: 0,
    setsFound: 0,
    filesWritten: [],
    failures: [],
  };

  try {
    console.log(`Opening folders page: ${validatedUrl}`);
    await openPage(page, validatedUrl, headless);
    const folders = await findFolderLinks(page);
    if (folders.length === 0) {
      throw new Error(
        "No folder links were found. Confirm the profile has public folders and that the page finished loading.",
      );
    }

    result.foldersFound = folders.length;
    console.log(`Found ${folders.length} folder${folders.length === 1 ? "" : "s"}.`);

    for (const [folderIndex, folderLink] of folders.entries()) {
      console.log(`[Folder ${folderIndex + 1}/${folders.length}] ${folderLink.name}`);
      await openPage(page, folderLink.url, headless);

      const folderName = await firstHeading(page, folderLink.name);
      const setLinks = await findSetLinks(page);
      const folder = FolderSchema.parse({
        name: folderName,
        url: folderLink.url,
        sets: setLinks,
      });
      result.setsFound += folder.sets.length;

      const folderPath = path.join(
        outputDirectory,
        safeFileName(folder.name, `folder-${folderIndex + 1}`),
      );
      await mkdir(folderPath, { recursive: true });

      if (folder.sets.length === 0) {
        console.log("  No sets found; folder is empty or its sets are private.");
        continue;
      }

      for (const [setIndex, setLink] of folder.sets.entries()) {
        console.log(`  [Set ${setIndex + 1}/${folder.sets.length}] ${setLink.name}`);
        try {
          await openPage(page, setLink.url, headless);
          const flashcardSet = await extractFlashcardSet(page, setLink);
          const baseName = safeFileName(flashcardSet.name, `set-${flashcardSet.id}`);
          let filePath = path.join(folderPath, `${baseName}.txt`);
          if (result.filesWritten.includes(filePath)) {
            filePath = path.join(folderPath, `${baseName} (${flashcardSet.id}).txt`);
          }

          await writeFile(filePath, `${formatFlashcards(flashcardSet.cards)}\n`, "utf8");
          result.filesWritten.push(filePath);
          console.log(`    Saved ${flashcardSet.cards.length} cards to ${filePath}`);
        } catch (error) {
          const message = errorMessage(error);
          result.failures.push({
            folder: folder.name,
            set: setLink.name,
            url: setLink.url,
            message,
          });
          console.error(`    Failed: ${message}`);
        }
      }
    }

    return result;
  } finally {
    await browserSession.close();
  }
}
