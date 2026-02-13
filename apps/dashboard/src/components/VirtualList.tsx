import { useMemo, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  maxHeight?: number;
  overscan?: number;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
}

export function VirtualList<T>({
  items,
  rowHeight,
  maxHeight = 620,
  overscan = 4,
  className,
  renderItem,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const totalHeight = items.length * rowHeight;
  const viewportHeight = Math.min(maxHeight, Math.max(rowHeight * 3, totalHeight));

  const { startIndex, endIndex, offsetY } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    const end = Math.min(items.length, start + visibleCount);
    return {
      startIndex: start,
      endIndex: end,
      offsetY: start * rowHeight,
    };
  }, [items.length, overscan, rowHeight, scrollTop, viewportHeight]);

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      className={className}
      style={{ maxHeight: `${viewportHeight}px`, overflowY: totalHeight > viewportHeight ? 'auto' : 'hidden' }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map((item, index) => (
            <div key={startIndex + index} style={{ minHeight: `${rowHeight}px` }}>
              {renderItem(item, startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
