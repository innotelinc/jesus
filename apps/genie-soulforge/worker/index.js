/**
 * Hosted build for Soulforge.
 *
 * Static assets are served by the ASSETS binding. The three `/llm/*` prefixes
 * mirror the Vite dev proxy in vite.config.ts so the browser can reach providers
 * that do not send CORS headers. The visitor's own API key is relayed straight
 * through — nothing is stored and no key lives on the server.
 */

const ROUTES = [
  {
    prefix: '/llm/omniroute',
    target: 'https://gateway.innotel.us',
    rewrite: (path) => path.replace(/^\/llm\/omniroute/, '/v1'),
  },
  {
    prefix: '/llm/openrouter',
    target: 'https://openrouter.ai',
    rewrite: (path) => path.replace(/^\/llm\/openrouter/, '/api/v1'),
  },
  {
    prefix: '/llm/openai',
    target: 'https://api.openai.com',
    rewrite: (path) => path.replace(/^\/llm\/openai/, '/v1'),
  },
]

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const route = ROUTES.find(
      (entry) => url.pathname === entry.prefix || url.pathname.startsWith(`${entry.prefix}/`),
    )
    if (!route) return env.ASSETS.fetch(request)

    // Same-origin only: browsers cannot forge Origin, so this keeps the proxy
    // from being used as an open relay by other sites.
    if (request.headers.get('Origin') !== url.origin) {
      return errorResponse(403, 'This proxy only accepts same-origin requests from Soulforge.')
    }
    if (request.method !== 'POST') {
      return errorResponse(405, 'Use POST for chat completions.')
    }

    const headers = new Headers()
    headers.set('content-type', request.headers.get('content-type') || 'application/json')
    headers.set('accept', 'text/event-stream')
    headers.set('x-title', request.headers.get('x-title') || 'Soulforge')

    const authorization = request.headers.get('authorization')
    if (authorization) headers.set('authorization', authorization)

    let upstream
    try {
      upstream = await fetch(route.target + route.rewrite(url.pathname) + url.search, {
        method: 'POST',
        headers,
        body: request.body,
        redirect: 'manual',
      })
    } catch (error) {
      return errorResponse(502, `Could not reach the provider: ${error && error.message}`)
    }

    // Stream the body through untouched so SSE deltas arrive as they are produced.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    })
  },
}
