/**
 * LAN address discovery.
 *
 * The host PC frequently has several interfaces (Wi-Fi, Ethernet, VPN, Docker,
 * Hyper-V, WSL). Picking the wrong one is the single most common reason a phone
 * cannot reach the scoreboard, so this module ranks the candidates instead of
 * taking the first one it finds.
 */
import { networkInterfaces } from 'node:os';
import type { NetworkInfo } from '../../shared/types';

export interface Candidate {
  iface: string;
  address: string;
  family: 'IPv4';
  isPrivate: boolean;
  isLinkLocal: boolean;
  isVirtual: boolean;
  score: number;
}

const VIRTUAL_HINTS = [
  'vethernet',
  'hyper-v',
  'vmware',
  'virtualbox',
  'docker',
  'wsl',
  'loopback',
  'tap',
  'tun',
  'tailscale',
  'zerotier',
  'radmin',
  'npcap',
];

const WIFI_HINTS = ['wi-fi', 'wifi', 'wlan', 'wireless'];
const WIRED_HINTS = ['ethernet', 'eth', 'lan'];

export function isPrivateIpv4(address: string): boolean {
  // A dotted quad is four octets by definition, so after the length check the
  // first two are always present -- `noUncheckedIndexedAccess` cannot see that.
  const [a = -1, b = -1] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isLinkLocal(address: string): boolean {
  return address.startsWith('169.254.');
}

function looksVirtual(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_HINTS.some((hint) => lower.includes(hint));
}

export function listCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue;
      if (entry.internal) continue;
      const lower = name.toLowerCase();
      const virtual = looksVirtual(lower);
      const isPrivate = isPrivateIpv4(entry.address);
      const linkLocal = isLinkLocal(entry.address);
      let score = 0;
      if (isPrivate) score += 100;
      if (!linkLocal) score += 20;
      if (WIFI_HINTS.some((hint) => lower.includes(hint))) score += 30;
      if (WIRED_HINTS.some((hint) => lower.includes(hint))) score += 25;
      if (virtual) score -= 80;
      candidates.push({
        iface: name,
        address: entry.address,
        family: 'IPv4',
        isPrivate,
        isLinkLocal: linkLocal,
        isVirtual: virtual,
        score,
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.iface.localeCompare(b.iface));
}

export function pickPrimaryIp(preferred: string | null = null): string | null {
  const candidates = listCandidates();
  if (preferred) {
    const match = candidates.find((c) => c.address === preferred);
    if (match) return match.address;
  }
  const best = candidates.find((c) => !c.isLinkLocal && !c.isVirtual);
  if (best) return best.address;
  return candidates.find((c) => !c.isLinkLocal)?.address ?? null;
}

export function loopbackAddress(): string {
  return '127.0.0.1';
}

export interface NetworkOptions {
  port: number;
  preferredHost: string | null;
  mdnsName: string;
  serverStartedAt: number;
  driver: string;
}

export function buildNetworkInfo(options: NetworkOptions): NetworkInfo {
  const candidates = listCandidates();
  const primaryIp = pickPrimaryIp(options.preferredHost);
  const usable = candidates.filter((c) => !c.isLinkLocal);
  const status: NetworkInfo['status'] =
    usable.length === 0 ? 'NO_NETWORK_CONNECTION' : primaryIp === null ? 'LOOPBACK_ONLY' : 'CONNECTED';
  const host = options.preferredHost && !isIpLiteral(options.preferredHost) ? options.preferredHost : primaryIp;
  return {
    primaryIp,
    allIps: usable.map((c) => ({ iface: c.iface, address: c.address, family: c.family })),
    port: options.port,
    url: host ? `http://${host}:${options.port}` : `http://127.0.0.1:${options.port}`,
    mdnsName: options.mdnsName,
    status,
    serverStartedAt: options.serverStartedAt,
    uptimeSec: Math.round((Date.now() - options.serverStartedAt) / 1000),
    driver: options.driver,
  };
}

export function isIpLiteral(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/**
 * Very small mDNS responder so `http://tournament-scoreboard.local` resolves on
 * phones that support it. It answers a single PTR/A record pair -- enough for
 * the convenience hostname, never used as the primary address.
 */
export { type NetworkInfo };
