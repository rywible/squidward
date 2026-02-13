import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';

interface PageStateProps {
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export function PageState({ loading, error, refreshing, onRefresh }: PageStateProps) {
  if (loading) {
    return (
      <Card className="panel">
        <CardHeader>
          <CardTitle>Loading data</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="muted">Pulling latest telemetry from Squidward services.</p>
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="panel error-panel">
        <CardHeader>
          <CardTitle>Failed to load dashboard data</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{error}</p>
          <Button className="mt-3" onClick={onRefresh} type="button">
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="state-row">
      <span className="muted">{refreshing ? 'Refreshing...' : 'Updated live'}</span>
      <Button onClick={onRefresh} type="button" variant="ghost" size="sm">
        Refresh now
      </Button>
    </div>
  );
}
