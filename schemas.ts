import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);

export const QuizletUrlSchema = z
  .url()
  .refine((value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "quizlet.com" || hostname.endsWith(".quizlet.com");
  }, "URL must point to quizlet.com");

export const FolderLinkSchema = z.object({
  name: nonEmptyText,
  url: QuizletUrlSchema,
});

export const SetLinkSchema = z.object({
  id: nonEmptyText,
  name: nonEmptyText,
  url: QuizletUrlSchema,
});

export const FlashcardSchema = z.object({
  term: nonEmptyText,
  definition: nonEmptyText,
});

export const FlashcardSetSchema = z.object({
  id: nonEmptyText,
  name: nonEmptyText,
  url: QuizletUrlSchema,
  cards: z.array(FlashcardSchema).min(1),
});

export const FolderSchema = z.object({
  name: nonEmptyText,
  url: QuizletUrlSchema,
  sets: z.array(SetLinkSchema),
});

export type FolderLink = z.infer<typeof FolderLinkSchema>;
export type SetLink = z.infer<typeof SetLinkSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;
export type FlashcardSet = z.infer<typeof FlashcardSetSchema>;
export type Folder = z.infer<typeof FolderSchema>;
