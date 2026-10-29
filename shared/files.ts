import { z } from "zod";

export const MAX_FILE_BYTES = 10_000_000;
export const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json", "application/yaml": "yml",
};
export const fileAttachmentAttributes = z.object({
  attachmentId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  fileName: z.string().min(1).max(255).refine(value => !/[\p{Cc}\\/]/u.test(value)),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  mime: z.string().refine(value => Object.hasOwn(MIME_EXTENSIONS, value) && !value.startsWith("image/")),
  display: z.enum(["compact", "card"]).optional(),
}).strict();
/** Inline file attachment: same metadata as the block attachment, no display style (always a compact inline chip). */
export const inlineFileAttributes = fileAttachmentAttributes.omit({ display: true }).strict();

export function isMagicValid(mime: string, data: Uint8Array): boolean {
  if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, i) => data[i] === value);
  if (mime === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const ascii = (start: number, end: number) => String.fromCharCode(...data.slice(start, end));
  if (mime === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mime === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  if (mime === "application/pdf") return ascii(0, 4) === "%PDF";
  if (mime === "application/zip" || (Object.hasOwn(MIME_EXTENSIONS, mime) && mime.includes("openxmlformats"))) return data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4;
  if (["text/plain", "text/markdown", "text/csv", "application/json", "application/yaml"].includes(mime)) {
    if (data.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(data); return true; } catch { return false; }
  }
  return false;
}

/** Types that can be previewed in the app (text decoded as UTF-8, PDF through the browser viewer). */
export const PREVIEW_TEXT_MIMES = ["text/plain", "text/markdown", "text/csv", "application/json", "application/yaml"] as const;
export const isPreviewable = (mime: string) => mime === "application/pdf" || (PREVIEW_TEXT_MIMES as readonly string[]).includes(mime);
