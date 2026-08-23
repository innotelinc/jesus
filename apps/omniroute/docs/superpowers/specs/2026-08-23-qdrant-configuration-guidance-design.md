# Qdrant Configuration Guidance Design

## Goal

Make the Memory > Engine > Qdrant experience explain what Qdrant does, guide users through a safe configuration, and verify that the selected Qdrant collection accepts embeddings produced by the configured OmniRoute model before Qdrant is enabled.

## Scope

- Add a concise, localized explanation that Qdrant stores semantic-memory vectors for relevant-context retrieval. It is not a token compressor; token savings are indirect and depend on less irrelevant context being injected.
- Add a configuration checklist covering a protected Qdrant endpoint, host/port, collection, embedding provider/model, matching vector dimensions, connection test, and search test.
- Extend the authenticated Qdrant health route to inspect the configured collection without creating, updating, searching, or deleting points. Return the collection vector dimension and a clear state when the collection is absent or uses named vectors.
- Show a pre-enable compatibility result in the Qdrant card. If the endpoint is reachable but the vector dimension cannot be determined from the selected embedding model, the UI must explain that the search test is the authoritative end-to-end validation. If dimensions differ, the UI must block enabling and explain how to create a compatible collection.
- Keep the existing behavior that initial writes create a missing collection using the embedding dimension detected from the first successful embedding.

## User Flow

1. The user opens Dashboard > Memory > Engine and reads the purpose and prerequisites.
2. The user enters Qdrant host, port, collection, optional API key, and an embedding provider/model with a configured provider credential.
3. The user saves settings and clicks Test connection.
4. The health result reports endpoint status and, for an existing collection, its vector dimensions and named-vector configuration.
5. The user runs Test search. This generates an embedding through OmniRoute and proves that the model dimension matches the collection and that retrieval works.
6. The Enable control remains unavailable after a known incompatibility; otherwise it follows the existing setting update path, which sets `memoryVectorStore` to `qdrant`.

## Collection Creation Guidance

The UI will provide copyable Qdrant REST guidance, using a placeholder dimension rather than assuming one for every model:

```json
PUT /collections/<collection>
{
  "vectors": { "size": <embedding-dimension>, "distance": "Cosine" }
}
```

For the audited server, the existing `omniroute_memory` collection has a named 2048-dimensional vector. It must be paired with the same 2048-dimensional embedding model that created it. The default `openai/text-embedding-3-small` emits 1536-dimensional vectors and therefore requires a separate 1536-dimensional collection.

## API Contract

`GET /api/settings/qdrant/health` will retain `{ ok, latencyMs, error? }` and add optional read-only metadata:

```ts
{
  collection?: {
    exists: boolean;
    vectorSize?: number;
    vectorName?: string | null;
  };
}
```

The route must never expose Qdrant API keys. It must sanitize upstream error text before returning it.

## Error Handling

- A disconnected endpoint remains an error result, without changing settings.
- A missing collection is guidance, not an error: OmniRoute creates it on the first successful Qdrant write.
- A known dimension mismatch blocks enabling and tells the user to choose a matching model or a separate collection.
- A model whose dimension cannot be determined does not claim compatibility; the user must run Test search.

## Testing

- Route tests cover health metadata for single-vector, named-vector, missing-collection, and sanitized upstream-error responses.
- Component tests cover the purpose explanation, checklist, compatible/mismatch/missing collection states, and disabled enable action on a mismatch.
- Existing Qdrant route and card tests remain green.
