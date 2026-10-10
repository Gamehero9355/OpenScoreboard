/**
 * A team's crest.
 *
 * One component for every size a crest is drawn at -- a 28px thumbnail in the
 * library table, a 64px mark on a scoreboard -- so a logo cannot look like a
 * different asset depending on which screen it happens to be on.
 *
 * It hides itself rather than showing a broken image: a squad whose crest was
 * deleted from the folder, or a host who never put one there, gets no mark at
 * all and the screen looks exactly as it did before logos existed.
 */
import { logoSrc, resolvableLogo, useLogos } from '../lib/logos';
import { cx } from '../lib/util';

export type CrestSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function TeamCrest({
  logo,
  size = 'md',
  className,
  title,
}: {
  /** File name from the logos folder, or null/undefined for the default. */
  logo?: string | null;
  size?: CrestSize;
  className?: string;
  /** Accessible name. The crest is decorative next to a visible team name. */
  title?: string;
}) {
  const index = useLogos();
  const file = resolvableLogo(logo, index);
  if (!file) return null;
  return (
    <img
      className={cx('crest', `crest--${size}`, className)}
      src={logoSrc(file, index) ?? undefined}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      // Crests are square-ish by convention; object-fit keeps an odd-shaped
      // file from stretching the row it sits in.
      draggable={false}
    />
  );
}

/**
 * The crest beside a name, for rows where the name is the point.
 *
 * Wraps both in one inline-flex pair so a caller cannot accidentally put a gap
 * between them, and so a long name wraps under its own crest rather than
 * pushing the crest to the far end of the row.
 */
export function CrestWithName({
  logo,
  name,
  size = 'sm',
  className,
}: {
  logo?: string | null;
  name: React.ReactNode;
  size?: CrestSize;
  className?: string;
}) {
  const index = useLogos();
  const file = resolvableLogo(logo, index);
  return (
    <span className={cx('crest-name', className)}>
      {file ? (
        <img
          className={cx('crest', `crest--${size}`)}
          src={logoSrc(file, index) ?? undefined}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ) : null}
      <span className="crest-name__text">{name}</span>
    </span>
  );
}