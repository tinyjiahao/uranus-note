import { expect, it } from "vitest";
import { validateAndDeriveContent } from "../../shared/content";
import { toMarkdown } from "../../shared/markdownExport";
import type { ContentNode } from "../../shared/dto";

const content = (display?: string): ContentNode => ({ type: "doc", content: [{ type: "fileAttachment", attrs: {
  attachmentId: "file1", fileName: "report.pdf", size: 1024, mime: "application/pdf", ...(display === undefined ? {} : { display }),
} }] });
it("accepts legacy attachments and validates the versioned display whitelist", () => {
  expect(validateAndDeriveContent(content(), 7).attachmentIds).toEqual(["file1"]);
  for (const display of ["compact", "card"]) {
    expect(validateAndDeriveContent(content(display), 9)).toMatchObject({ attachmentIds: ["file1"], plainText: "report.pdf" });
    expect(() => validateAndDeriveContent(content(display), 8)).toThrow();
    expect(toMarkdown(content(display))).toBe(toMarkdown(content()));
  }
  expect(() => validateAndDeriveContent(content("unknown"), 9)).toThrow();
});

it("versions table attachments and retains file links in table exports", () => {
  const file = content("card").content![0]!;
  for (const cellType of ["tableCell", "tableHeader"]) {
    for (const child of [file, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }, file] }] }]) {
      const doc: ContentNode = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: cellType, content: [child] }] }] }] };
      expect(validateAndDeriveContent(doc, 10).attachmentIds).toEqual(["file1"]);
      expect(() => validateAndDeriveContent(doc, 9)).toThrow();
      expect(toMarkdown(doc)).toContain("[report.pdf](attachments/report-file1.pdf)");
    }
  }
  const nested: ContentNode = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "table" }] }] }] }] };
  expect(() => validateAndDeriveContent(nested, 10)).toThrow();
});
