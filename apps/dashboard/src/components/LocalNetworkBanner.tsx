import { cn } from '../lib/cn';
import { Badge } from './ui/badge';

interface LocalNetworkBannerProps {
  compact?: boolean;
}

export function LocalNetworkBanner({ compact = false }: LocalNetworkBannerProps) {
  return (
    <aside className={cn('local-network-banner', compact && 'compact')} role="note" aria-label="Local network only">
      <div className="local-network-banner__head">
        <strong>Local Network Only</strong>
        <Badge variant="warning">Restricted</Badge>
      </div>
      {!compact ? <span>This dashboard is intended for trusted LAN access only.</span> : null}
    </aside>
  );
}
