import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  isValidationFailure,
  updateResilienceSchema,
  validateBody,
} from "@/shared/validation/schemas";

/**
 * GET /api/resilience — Get current resilience configuration and status
 */
export async function GET() {
  try {
    // Dynamic imports for open-sse modules
    const { getAllCircuitBreakerStatuses } =
      await import("@/../../src/shared/utils/circuitBreaker");
    const { getAllRateLimitStatus } = await import("@omniroute/open-sse/services/rateLimitManager");
    const { PROVIDER_PROFILES, DEFAULT_API_LIMITS } =
      await import("@omniroute/open-sse/config/constants");

    const settings = await getSettings();
    const circuitBreakers = getAllCircuitBreakerStatuses();
    const rateLimitStatus = getAllRateLimitStatus();

    return NextResponse.json({
      profiles: settings.providerProfiles || PROVIDER_PROFILES,
      defaults: { ...DEFAULT_API_LIMITS, ...(settings.rateLimitDefaults || {}) },
      circuitBreakers,
      rateLimitStatus,
    });
  } catch (err) {
    console.error("[API] GET /api/resilience error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to load resilience status" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/resilience — Update provider resilience profiles and/or rate limit defaults
 */
export async function PATCH(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(updateResilienceSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { profiles, defaults } = validation.data;

    const updates: Record<string, any> = {};
    if (profiles) updates.providerProfiles = profiles;
    if (defaults) updates.rateLimitDefaults = defaults;

    await updateSettings(updates);

    return NextResponse.json({
      ok: true,
      ...(profiles ? { profiles } : {}),
      ...(defaults ? { defaults } : {}),
    });
  } catch (err) {
    console.error("[API] PATCH /api/resilience error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to save resilience settings" },
      { status: 500 }
    );
  }
}
