/**
 * UI entry point (bundled by scripts/build.mjs into dist/ui.html with CSS and JS inlined).
 */
import { render } from 'preact';
import { App } from './components/App';
import { getLang } from './i18n';
import './styles.css';

document.documentElement.lang = getLang();
const root = document.getElementById('app');
if (root) render(<App />, root);
