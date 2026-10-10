/*
 * Apply the saved theme before first paint so the board never flashes.
 *
 * Kept as a file rather than an inline <script> so the server can send a
 * Content-Security-Policy without `unsafe-inline`, which would otherwise be the
 * one hole in an otherwise locked-down offline app.
 */
try {
  const stored = localStorage.getItem('tsb.theme');
  const preferred =
    stored ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', preferred);
} catch {
  /* private browsing */
}