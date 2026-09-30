import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { PlainTextPaste } from '../plain-text-paste';

function makeEditor(content = '<p></p>') {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, PlainTextPaste],
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: '\n' } },
    content,
  });
}

// jsdom has no ClipboardEvent, which pasteText constructs when given none.
function paste(editor: Editor, text: string) {
  editor.view.pasteText(text, new Event('paste') as ClipboardEvent);
}

describe('plain-text paste', () => {
  it('keeps blank lines as empty paragraphs', () => {
    const editor = makeEditor();
    paste(editor, 'Hi Joost,\n\nThanks for the write-up.\n\n\nPHASE 1');
    expect(editor.getHTML()).toBe(
      '<p>Hi Joost,</p><p></p><p>Thanks for the write-up.</p><p></p><p></p><p>PHASE 1</p>',
    );
    editor.destroy();
  });

  it('treats CRLF and CR line endings like LF', () => {
    const editor = makeEditor();
    paste(editor, 'one\r\n\r\ntwo\rthree');
    expect(editor.getHTML()).toBe('<p>one</p><p></p><p>two</p><p>three</p>');
    editor.destroy();
  });

  it('pastes a single line inline without splitting the paragraph', () => {
    const editor = makeEditor('<p>Hello world</p>');
    editor.commands.setTextSelection(7);
    paste(editor, 'big ');
    expect(editor.getHTML()).toBe('<p>Hello big world</p>');
    editor.destroy();
  });

  it('copies back out as the same text', () => {
    const text = 'Hi Joost,\n\nThanks for the write-up.\n\n\nPHASE 1';
    const editor = makeEditor();
    paste(editor, text);
    // TipTap's serializer reads the editor selection, not the slice it gets.
    editor.commands.selectAll();
    const slice = editor.state.selection.content();
    const copied = editor.view.someProp('clipboardTextSerializer', (f) => f(slice, editor.view));
    expect(copied).toBe(text);
    editor.destroy();
  });
});
