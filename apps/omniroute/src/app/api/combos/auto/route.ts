/**
 * Auto-Combo REST API — `/api/combos/auto`
 *
 * POST   — Create auto-combo
 * GET    — List all auto-combos
 *
 * Note: Auto-combo state is managed in-memory by the engine module.
 * The open-sse/services/autoCombo module is outside Next.js src/,
 * so we use a lightweight in-memory store here that mirrors the engine API.
 */

import { NextRequest, NextResponse } from "next/server";

// ── In-memory auto-combo store (mirrors open-sse/services/autoCombo/engine.ts) ──

interface ScoringWeights {
  quota: number;
  health: number;
  costInv: number;
  latencyInv: number;
  taskFit: number;
  stability: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  quota: 0.2,
  health: 0.25,
  costInv: 0.2,
  latencyInv: 0.15,
  taskFit: 0.1,
  stability: 0.1,
};

interface AutoComboConfig {
  id: string;
  name: string;
  type: "auto";
  candidatePool: string[];
  weights: ScoringWeights;
  modePack?: string;
  budgetCap?: number;
  explorationRate: number;
}

const autoCombos = new Map<string, AutoComboConfig>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, name, candidatePool, weights, modePack, budgetCap, explorationRate } = body;

    if (!id || !name) {
      return NextResponse.json({ error: "id and name required" }, { status: 400 });
    }

    const config: AutoComboConfig = {
      id,
      name,
      type: "auto",
      candidatePool: candidatePool || [],
      weights: weights || DEFAULT_WEIGHTS,
      modePack,
      budgetCap,
      explorationRate: explorationRate ?? 0.05,
    };
    autoCombos.set(id, config);

    return NextResponse.json(config, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ combos: [...autoCombos.values()] });
}
