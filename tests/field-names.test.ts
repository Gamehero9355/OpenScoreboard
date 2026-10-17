/**
 * Untouched default field names ("Field 1", ...) render in the reader's
 * language; names the host typed pass through in any language.
 */
import { describe, expect, it } from 'vitest';
import { fieldDisplayName, type Translate } from '../src/shared/matchUtils';

const german: Translate = (key, params) => (key === 'field.label' ? `Feld ${params?.n}` : key);
const english: Translate = (key, params) => (key === 'field.label' ? `Field ${params?.n}` : key);

describe('fieldDisplayName', () => {
  it('renders an untouched default in the reader language', () => {
    expect(fieldDisplayName('Field 1', '1', german)).toBe('Feld 1');
    expect(fieldDisplayName('Field 2', '2', german)).toBe('Feld 2');
    expect(fieldDisplayName('Field 1', '1', english)).toBe('Field 1');
  });

  it('passes a name the host typed through untouched', () => {
    expect(fieldDisplayName('Halle A', '1', german)).toBe('Halle A');
    expect(fieldDisplayName('Halle A', '1', english)).toBe('Halle A');
    // A stored value that is not this field's default is host data too.
    expect(fieldDisplayName('Field 2', '1', german)).toBe('Field 2');
  });

  it('falls back to the translated label when the name is missing', () => {
    expect(fieldDisplayName(null, '2', german)).toBe('Feld 2');
    expect(fieldDisplayName(undefined, '1', german)).toBe('Feld 1');
    expect(fieldDisplayName('', '1', german)).toBe('Feld 1');
  });

  it('falls back to English without a translator', () => {
    expect(fieldDisplayName('Field 1', '1')).toBe('Field 1');
    expect(fieldDisplayName(null, '3')).toBe('Field 3');
    expect(fieldDisplayName('Halle A', '1')).toBe('Halle A');
  });
});
