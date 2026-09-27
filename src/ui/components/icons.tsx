/**
 * Inline SVG icons (16 × 16 viewBox, `currentColor`). No external resources.
 */
import type { JSX } from 'preact';

type IconProps = { size?: number; class?: string; title?: string };

function Svg(props: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      class={props.class ? `icon ${props.class}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.title ? undefined : 'true'}
      role={props.title ? 'img' : undefined}
    >
      {props.title ? <title>{props.title}</title> : <g />}
      {props.children}
    </svg>
  );
}

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 4.5L10 8l-3.5 3.5" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5l6 10.5H2L8 2.5z" />
    <path d="M8 6.5v3M8 11.25v.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 7.25V11M8 5v.01" />
  </Svg>
);

export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 8.2l1.7 1.7 3.3-3.6" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
    <path d="M10.5 5.5V4a1 1 0 00-1-1H4a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5v8M4.75 7.5L8 10.75l3.25-3.25M3 13.5h10" />
  </Svg>
);

export const IconReset = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5v3h3" />
    <path d="M3.9 9.5a4.5 4.5 0 101-4.6L3.5 6.5" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <path d="M6 12.5v1.5M10 12.5v1.5" />
  </Svg>
);

/** File-type badges for the export menu. */
export const IconFileSlides = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <rect x="5.75" y="7.25" width="5" height="3.5" rx="0.5" />
  </Svg>
);

export const IconFilePdf = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <path d="M6 11.5c1.5-1 2.8-3 3-5.25M6.5 9.5h4" />
  </Svg>
);

export const IconFileCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <path d="M7 8l-1.25 1.5L7 11M9.5 8l1.25 1.5L9.5 11" />
  </Svg>
);

/** A file with a picture: the "images (JPEG)" export targets. */
export const IconFileImage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
    <circle cx="6.9" cy="7.4" r="0.9" />
    <path d="M4.25 12.75L7.75 9.5l1.5 1.4 1.25-1.15 2 1.85" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <circle cx="6" cy="6.5" r="1.1" />
    <path d="M13.5 10.5L10.5 7.5 4 13" />
  </Svg>
);

/** Resize grip (bottom-right corner). */
export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 7l-6 6M13 10.5L10.5 13" />
  </Svg>
);
