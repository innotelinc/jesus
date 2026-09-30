import { Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Pastes plain text as one paragraph per line, blank lines included.
 *
 * In the composer Enter starts a new paragraph and a blank line is an empty
 * paragraph. ProseMirror's default text paste splits on runs of newlines
 * instead, so every blank line was dropped and a pasted mail arrived as a
 * wall of lines with no gap between its paragraphs. This builds the same
 * paragraphs typing the text would.
 */
export const PlainTextPaste = Extension.create({
  name: "plainTextPaste",

  addProseMirrorPlugins() {
    const { schema } = this.editor;
    return [
      new Plugin({
        key: new PluginKey("plainTextPaste"),
        props: {
          clipboardTextParser: (text, $context) => {
            const marks = $context.marks();
            const paragraphs = text
              .split(/\r\n?|\n/)
              .map((line) =>
                schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : null),
              );
            return Slice.maxOpen(Fragment.from(paragraphs));
          },
        },
      }),
    ];
  },
});
