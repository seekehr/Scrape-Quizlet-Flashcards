import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const cli = createInterface({ input, output });

console.log("Welcome to the Quizlet Flashcard Scraper!");

try {
  const foldersPageUrl = (await cli.question(
    "Enter the URL of your Quizlet folders page: ",
  )).trim();

  console.log(`Folders page URL received: ${foldersPageUrl}`);
} finally {
  cli.close();
}
