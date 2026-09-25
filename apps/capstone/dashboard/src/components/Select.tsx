import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/utils';

interface SelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Accessible name, for the callers whose visible label lives outside the control. */
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * The dashboard's dropdown.
 *
 * Deliberately not a native `<select>`: the option list of one is drawn by the
 * operating system, which does not read our theme, so on several platforms it
 * comes back a white sheet while the options keep the page's own text colour —
 * in dark mode that hides the thing being chosen until you hover it, which is
 * how a form looks broken rather than unstyled.
 *
 * Keyboard-first, which is the part a native select gave for free and this has
 * to keep: ↑/↓/Home/End move the active row, Enter/Space commit, Escape
 * dismisses, and focus stays on the trigger the whole time (the ARIA combobox
 * pattern, where `aria-activedescendant` points at the active option).
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  className,
  ariaLabel,
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const current = options.find(o => o.value === value);
  const selectedIndex = options.findIndex(o => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function openList() {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    // Focus stays on the trigger while the list is open, so every key lands here.
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(i => Math.min(i + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(active);
    }
  }

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors hover:border-primary focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={cn('truncate', current ? 'text-foreground' : 'text-muted-foreground')}>
          {current?.label ?? placeholder}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={listId} className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover py-1 shadow-lg animate-in" role="listbox" aria-label={ariaLabel}>
          {options.map((opt, index) => (
            <button
              key={opt.value}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              tabIndex={-1}
              className={cn(
                'flex w-full px-3 py-2 text-sm text-left transition-colors',
                opt.value === value ? 'bg-muted text-foreground' : index === active ? 'bg-muted/50' : 'hover:bg-muted/50',
              )}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
