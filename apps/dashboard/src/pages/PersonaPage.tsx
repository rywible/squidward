import { dashboardApiClient } from '../api/client';
import { PageState } from '../components/PageState';
import { usePollingQuery } from '../hooks/usePollingQuery';

export function PersonaPage() {
  const { data, error, loading, refreshing, refresh } = usePollingQuery(
    (signal) => dashboardApiClient.getPersona(signal),
    5000,
  );

  return (
    <section>
      <h2>Persona</h2>
      <PageState error={error} loading={loading} onRefresh={() => void refresh()} refreshing={refreshing} />

      <div className="table-wrap panel">
        <table>
          <thead>
            <tr>
              <th>Trait</th>
              <th>Value</th>
              <th>Confidence</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((trait) => (
              <tr key={trait.name}>
                <td>{trait.name}</td>
                <td>{trait.value}</td>
                <td>{Math.round(trait.confidence * 100)}%</td>
                <td>{trait.source}</td>
                <td>{new Date(trait.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
