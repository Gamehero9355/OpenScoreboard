/**
 * Miniatures of the display screens.
 *
 * The six screens a projector can be switched to are named after what they
 * are: "Tabellen", "Spielplan", "Spielstand". A volunteer who has never run
 * this app reads those names and still cannot tell the tables from the
 * running order, so the picker has to show the screens rather than name them.
 *
 * Each miniature is a wireframe of the screen it stands for, drawn in the
 * tile's own colour: the two score panels of the board, the wide slab of the
 * pause notice, the club crest, the clock face, the table with its header
 * band, the running list with its result boxes. The silhouettes are drawn to
 * stay apart from one another at 46 pixels wide, because that is all the room
 * a tile in the host's side rail has.
 */
import type { DisplayScreen } from '../../shared/types';

/** The wireframe box every miniature is drawn in: a projector is wider than tall. */
const VIEW_W = 48;
const VIEW_H = 32;

/**
 * One miniature.
 *
 * `width` is the rendered width; the height follows the projector shape. The
 * drawing inherits `currentColor` so the tile decides the ink: dim on a resting
 * tile, the brand's own ink on the selected one.
 */
export function ScreenPreview({ screen, width = 46 }: { screen: DisplayScreen; width?: number }) {
  const height = Math.round((width * VIEW_H) / VIEW_W);
  return (
    <svg
      className="screen-preview"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={width}
      height={height}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      {shapes(screen)}
    </svg>
  );
}

function shapes(screen: DisplayScreen) {
  switch (screen) {
    /* The board: a clock on top, then one panel per team with the score in it. */
    case 'scores':
      return (
        <g>
          <rect x="19.5" y="1" width="9" height="3.5" rx="1.75" fill="currentColor" opacity="0.8" />
          <rect x="3" y="7" width="17.5" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="6" y="10" width="11.5" height="12" rx="1.5" fill="currentColor" />
          <rect x="27.5" y="7" width="17.5" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="30" y="10" width="11.5" height="12" rx="1.5" fill="currentColor" />
        </g>
      );

    /* The pause notice: one wide statement and a quieter line under it. */
    case 'pause':
      return (
        <g>
          <rect x="6" y="8" width="36" height="9" rx="2" fill="currentColor" />
          <rect x="15" y="21" width="18" height="3.5" rx="1.75" fill="currentColor" opacity="0.55" />
        </g>
      );

    /* The club crest: a shield. */
    case 'logo':
      return (
        <path
          d="M24 2.5 38.5 8v11.5C38.5 26 32 29.5 24 31 16 29.5 9.5 26 9.5 19.5V8Z"
          fill="currentColor"
        />
      );

    /* The wall clock: a face with two hands. */
    case 'clock':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="24" cy="16" r="12.5" />
          <path d="M24 16v-7.5" />
          <path d="m24 16 6 3" />
        </g>
      );

    /* The tables: a filled header band, then a ranked row per team. */
    case 'standings':
      return (
        <g>
          <rect x="2.5" y="3" width="43" height="5" rx="1.5" fill="currentColor" />
          {[12.5, 19, 25.5].map((y) => (
            <g key={y}>
              <rect x="3.5" y={y} width="4.5" height="4.5" rx="1" fill="currentColor" />
              <rect x="12" y={y + 1.2} width="17" height="2.4" rx="1.2" fill="currentColor" opacity="0.6" />
              <rect x="33" y={y + 1.2} width="11" height="2.4" rx="1.2" fill="currentColor" opacity="0.6" />
            </g>
          ))}
        </g>
      );

    /* The running order: no header, a row per fixture, the result in a box. */
    case 'results':
      return (
        <g>
          {[4, 11, 18, 25].map((y) => (
            <g key={y}>
              <rect x="2.5" y={y + 0.6} width="3" height="3" rx="1" fill="currentColor" opacity="0.75" />
              <rect x="8.5" y={y + 1.2} width="18" height="2.4" rx="1.2" fill="currentColor" opacity="0.6" />
              <rect
                x="30.5"
                y={y}
                width="15"
                height="4.4"
                rx="1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </g>
          ))}
        </g>
      );

    default:
      return null;
  }
}
