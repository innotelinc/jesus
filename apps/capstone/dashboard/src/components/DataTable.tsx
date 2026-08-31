import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface DataTableProps {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
  rows: Array<Record<string, ReactNode>>;
  className?: string;
  selectable?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}

export default function DataTable({ columns, rows, className, selectable = false, selectedIds = [], onSelectionChange }: DataTableProps) {
  const handleRowSelect = (id: string, checked: boolean) => {
    if (!onSelectionChange) return;
    if (checked) {
      onSelectionChange([...selectedIds.filter(i => i !== id), id]);
    } else {
      onSelectionChange(selectedIds.filter(i => i !== id));
    }
  };

  return (
    <div className={cn('border rounded-xl bg-card shadow-sm overflow-hidden', className)}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b bg-muted/30">
            {selectable && (
              <th className="w-10 px-3 py-3 text-left">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border input accent-primary"
                  checked={selectedIds.length === rows.length}
                  onChange={e => {
                    if (e.target.checked) {
                      onSelectionChange?.(rows.map(r => String(r.id ?? '')));
                    } else {
                      onSelectionChange?.([]);
                    }
                  }}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map(col => (
              <th key={col.key} className={cn('px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground', col.align === 'right' && 'text-right')}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(row => {
            const id = String(row.id ?? '');
            const selected = selectedIds.includes(id);
            return (
              <tr key={id} className="hover:bg-muted/40 transition-colors">
                {selectable && (
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border input accent-primary"
                      checked={selected}
                      onChange={e => handleRowSelect(id, e.target.checked)}
                      aria-label={`Select row ${id}`}
                    />
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key} className={cn('px-4 py-3 text-sm', col.align === 'right' && 'text-right')}>
                    {row[col.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
