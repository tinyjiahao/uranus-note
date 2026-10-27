import { z } from "zod";
export const noteLinkAttributes = z.object({
  noteId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().refine(value => Array.from(value).length <= 256 && !/[\p{Cc}]/u.test(value)),
}).strict();
