import { NextResponse } from "next/server";
import {
  getAllAliases,
  getCustomAliases,
  getBuiltInAliases,
  setCustomAliases,
  addCustomAlias,
  removeCustomAlias,
} from "@omniroute/open-sse/services/modelDeprecation.ts";
import { getSettings, updateSettings } from "@/lib/db/settings";

/**
 * GET /api/settings/model-aliases
 * Returns the full alias map, separated into built-in and custom.
 */
export async function GET() {
  try {
    return NextResponse.json({
      builtIn: getBuiltInAliases(),
      custom: getCustomAliases(),
      all: getAllAliases(),
    });
  } catch (error) {
    console.error("[API ERROR] /api/settings/model-aliases GET:", error);
    return NextResponse.json({ error: "Failed to get model aliases" }, { status: 500 });
  }
}

/**
 * PUT /api/settings/model-aliases
 * Update the custom aliases map.
 * Body: { aliases: { "old-model": "new-model", ... } }
 */
export async function PUT(request) {
  try {
    const { aliases } = await request.json();
    if (!aliases || typeof aliases !== "object") {
      return NextResponse.json({ error: "Missing or invalid 'aliases' object" }, { status: 400 });
    }
    setCustomAliases(aliases);
    await updateSettings({ modelAliases: JSON.stringify(aliases) });
    return NextResponse.json({ success: true, custom: getCustomAliases() });
  } catch (error) {
    console.error("[API ERROR] /api/settings/model-aliases PUT:", error);
    return NextResponse.json({ error: "Failed to update model aliases" }, { status: 500 });
  }
}

/**
 * POST /api/settings/model-aliases
 * Add a single custom alias.
 * Body: { from: "old-model", to: "new-model" }
 */
export async function POST(request) {
  try {
    const { from, to } = await request.json();
    if (!from || !to) {
      return NextResponse.json({ error: "Missing 'from' or 'to'" }, { status: 400 });
    }
    addCustomAlias(from, to);
    await updateSettings({ modelAliases: JSON.stringify(getCustomAliases()) });
    return NextResponse.json({ success: true, custom: getCustomAliases() });
  } catch (error) {
    console.error("[API ERROR] /api/settings/model-aliases POST:", error);
    return NextResponse.json({ error: "Failed to add alias" }, { status: 500 });
  }
}

/**
 * DELETE /api/settings/model-aliases
 * Remove a custom alias.
 * Body: { from: "old-model" }
 */
export async function DELETE(request) {
  try {
    const { from } = await request.json();
    if (!from) {
      return NextResponse.json({ error: "Missing 'from'" }, { status: 400 });
    }
    const removed = removeCustomAlias(from);
    if (!removed) {
      return NextResponse.json({ error: "Alias not found" }, { status: 404 });
    }
    await updateSettings({ modelAliases: JSON.stringify(getCustomAliases()) });
    return NextResponse.json({ success: true, custom: getCustomAliases() });
  } catch (error) {
    console.error("[API ERROR] /api/settings/model-aliases DELETE:", error);
    return NextResponse.json({ error: "Failed to remove alias" }, { status: 500 });
  }
}
