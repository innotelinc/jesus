"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Shield, Mail, X, AlertTriangle, Trophy, RotateCcw, Inbox, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const GAME_WIDTH = 400;
const GAME_HEIGHT = 520;
const FORTRESS_Y = GAME_HEIGHT - 48;
const SPAWN_INTERVAL_START = 850;
const SPAWN_INTERVAL_MIN = 320;
const GAME_DURATION = 30;
const ENEMY_SPEED_START = 1.2;
const ENEMY_SPEED_INCREASE = 0.04;

interface Enemy {
  id: number;
  x: number;
  y: number;
  speed: number;
  type: "spam" | "phishing" | "legit";
}

type GameState = "idle" | "playing" | "won" | "lost";

export function SpamSiegeGame({ onClose }: { onClose: () => void }) {
  const [gameState, setGameState] = useState<GameState>("idle");
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [shieldHealth, setShieldHealth] = useState(3);
  const [hitEffects, setHitEffects] = useState<{ id: number; x: number; y: number; color: string }[]>([]);
  const [destroyEffects, setDestroyEffects] = useState<{ id: number; x: number; y: number }[]>([]);
  const [deliverEffects, setDeliverEffects] = useState<{ id: number; x: number; y: number }[]>([]);
  const nextId = useRef(0);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const spawnTimerRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>("idle");
  const elapsedRef = useRef(0);
  const destroyedRef = useRef(new Set<number>());

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const startGame = useCallback(() => {
    setGameState("playing");
    setEnemies([]);
    setScore(0);
    setTimeLeft(GAME_DURATION);
    setShieldHealth(3);
    setHitEffects([]);
    setDestroyEffects([]);
    setDeliverEffects([]);
    nextId.current = 0;
    spawnTimerRef.current = 0;
    elapsedRef.current = 0;
    destroyedRef.current = new Set();
    lastTimeRef.current = performance.now();
  }, []);

  const spawnEnemy = useCallback(() => {
    const id = nextId.current++;
    const rand = Math.random();
    const type = rand > 0.7 ? "legit" : rand > 0.45 ? "phishing" : "spam";
    const x = 20 + Math.random() * (GAME_WIDTH - 60);
    const elapsed = elapsedRef.current;
    const speed = ENEMY_SPEED_START + (elapsed / 1000) * ENEMY_SPEED_INCREASE;
    setEnemies((prev) => [...prev, { id, x, y: -30, speed, type }]);
  }, []);

  const handleHover = useCallback((enemy: Enemy) => {
    if (destroyedRef.current.has(enemy.id)) return;
    destroyedRef.current.add(enemy.id);

    if (enemy.type === "legit") {
      // Penalty for blocking legit mail
      setShieldHealth((prev) => {
        const nh = prev - 1;
        if (nh <= 0) setGameState("lost");
        return Math.max(0, nh);
      });
      setScore((prev) => Math.max(0, prev - 15));
      const effectId = nextId.current++;
      setHitEffects((p) => [...p, { id: effectId, x: enemy.x, y: enemy.y, color: "rgba(34, 197, 94, 0.5)" }]);
      setTimeout(() => setHitEffects((p) => p.filter((h) => h.id !== effectId)), 500);
    } else {
      setScore((prev) => prev + 10);
      const effectId = nextId.current++;
      setDestroyEffects((prev) => [...prev, { id: effectId, x: enemy.x, y: enemy.y }]);
      setTimeout(() => setDestroyEffects((prev) => prev.filter((e) => e.id !== effectId)), 400);
    }

    setEnemies((prev) => prev.filter((e) => e.id !== enemy.id));
  }, []);

  // Game loop
  useEffect(() => {
    if (gameState !== "playing") return;

    const tick = (now: number) => {
      if (gameStateRef.current !== "playing") return;

      const dt = now - lastTimeRef.current;
      lastTimeRef.current = now;
      elapsedRef.current += dt;

      // Timer
      const newTimeLeft = GAME_DURATION - Math.floor(elapsedRef.current / 1000);
      setTimeLeft(Math.max(0, newTimeLeft));
      if (newTimeLeft <= 0) {
        setGameState("won");
        return;
      }

      // Spawn
      spawnTimerRef.current += dt;
      const spawnInterval = Math.max(
        SPAWN_INTERVAL_MIN,
        SPAWN_INTERVAL_START - (elapsedRef.current / 1000) * 35
      );
      if (spawnTimerRef.current >= spawnInterval) {
        spawnTimerRef.current = 0;
        spawnEnemy();
      }

      // Move enemies
      setEnemies((prev) => {
        const next: Enemy[] = [];
        let spamBreached = false;
        for (const e of prev) {
          const ny = e.y + e.speed * (dt / 16);
          if (ny >= FORTRESS_Y) {
            if (e.type === "legit") {
              // Legit mail delivered — bonus
              setScore((s) => s + 5);
              const effectId = nextId.current++;
              setDeliverEffects((p) => [...p, { id: effectId, x: e.x, y: FORTRESS_Y }]);
              setTimeout(() => setDeliverEffects((p) => p.filter((d) => d.id !== effectId)), 500);
            } else {
              spamBreached = true;
              const effectId = nextId.current++;
              setHitEffects((p) => [...p, { id: effectId, x: e.x, y: FORTRESS_Y, color: "rgba(219, 45, 84, 0.3)" }]);
              setTimeout(() => setHitEffects((p) => p.filter((h) => h.id !== effectId)), 500);
            }
          } else {
            next.push({ ...e, y: ny });
          }
        }
        if (spamBreached) {
          setShieldHealth((prev) => {
            const nh = prev - 1;
            if (nh <= 0) setGameState("lost");
            return Math.max(0, nh);
          });
        }
        return next;
      });

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [gameState, spawnEnemy]);

  const getEnemyStyle = (type: Enemy["type"]) => {
    switch (type) {
      case "phishing":
        return { bg: "rgba(234, 179, 8, 0.15)", border: "rgba(234, 179, 8, 0.4)", color: "rgb(234, 179, 8)" };
      case "legit":
        return { bg: "rgba(34, 197, 94, 0.12)", border: "rgba(34, 197, 94, 0.4)", color: "rgb(34, 197, 94)" };
      default:
        return { bg: "rgba(219, 45, 84, 0.1)", border: "rgba(219, 45, 84, 0.3)", color: "rgb(219, 45, 84)" };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative rounded-xl border border-border bg-card shadow-2xl overflow-hidden select-none"
        style={{ width: GAME_WIDTH, maxWidth: "95vw" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4" style={{ color: "rgb(219, 45, 84)" }} />
            <span className="text-sm font-semibold text-foreground">Spam Siege</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* HUD */}
        <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border-b border-border text-xs">
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">Score: <span className="font-semibold text-foreground">{score}</span></span>
            <span className="text-muted-foreground">Time: <span className="font-semibold text-foreground">{timeLeft}s</span></span>
          </div>
          <div className="flex items-center gap-1">
            {[...Array(3)].map((_, i) => (
              <Shield
                key={i}
                className="w-3.5 h-3.5 transition-colors"
                style={{ color: i < shieldHealth ? "rgb(219, 45, 84)" : "rgb(100, 100, 100)" }}
                fill={i < shieldHealth ? "rgb(219, 45, 84)" : "none"}
                strokeWidth={i < shieldHealth ? 0 : 1.5}
              />
            ))}
          </div>
        </div>

        {/* Game area */}
        <div
          className="relative bg-background overflow-hidden"
          style={{ height: GAME_HEIGHT }}
        >
          {/* Grid lines for depth */}
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: "linear-gradient(to bottom, currentColor 1px, transparent 1px), linear-gradient(to right, currentColor 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }} />

          {/* Fortress wall */}
          <div className="absolute left-0 right-0 bottom-0 flex flex-col items-center" style={{ height: GAME_HEIGHT - FORTRESS_Y }}>
            <div className="relative w-full">
              {/* Shield centered above the line */}
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 z-10">
                <Shield
                  className="w-7 h-7 drop-shadow-sm"
                  style={{ color: shieldHealth > 0 ? "rgb(219, 45, 84)" : "rgb(100, 100, 100)" }}
                  fill={shieldHealth > 0 ? "rgba(219, 45, 84, 0.2)" : "none"}
                />
              </div>
              {/* Solid line */}
              <div
                className="h-[2px] w-full"
                style={{ backgroundColor: shieldHealth > 0 ? "rgba(219, 45, 84, 0.35)" : "rgba(100, 100, 100, 0.3)" }}
              />
            </div>
            {/* Subtle gradient fill below */}
            <div
              className="flex-1 w-full"
              style={{
                background: shieldHealth > 0
                  ? "linear-gradient(to bottom, rgba(219, 45, 84, 0.06), transparent)"
                  : "linear-gradient(to bottom, rgba(100, 100, 100, 0.04), transparent)",
              }}
            />
          </div>

          {/* Enemies */}
          {enemies.map((e) => {
            const style = getEnemyStyle(e.type);
            return (
              <div
                key={e.id}
                className="absolute flex items-center justify-center w-8 h-8 rounded-md transition-transform"
                style={{
                  left: e.x,
                  top: e.y,
                  backgroundColor: style.bg,
                  border: `1px solid ${style.border}`,
                }}
                onMouseEnter={() => handleHover(e)}
              >
                {e.type === "phishing" ? (
                  <AlertTriangle className="w-4 h-4" style={{ color: style.color }} />
                ) : e.type === "legit" ? (
                  <MailCheck className="w-4 h-4" style={{ color: style.color }} />
                ) : (
                  <Mail className="w-4 h-4" style={{ color: style.color }} />
                )}
              </div>
            );
          })}

          {/* Destroy effects */}
          {destroyEffects.map((e) => (
            <div
              key={e.id}
              className="absolute pointer-events-none animate-ping"
              style={{ left: e.x + 4, top: e.y + 4 }}
            >
              <X className="w-5 h-5 text-muted-foreground/50" />
            </div>
          ))}

          {/* Deliver effects (legit mail arrived) */}
          {deliverEffects.map((e) => (
            <div
              key={e.id}
              className="absolute pointer-events-none animate-ping"
              style={{ left: e.x + 4, top: e.y - 8 }}
            >
              <Inbox className="w-5 h-5" style={{ color: "rgb(34, 197, 94)" }} />
            </div>
          ))}

          {/* Hit effects on fortress */}
          {hitEffects.map((e) => (
            <div
              key={e.id}
              className="absolute pointer-events-none"
              style={{ left: e.x, top: e.y - 10 }}
            >
              <div className="w-6 h-6 rounded-full animate-ping" style={{ backgroundColor: e.color }} />
            </div>
          ))}

          {/* Idle overlay */}
          {gameState === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/80">
              <Shield className="w-14 h-14" style={{ color: "rgb(219, 45, 84)" }} fill="rgba(219, 45, 84, 0.1)" />
              <div className="text-center">
                <p className="text-base font-semibold text-foreground">Spam Siege</p>
                <p className="text-xs text-muted-foreground mt-1.5 max-w-[280px] leading-relaxed">
                  Hover over threats to block them. Let legitimate mail through. Survive {GAME_DURATION} seconds.
                </p>
                <div className="flex items-center justify-center gap-4 mt-3 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Mail className="w-3 h-3" style={{ color: "rgb(219, 45, 84)" }} /> Spam
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" style={{ color: "rgb(234, 179, 8)" }} /> Phishing
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MailCheck className="w-3 h-3" style={{ color: "rgb(34, 197, 94)" }} /> Legit
                  </span>
                </div>
              </div>
              <Button size="sm" onClick={startGame} className="mt-1 text-white" style={{ backgroundColor: "rgb(219, 45, 84)" }}>
                <Shield className="w-3.5 h-3.5 mr-1.5" />
                Defend
              </Button>
            </div>
          )}

          {/* Won overlay */}
          {gameState === "won" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/80">
              <Trophy className="w-14 h-14" style={{ color: "rgb(219, 45, 84)" }} />
              <div className="text-center">
                <p className="text-base font-semibold text-foreground">Fortress Secured</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Score: <span className="font-semibold text-foreground">{score}</span>
                </p>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button size="sm" onClick={startGame} className="text-white" style={{ backgroundColor: "rgb(219, 45, 84)" }}>
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  Again
                </Button>
              </div>
            </div>
          )}

          {/* Lost overlay */}
          {gameState === "lost" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/80">
              <Shield className="w-14 h-14 text-muted-foreground/40" />
              <div className="text-center">
                <p className="text-base font-semibold text-foreground">Fortress Breached</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Score: <span className="font-semibold text-foreground">{score}</span>
                </p>
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button size="sm" onClick={startGame} className="text-white" style={{ backgroundColor: "rgb(219, 45, 84)" }}>
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  Retry
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
