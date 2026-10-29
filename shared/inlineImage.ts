import { z } from "zod";
export const INLINE_IMAGE_MIN_WIDTH = 40;
export const INLINE_IMAGE_MAX_WIDTH = 900;
export const inlineImageAttributes = z.object({
  attachmentId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  src: z.string(),
  alt: z.string().max(255).refine(value => !/[\p{Cc}]/u.test(value)).nullish(),
  width: z.number().int().min(INLINE_IMAGE_MIN_WIDTH).max(INLINE_IMAGE_MAX_WIDTH).nullish(),
}).strict().refine(value => value.src === `/api/attachments/${value.attachmentId}`);
