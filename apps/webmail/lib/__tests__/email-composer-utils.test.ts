import { describe, expect, it } from "vitest";
import {
  plainTextToComposerBody,
  rewriteCidImagesForEditor,
  replaceInlineImagePlaceholders,
  INLINE_IMAGE_PLACEHOLDER,
} from "../email-composer-utils";

describe("plainTextToComposerBody", () => {
  it("returns an empty string for empty input", () => {
    expect(plainTextToComposerBody("")).toBe("");
  });

  it("escapes HTML before building composer paragraphs", () => {
    expect(plainTextToComposerBody("<script>alert('x') & \"q\"</script>")).toBe(
      "<p>&lt;script&gt;alert(&#39;x&#39;) &amp; &quot;q&quot;&lt;/script&gt;</p>"
    );
  });

  it("normalizes line endings and preserves single line breaks", () => {
    expect(plainTextToComposerBody("line1\r\nline2\rline3")).toBe(
      "<p>line1<br>line2<br>line3</p>"
    );
  });

  it("splits paragraphs on blank lines", () => {
    expect(plainTextToComposerBody("first\n\nsecond\nthird")).toBe(
      "<p>first</p><p>second<br>third</p>"
    );
  });
});

describe("rewriteCidImagesForEditor", () => {
  it("returns input unchanged when no cid: refs are present", () => {
    const html = '<p>hi</p><img src="https://example.com/x.png">';
    expect(rewriteCidImagesForEditor(html)).toBe(html);
  });

  it("handles empty input", () => {
    expect(rewriteCidImagesForEditor("")).toBe("");
  });

  it("rewrites a cid: src to placeholder + data-cid", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="cid:abc@x" alt="logo">'
    );
    expect(out).toContain('data-cid="abc@x"');
    expect(out).toContain(`src="${INLINE_IMAGE_PLACEHOLDER}"`);
    expect(out).toContain('alt="logo"');
    expect(out).not.toContain('src="cid:');
  });

  it("preserves an existing data-cid attribute", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="cid:abc" data-cid="kept">'
    );
    expect(out).toContain('data-cid="kept"');
    expect(out).not.toContain('data-cid="abc"');
  });

  it("leaves non-cid images alone", () => {
    const out = rewriteCidImagesForEditor(
      '<img src="https://example.com/x.png"><img src="cid:y">'
    );
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('data-cid="y"');
  });
});

describe("replaceInlineImagePlaceholders", () => {
  it("returns input unchanged when the map is empty", () => {
    const html = '<img src="..." data-cid="x">';
    expect(replaceInlineImagePlaceholders(html, new Map())).toBe(html);
  });

  it("swaps the placeholder src to the data URL for matching cids", () => {
    const html = `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="abc">`;
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('data-cid="abc"');
  });

  it("also rewrites raw cid: src refs that lack a placeholder", () => {
    const html = '<img src="cid:abc" data-cid="abc">';
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("does not overwrite images the user has re-pointed away from the cid", () => {
    const html =
      '<img src="https://example.com/other.png" data-cid="abc">';
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toContain('src="https://example.com/other.png"');
    expect(out).not.toContain("data:image/png;base64,AAAA");
  });

  it("leaves unknown cids untouched", () => {
    const html = `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="missing">`;
    const out = replaceInlineImagePlaceholders(
      html,
      new Map([["abc", "data:image/png;base64,AAAA"]])
    );
    expect(out).toBe(html);
  });
});
