import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { ZodError } from "zod";
import { scrapeQuizletFolders } from "./scraper.js";

function printUsage(): void {
  console.log(`Usage: npm run dev -- [folders-url] [--headless]

If folders-url is omitted, the program prompts for it. The browser is visible by
default so Quizlet can request human verification when necessary.`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const headless = args.includes("--headless") || process.env.QUIZLET_HEADLESS === "true";
let foldersPageUrl = args.find((argument) => !argument.startsWith("-"))?.trim();

console.log("Welcome to the Quizlet Flashcard Scraper!");

if (!foldersPageUrl) {
  const cli = createInterface({ input, output });
  try {
    foldersPageUrl = (await cli.question(
      "Enter the URL of a Quizlet user's folders page: ",
    )).trim();
  } finally {
    cli.close();
  }
}

try {
  const result = await scrapeQuizletFolders(foldersPageUrl, { headless });
  console.log(
    `\nDone. Wrote ${result.filesWritten.length} of ${result.setsFound} discovered sets from ${result.foldersFound} folders.`,
  );

  if (result.failures.length > 0) {
    console.error(`\n${result.failures.length} set(s) failed:`);
    for (const failure of result.failures) {
      console.error(`- ${failure.folder} / ${failure.set}: ${failure.message}`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof ZodError) {
    console.error("Validation failed:", error.issues);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}
