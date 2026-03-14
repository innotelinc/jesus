"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Calendar } from "@/lib/jmap/types";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { useCalendarStore } from "@/stores/calendar-store";

interface CalendarSidebarPanelProps {
  calendars: Calendar[];
  selectedCalendarIds: string[];
  onToggleVisibility: (id: string) => void;
  onColorChange?: (calendarId: string, color: string) => void;
}

export function CalendarSidebarPanel({
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
  onColorChange,
}: CalendarSidebarPanelProps) {
  const t = useTranslations("calendar");
  const isSubscriptionCalendar = useCalendarStore((s) => s.isSubscriptionCalendar);

  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!colorPickerId) return;
    const handleClick = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColorPickerId(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [colorPickerId]);

  if (calendars.length === 0) return null;

  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
        {t("my_calendars")}
      </h3>
      <div className="space-y-0.5">
        {calendars.map((cal) => {
          const isVisible = selectedCalendarIds.includes(cal.id);
          const color = cal.color || "#3b82f6";

          return (
            <div key={cal.id} className="relative">
              <button
                onClick={() => onToggleVisibility(cal.id)}
                onContextMenu={(e) => {
                  if (onColorChange) {
                    e.preventDefault();
                    setColorPickerId(colorPickerId === cal.id ? null : cal.id);
                  }
                }}
                className={cn(
                  "flex items-center gap-2 w-full px-1.5 py-1 rounded-md text-sm transition-colors duration-150",
                  "hover:bg-muted"
                )}
              >
                <span
                  className={cn(
                    "w-3 h-3 rounded-sm border-2 flex-shrink-0 transition-colors",
                    isVisible ? "border-transparent" : "border-muted-foreground/40 bg-transparent"
                  )}
                  style={isVisible ? { backgroundColor: color, borderColor: color } : undefined}
                />
                <span className={cn("truncate", !isVisible && "text-muted-foreground")}>
                  {cal.name}
                </span>
                {isSubscriptionCalendar(cal.id) && (
                  <Globe className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                )}
              </button>

              {/* Color picker popover on right-click */}
              {colorPickerId === cal.id && onColorChange && (
                <div
                  ref={colorPickerRef}
                  className="absolute left-6 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-3 w-56"
                >
                  <p className="text-xs font-medium text-muted-foreground mb-2">{t("management.change_color")}</p>
                  <CalendarColorPicker
                    value={color}
                    onChange={(c) => {
                      onColorChange(cal.id, c);
                      setColorPickerId(null);
                    }}
                    allowCustom
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
