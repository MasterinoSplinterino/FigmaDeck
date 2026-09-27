/**
 * UI entry point (bundled by scripts/build.mjs into dist/ui.html with CSS and JS inlined).
 */
import { render } from 'preact';
import { CONFIG } from '../config';
import { App } from './components/App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getLang } from './i18n';
import './styles.css';

document.title = CONFIG.meta.productName;
document.documentElement.lang = getLang();
const root = document.getElementById('app');
if (root)
  render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
    root,
  );
