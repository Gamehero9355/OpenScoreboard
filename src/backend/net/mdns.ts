/**
 * Minimal mDNS responder.
 *
 * Answers A queries for the configured hostname so
 * `http://tournament-scoreboard.local` works on phones that support mDNS
 * (Android 12+, iOS, macOS, Windows 10+). This is a convenience only: the IP
 * address stays the primary, always-working address, and any failure here is
 * logged and ignored so the tournament can never be affected by it.
 */
import { createSocket, type Socket } from 'node:dgram';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

interface Question {
  name: string;
  type: number;
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    buffers.push(Buffer.from([bytes.length]), bytes);
  }
  buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

function decodeName(buffer: Buffer, offset: number): { name: string; offset: number } {
  const parts: string[] = [];
  let position = offset;
  let guard = 0;
  while (position < buffer.length && guard < 64) {
    guard += 1;
    const length = buffer[position] ?? 0;
    if (length === 0) {
      position += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      // Compression pointer -- enough for a single hop back to the start.
      position += 2;
      break;
    }
    parts.push(buffer.toString('utf8', position + 1, position + 1 + length));
    position += length + 1;
  }
  return { name: parts.join('.').toLowerCase(), offset: position };
}

function parseQuestions(buffer: Buffer): Question[] {
  if (buffer.length < 12) return [];
  const qdCount = buffer.readUInt16BE(4);
  const questions: Question[] = [];
  let offset = 12;
  for (let i = 0; i < qdCount && offset < buffer.length; i += 1) {
    const decoded = decodeName(buffer, offset);
    offset = decoded.offset + 4;
    const type = buffer.readUInt16BE(decoded.offset);
    if (type === 1 || type === 255) questions.push({ name: decoded.name, type });
  }
  return questions;
}

function buildAnswer(hostname: string, ip: string): Buffer {
  const name = encodeName(hostname);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id 0 for mDNS
  header.writeUInt16BE(0x8400, 2); // response + authoritative
  header.writeUInt16BE(0, 4); // no questions
  header.writeUInt16BE(1, 6); // one answer
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const record = Buffer.alloc(10);
  record.writeUInt16BE(1, 0); // A
  record.writeUInt16BE(0x8001, 2); // cache flush + internet class
  record.writeUInt32BE(120, 4); // TTL
  record.writeUInt16BE(4, 8); // rdlength
  const address = Buffer.from(ip.split('.').map(Number));

  return Buffer.concat([header, name, record, address]);
}

export interface MdnsHandle {
  stop: () => void;
  readonly hostname: string;
}

export function startMdns(
  hostname: string,
  ip: string,
  log: (message: string) => void,
): MdnsHandle | null {
  if (!hostname || !ip) return null;
  const normalised = hostname.toLowerCase().endsWith('.local')
    ? hostname.toLowerCase().replace(/\.local$/, '')
    : hostname.toLowerCase();
  const fqdn = `${normalised}.local`;

  let socket: Socket;
  try {
    socket = createSocket({ type: 'udp4', reuseAddr: true });
  } catch {
    return null;
  }

  const answer = buildAnswer(fqdn, ip);

  socket.on('message', (message, remote) => {
    try {
      const questions = parseQuestions(message);
      if (questions.length === 0) return;
      if (!questions.some((question) => question.name === fqdn)) return;
      socket.send(answer, 0, answer.length, MDNS_PORT, remote.address);
    } catch {
      /* never let mDNS break the tournament */
    }
  });
  socket.on('error', (error) => {
    log(`mDNS disabled: ${error.message}`);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });

  try {
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
      } catch (error) {
        log(`mDNS joined without multicast: ${(error as Error).message}`);
      }
    });
  } catch (error) {
    log(`mDNS could not start: ${(error as Error).message}`);
    return null;
  }

  return {
    hostname: fqdn,
    stop: () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    },
  };
}
