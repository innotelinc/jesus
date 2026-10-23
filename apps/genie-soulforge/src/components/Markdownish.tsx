import type { ReactNode } from 'react'

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code className="inline-code" key={key}>
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    return <span key={key}>{part}</span>
  })
}

/** Renders fenced code blocks as <pre>, and keeps everything else as plain text. */
export function Markdownish({ text }: { text: string }) {
  const blocks: { kind: 'text' | 'code'; content: string; lang?: string }[] = []
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) {
      blocks.push({ kind: 'text', content: text.slice(cursor, match.index) })
    }
    blocks.push({ kind: 'code', lang: match[1] || undefined, content: match[2].replace(/\n$/, '') })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) blocks.push({ kind: 'text', content: text.slice(cursor) })

  if (blocks.length === 0) return null

  return (
    <div className="md">
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <div className="code-block" key={`code-${index}`}>
            {block.lang ? <span className="code-lang">{block.lang}</span> : null}
            <pre>
              <code>{block.content}</code>
            </pre>
          </div>
        ) : (
          <div className="md-text" key={`text-${index}`}>
            {inline(block.content, `t${index}`)}
          </div>
        ),
      )}
    </div>
  )
}
