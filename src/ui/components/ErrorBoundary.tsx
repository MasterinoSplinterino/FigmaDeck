/**
 * Full-window status screens: `StatusScreen` (title, one sentence, "Try again") and the error boundary
 * around the whole UI — a render error shows "Something went wrong" instead of a blank window, and
 * "Try again" mounts the UI afresh (it asks main for `init` again).
 */
import { Component, Fragment, type ComponentChildren, type JSX } from 'preact';
import { t } from '../i18n';
import { IconWarning } from './icons';

export function StatusScreen(props: { title: string; text: string; onRetry: () => void }): JSX.Element {
  return (
    <div class="status-screen" role="alert">
      <IconWarning size={24} />
      <h1 class="status-title">{props.title}</h1>
      <p class="status-text">{props.text}</p>
      <button type="button" class="btn primary" onClick={props.onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}

interface BoundaryState {
  failed: boolean;
  /** Bumped by "Try again": the children are mounted as new components. */
  attempt: number;
}

export class ErrorBoundary extends Component<{ children: ComponentChildren }, BoundaryState> {
  override state: BoundaryState = { failed: false, attempt: 0 };

  static override getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override render(): JSX.Element {
    if (this.state.failed) {
      return (
        <div class="app">
          <StatusScreen title={t('crash.title')} text={t('crash.text')} onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} />
        </div>
      );
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
