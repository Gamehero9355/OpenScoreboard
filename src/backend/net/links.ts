/**
 * Join links and their QR codes.
 *
 * The important security property: a spectator QR only ever contains a
 * read-only route. Control links carry their token in the URL fragment
 * (`#t=...`) so it never reaches the server in a request line or a log, and the
 * server only includes control links in responses to an authenticated admin.
 */
import type { JoinLink, NetworkInfo, Settings } from '../../shared/types';
import type { AccessControl } from '../auth/access';

export interface LinkContext {
  network: NetworkInfo;
  access: AccessControl;
  settings: Settings;
  /** Operator PIN required to activate a control link. */
  pinRequired: boolean;
}

function base(network: NetworkInfo): string {
  return network.url ?? `http://127.0.0.1:${network.port}`;
}

function trimmed(value: string): string {
  return value.replace(/\/+$/, '');
}

function fieldEntries(settings: Settings): { id: string; name: string }[] {
  return settings.fieldNames.map((name, index) => ({ id: String(index + 1), name }));
}

/** Links that are safe in any response, including spectator pages. */
export function publicLinks(ctx: LinkContext): JoinLink[] {
  const root = trimmed(base(ctx.network));
  const fields = fieldEntries(ctx.settings);
  const combined = fields.length > 1 ? `${fields.length} playing fields` : 'the playing field';
  return [
    {
      purpose: 'general',
      label: 'Join the event',
      description: 'Live scoreboard, bracket and results on any phone or tablet.',
      url: `${root}/`,
      requiresPin: false,
      adminOnly: false,
    },
    ...fields.map(({ id, name }) => {
      return {
        purpose: `display-${id}` as JoinLink['purpose'],
        label: `${name} display`,
        description: `Fullscreen board for a TV or projector showing ${name}.`,
        url: `${root}/display/${id}`,
        requiresPin: false,
        adminOnly: false,
      };
    }),
    {
      purpose: 'display',
      label: 'Combined display',
      description: `${combined} on one screen, ideal for a projector.`,
      url: `${root}/display`,
      requiresPin: false,
      adminOnly: false,
    },
    {
      purpose: 'bracket',
      label: 'Bracket display',
      description: 'The live tournament tree with automatic advancement.',
      url: `${root}/bracket`,
      requiresPin: false,
      adminOnly: false,
    },
    {
      purpose: 'results',
      label: 'Results & statistics',
      description: 'Final standings, match history and participant statistics.',
      // `bare` drops the app shell: the scanned phone opens straight onto the
      // results with no navigation bar above them, so the first thing on screen
      // is the table rather than a menu for a page they did not ask for.
      url: `${root}/results?bare=1`,
      requiresPin: false,
      adminOnly: false,
    },
  ];
}

/** Links that reveal control tokens. Never include these in a spectator response. */
export function adminLinks(ctx: LinkContext): JoinLink[] {
  const root = trimmed(base(ctx.network));
  // Tokens must exist before a link is rendered (fresh installs, more fields).
  ctx.access.ensureTokens(fieldEntries(ctx.settings).map((field) => field.id));
  const links: JoinLink[] = [
    {
      purpose: 'host',
      label: 'Host dashboard',
      description: 'Full control of the tournament. Keep this private.',
      url: `${root}/host#t=${ctx.access.adminToken}`,
      token: ctx.access.adminToken,
      requiresPin: false,
      adminOnly: true,
    },
    ...fieldEntries(ctx.settings).map(({ id, name }) => {
      return {
        purpose: `field-${id}` as JoinLink['purpose'],
        label: `${name} control`,
        description: `Scanner becomes the operator for ${name} (${name.toLowerCase().replace(/\s+/g, '-')} link).`,
        url: `${root}/field/${id}#t=${ctx.access.operatorToken(id)}`,
        token: ctx.access.operatorToken(id),
        requiresPin: ctx.pinRequired,
        adminOnly: true,
      };
    }),
  ];
  return links;
}

export function allLinks(ctx: LinkContext): JoinLink[] {
  return [...publicLinks(ctx), ...adminLinks(ctx)];
}
