import { z } from "zod"

export const FolderSchema = z.object({
    id: z.number(),
    name: z.string(),
    isHidden: z.boolean(),
    _webUrl: z.url(),
});

export type Folder = z.infer<typeof FolderSchema>;
