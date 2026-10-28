import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTurns, endpointFor, streamChat } from '../src/lib/llm'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

async function collect(stream: AsyncGenerator<string, void, unknown>): Promise<string> {
  let output = ''
  for await (const part of stream) output += part
  return output
}

describe('endpointFor', () => {
  it('routes known providers through the local proxy', () => {
    expect(endpointFor('https://gateway.innotel.us/v1')).toBe('/llm/omniroute/chat/completions')
    expect(endpointFor('https://openrouter.ai/api/v1')).toBe('/llm/openrouter/chat/completions')
    expect(endpointFor('https://api.openai.com/v1/')).toBe('/llm/openai/chat/completions')
  })

  it('passes through custom endpoints and avoids double suffixes', () => {
    expect(endpointFor('https://example.com/v1')).toBe('https://example.com/v1/chat/completions')
    expect(endpointFor('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions',
    )
    expect(endpointFor('   ')).toBe('')
  })
})

describe('buildTurns', () => {
  it('prefixes a non-empty system prompt and keeps message order', () => {
    const turns = buildTurns('  You are Atlas.  ', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(turns).toEqual([
      { role: 'system', content: '  You are Atlas.  ' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(buildTurns('   ', [])).toEqual([])
  })
})

describe('streamChat', () => {
  it('parses deltas across chunk boundaries and ignores keepalives', async () => {
    const fetchMock = vi.fn(async () => {
      const first = delta('Hel')
      return sseResponse([
        ': keepalive\n\n',
        'data: {"choices":[{"delta":{}}]}\n\n',
        first.slice(0, 12),
        first.slice(12),
        delta('lo'),
        delta(' world'),
        'data: [DONE]\n\n',
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const output = await collect(
      streamChat({
        endpoint: '/llm/omniroute/chat/completions',
        apiKey: 'test-key',
        model: 'auto/best-chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(output).toBe('Hello world')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      model: 'auto/best-chat',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('throws the provider message for non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          statusText: 'Unauthorized',
        }),
      ),
    )

    await expect(
      collect(
        streamChat({
          endpoint: '/llm/omniroute/chat/completions',
          apiKey: 'bad',
          model: 'auto/best-chat',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow(
      /^Request failed \(401 Unauthorized\): invalid api key\. Check the API key in Settings\.$/,
    )
  })

  it('throws when the stream carries an error object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([delta('par'), `data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`]),
      ),
    )

    await expect(
      collect(
        streamChat({
          endpoint: '/llm/openai/chat/completions',
          apiKey: 'k',
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow('boom')
  })
})
