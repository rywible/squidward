interface PageStateProps {
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export function PageState({ loading, error, refreshing, onRefresh }: PageStateProps) {
  if (loading) {
    return <div className="panel">Loading...</div>;
  }

  if (error) {
    return (
      <div className="panel error-panel">
        <p>Failed to load data: {error}</p>
        <button className="btn" onClick={onRefresh} type="button">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="state-row">
      {refreshing ? <span className="muted">Refreshing...</span> : <span className="muted">Updated live</span>}
      <button className="btn ghost" onClick={onRefresh} type="button">
        Refresh now
      </button>
    </div>
  );
}
