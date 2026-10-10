/**
 * The service worker cache stamp.
 *
 * This pins the one behaviour that makes a rebuilt host reach the screens
 * already connected to it. The cache name used to be a literal in
 * `public/sw.js`, and `public/` is copied verbatim, so nothing knew a rebuild
 * had happened: `activate` never ran, and every browser kept rendering the
 * previous bundle out of the cache. The symptom is a host that rebuilds and
 * changes a button label while every phone keeps showing the old one, with no
 * error anywhere -- which is exactly the bug this file exists to prevent from
 * coming back.
 */
import { describe, expect, it } from 'vitest';
import { buildFingerprint } from '../vite.config';

describe('service worker build stamp', () => {
  it('is stable for the same build, so a rebuild of unchanged source does not churn caches', () => {
    const files = ['index-DLEjq9z1.js', 'vendor-ppAWL3zK.js', 'index-yqPfn1fN.css'];
    expect(buildFingerprint(files)).toBe(buildFingerprint([...files]));
  });

  it('ignores the order the bundler happened to report files in', () => {
    const a = ['index-a.js', 'index-b.js', 'vendor.js'];
    expect(buildFingerprint(a)).toBe(buildFingerprint([...a].reverse()));
  });

  it('changes when the emitted code changes, which is what invalidates the old cache', () => {
    const before = buildFingerprint(['index-DLEjq9z1.js', 'vendor-ppAWL3zK.js']);
    const after = buildFingerprint(['index-AZ7dCxBq.js', 'vendor-ppAWL3zK.js']);
    expect(after).not.toBe(before);
  });

  it('changes when a file is added or removed', () => {
    expect(buildFingerprint(['index-a.js'])).not.toBe(buildFingerprint(['index-a.js', 'index-b.js']));
    expect(buildFingerprint(['index-a.js', 'index-b.js'])).not.toBe(buildFingerprint(['index-a.js']));
  });

  it('is short and lowercase, so it is safe inside a cache name', () => {
    const id = buildFingerprint(['index-a.js']);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});