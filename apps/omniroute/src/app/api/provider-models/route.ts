import {
  getCustomModels,
  getAllCustomModels,
  addCustomModel,
  removeCustomModel,
} from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { jwtVerify } from "jose";
import { cookies } from "next/headers";

/**
 * Verify authentication - check API key or JWT cookie
 */
async function verifyAuth(request) {
  // Check API key (for external clients)
  const apiKey = extractApiKey(request);
  if (apiKey && (await isValidApiKey(apiKey))) {
    return true;
  }

  // Check JWT cookie (for dashboard session)
  if (process.env.JWT_SECRET) {
    try {
      const cookieStore = await cookies();
      const token = cookieStore.get("auth_token")?.value;
      if (token) {
        const secret = new TextEncoder().encode(process.env.JWT_SECRET);
        await jwtVerify(token, secret);
        return true;
      }
    } catch {
      // Invalid/expired token or cookies not available
    }
  }

  return false;
}

/**
 * GET /api/provider-models?provider=<id>
 * List custom models (all providers if no provider param)
 */
export async function GET(request) {
  try {
    // Require authentication for security
    if (!(await verifyAuth(request))) {
      return Response.json(
        { error: { message: "Authentication required", type: "invalid_api_key" } },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");

    const models = provider ? await getCustomModels(provider) : await getAllCustomModels();

    return Response.json({ models });
  } catch (error) {
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}

/**
 * POST /api/provider-models
 * Body: { provider, modelId, modelName? }
 */
export async function POST(request) {
  try {
    // Require authentication for security
    if (!(await verifyAuth(request))) {
      return Response.json(
        { error: { message: "Authentication required", type: "invalid_api_key" } },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { provider, modelId, modelName, source } = body;

    if (!provider || !modelId) {
      return Response.json(
        { error: { message: "provider and modelId are required", type: "validation_error" } },
        { status: 400 }
      );
    }

    const model = await addCustomModel(provider, modelId, modelName, source || "manual");
    return Response.json({ model });
  } catch (error) {
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/provider-models?provider=<id>&model=<modelId>
 */
export async function DELETE(request) {
  try {
    // Require authentication for security
    if (!(await verifyAuth(request))) {
      return Response.json(
        { error: { message: "Authentication required", type: "invalid_api_key" } },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const modelId = searchParams.get("model");

    if (!provider || !modelId) {
      return Response.json(
        {
          error: {
            message: "provider and model query params are required",
            type: "validation_error",
          },
        },
        { status: 400 }
      );
    }

    const removed = await removeCustomModel(provider, modelId);
    return Response.json({ removed });
  } catch (error) {
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
