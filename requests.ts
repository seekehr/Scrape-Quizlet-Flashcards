import { FolderSchema, type Folder } from "./schemas.js";

export async function getFolders(foldersURL: string): Promise<Folder[]> {
    const response = await fetch(foldersURL);

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    const json: unknown = await response.json();

    // Parse and validate the complete JSON response before returning it. Zod
    // throws a detailed validation error if the response is not an array of
    // folders matching FolderSchema.
    return FolderSchema.array().parse(json);
}
