import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';

export function RouteSkeleton() {
  return (
    <section>
      <Card className="panel">
        <CardHeader>
          <CardTitle>Loading route</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </CardContent>
      </Card>
    </section>
  );
}
