import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { realAttachments, ListAttachmentChips } from "../attachment-chips";
import type { Attachment, Email } from "@/lib/jmap/types";

function att(over: Partial<Attachment>): Attachment {
  return { partId: "1", blobId: "b1", size: 100, type: "application/pdf", name: "doc.pdf", ...over };
}

describe("realAttachments", () => {
  it("returns nothing when the message has no attachments", () => {
    expect(realAttachments(undefined)).toEqual([]);
    expect(realAttachments([])).toEqual([]);
  });

  it("drops parts marked inline", () => {
    const kept = att({ name: "invoice.pdf" });
    const out = realAttachments([
      kept,
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", disposition: "inline" }),
    ]);
    expect(out).toEqual([kept]);
  });

  it("drops parts referenced by Content-ID even without a disposition", () => {
    // Outlook signature images arrive as cid: references; six of them on one
    // message would otherwise fill the row with 180-byte spacers.
    const out = realAttachments([
      att({ partId: "2", blobId: "b2", name: "image001.png", type: "image/png", cid: "image001.png@01DD" }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops parts with no filename, which cannot be labelled or saved", () => {
    expect(realAttachments([att({ name: undefined })])).toEqual([]);
  });

  it("keeps genuine attachments in order", () => {
    const a = att({ partId: "1", blobId: "b1", name: "a.pdf" });
    const b = att({ partId: "2", blobId: "b2", name: "b.xlsx", type: "application/vnd.ms-excel" });
    expect(realAttachments([a, b])).toEqual([a, b]);
  });
});

// #1089: list requests no longer carry `attachments`; rows load their own.
describe("ListAttachmentChips", () => {
  const row = (over: Partial<Email>) => ({ id: "m1", hasAttachment: true, ...over }) as Email;

  it("uses attachments the email already carries without loading", () => {
    const load = vi.fn(() => () => {});
    render(<ListAttachmentChips email={row({ attachments: [att({ name: "have.pdf" })] })} load={load} onOpen={vi.fn()} />);
    expect(screen.getByTitle("have.pdf")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  it("does not load for a row without a paperclip", () => {
    const load = vi.fn(() => () => {});
    render(<ListAttachmentChips email={row({ hasAttachment: false })} load={load} onOpen={vi.fn()} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the parts of a row with a paperclip and shows them", () => {
    let deliver!: (a: Attachment[]) => void;
    const cancel = vi.fn();
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return cancel; });
    const { unmount } = render(<ListAttachmentChips email={row({})} load={load} onOpen={vi.fn()} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => deliver([att({ name: "late.pdf" })]));
    expect(screen.getByTitle("late.pdf")).toBeTruthy();
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it("does not show one message's parts on another", () => {
    let deliver!: (a: Attachment[]) => void;
    const load = vi.fn((_email: Email, onLoad: (a: Attachment[]) => void) => { deliver = onLoad; return () => {}; });
    const { rerender } = render(<ListAttachmentChips email={row({ id: "m1" })} load={load} onOpen={vi.fn()} />);
    act(() => deliver([att({ name: "first.pdf" })]));
    rerender(<ListAttachmentChips email={row({ id: "m2" })} load={load} onOpen={vi.fn()} />);
    expect(screen.queryByTitle("first.pdf")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
