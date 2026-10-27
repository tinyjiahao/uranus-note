import { z } from "zod";
export const LABEL_COLORS = ["gray", "blue", "cyan", "green", "lime", "yellow", "amber", "pink", "rose", "purple"] as const;
export const labelAttributes = z.object({
  text: z.string().transform(value => value.normalize("NFC")).refine(value => Array.from(value).length >= 1 && Array.from(value).length <= 50 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)),
  color: z.enum(LABEL_COLORS),
}).strict();
