import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";

export async function GET() {
  try {
    const settings = await getSettings();
    const requireLogin = settings.requireLogin !== false;
    return NextResponse.json({ requireLogin });
  } catch (error) {
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}

/**
 * POST /api/settings/require-login — Set password and/or toggle requireLogin.
 * Used by the onboarding wizard security step.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { requireLogin, password } = body;

    const updates: Record<string, any> = {};

    if (typeof requireLogin === "boolean") {
      updates.requireLogin = requireLogin;
    }

    if (password && typeof password === "string" && password.length >= 4) {
      const hashedPassword = await bcrypt.hash(password, 12);
      updates.password = hashedPassword;
    } else if (password) {
      return NextResponse.json(
        { error: "Password must be at least 4 characters" },
        { status: 400 }
      );
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    await updateSettings(updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] Error updating require-login settings:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update settings" },
      { status: 500 }
    );
  }
}
