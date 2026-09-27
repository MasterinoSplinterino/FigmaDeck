/**
 * "No active slides": wireframe illustration, explanation and the "Add slides" button.
 */
import type { JSX } from 'preact';
import { t, tp } from '../i18n';

/** Slide frame with corner handles, an image block and three text lines over a fading grid. */
function Illustration(): JSX.Element {
  const grid: JSX.Element[] = [];
  // Grid pitch 16 (viewBox units), offset so lines pass near the frame edges.
  for (let x = 4; x <= 160; x += 16) grid.push(<line key={`v${x}`} x1={x} y1="0" x2={x} y2="144" />);
  for (let y = 2; y <= 144; y += 16) grid.push(<line key={`h${y}`} x1="0" y1={y} x2="160" y2={y} />);
  const corners: Array<[number, number]> = [
    [28, 34],
    [132, 34],
    [28, 110],
    [132, 110],
  ];
  return (
    <svg class="empty-art" width="160" height="144" viewBox="0 0 160 144" aria-hidden="true">
      <defs>
        <radialGradient id="fd-empty-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#fff" stop-opacity="1" />
          <stop offset="70%" stop-color="#fff" stop-opacity="0.55" />
          <stop offset="100%" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
        <mask id="fd-empty-mask">
          <rect x="0" y="0" width="160" height="144" fill="url(#fd-empty-fade)" />
        </mask>
      </defs>
      <g class="empty-grid" mask="url(#fd-empty-mask)">
        {grid}
      </g>
      <g class="empty-lines">
        <rect class="empty-slide" x="28" y="34" width="104" height="76" />
        <rect x="39" y="47" width="31" height="49" />
        <rect x="77" y="47" width="43" height="11" />
        <rect x="77" y="66" width="43" height="11" />
        <rect x="77" y="85" width="43" height="11" />
        {corners.map(([x, y]) => (
          <rect key={`${x}-${y}`} class="empty-handle" x={x - 2.5} y={y - 2.5} width="5" height="5" />
        ))}
      </g>
    </svg>
  );
}

export function EmptyState(props: { newFrames: number; allInDeck: boolean; onAdd: () => void }): JSX.Element {
  const disabled = props.newFrames === 0;
  const hint = props.allInDeck ? t('empty.hintAllInDeck') : t('empty.hintNoFrames');
  return (
    <div class="empty">
      <Illustration />
      <h1 class="empty-title">{t('empty.title')}</h1>
      <p class="empty-text">{t('empty.text')}</p>
      <button type="button" class="btn primary" disabled={disabled} onClick={props.onAdd} title={disabled ? hint : undefined}>
        {props.newFrames > 0 ? tp('add.buttonN', props.newFrames) : t('add.button')}
      </button>
      <p class={disabled ? 'empty-hint' : 'empty-hint hidden'} aria-live="polite">
        {hint}
      </p>
    </div>
  );
}
