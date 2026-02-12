import { useState } from 'react';
import { dashboardApiClient } from '../api/client';
import type { TaskAction } from '../types/dashboard';

interface TaskActionButtonsProps {
  entityId: string;
  entityType: 'run' | 'task';
  onDone?: () => Promise<void> | void;
}

const actions: TaskAction[] = ['pause', 'resume', 'retry', 'stop'];

export function TaskActionButtons({ entityId, entityType, onDone }: TaskActionButtonsProps) {
  const [busyAction, setBusyAction] = useState<TaskAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onAction = async (action: TaskAction) => {
    setBusyAction(action);
    setError(null);

    try {
      if (entityType === 'run') {
        await dashboardApiClient.runAction(entityId, action);
      } else {
        await dashboardApiClient.taskAction(entityId, action);
      }
      await onDone?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      setError(message);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="action-wrap">
      <div className="action-buttons">
        {actions.map((action) => (
          <button
            className="btn"
            disabled={busyAction !== null}
            key={action}
            onClick={() => void onAction(action)}
            type="button"
          >
            {busyAction === action ? `${action}...` : action}
          </button>
        ))}
      </div>
      {error ? <span className="error-text">{error}</span> : null}
    </div>
  );
}
