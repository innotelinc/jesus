import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export default function Tooltip({ content, children, position = 'top', className }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <div className={cn('relative inline-block', className)} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      {children}
      {show && (
        <div
          className={cn(
            'absolute z-50 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs shadow-md animate-in',
            position === 'bottom' && '-translate-y-full translate-y-1',
            position === 'left' && '-translate-x-full -translate-y-1/2',
            position === 'right' && 'translate-x-1 -translate-y-1/2',
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}
