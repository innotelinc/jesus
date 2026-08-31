import { useState, useRef, useEffect } from 'react';
import { cn } from '../lib/utils';

interface SelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export default function Select({ value, options, onChange, placeholder = 'Select...', className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = options.find(o => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm transition-colors hover:border-primary focus:border-primary focus:outline-none"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={cn(current ? 'text-foreground' : 'text-muted-foreground')}>{current?.label ?? placeholder}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-muted-foreground transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover py-1 shadow-lg animate-in" role="listbox">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={cn('flex w-full px-3 py-2 text-sm text-left transition-colors', opt.value === value ? 'bg-muted text-foreground' : 'hover:bg-muted/50')}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={opt.value === value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
