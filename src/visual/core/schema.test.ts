import { describe, expect, it } from "vitest";
import { schema } from "./schema";

describe("schema", () => {
  it("never renders a live link href, whatever the document says", () => {
    for (const href of ["javascript:alert(1)", "https://example.com", "file:///C:/Windows"]) {
      const mark = schema.marks.link.create({ href });
      const spec = schema.marks.link.spec.toDOM!(mark, true) as [string, Record<string, string>, number];
      const attrs = spec[1];
      expect(attrs.href).toBeUndefined();
      expect(attrs["data-href"]).toBe(href);
    }
  });
});
