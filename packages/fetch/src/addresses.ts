import { BlockList, isIP } from 'node:net';

/**
 * Address classes that are never a legitimate public crawl target, so the SSRF guard refuses
 * them before a socket is opened (security-and-privacy.md §1).
 *
 * `0.0.0.0/8` "this network", `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` RFC 1918,
 * `100.64.0.0/10` CGNAT, `127.0.0.0/8` loopback, `169.254.0.0/16` link-local (including the
 * cloud metadata address `169.254.169.254`), `192.0.0.0/24` IETF protocol assignments,
 * `198.18.0.0/15` benchmarking, `224.0.0.0/4` multicast and `240.0.0.0/4` reserved, which
 * contains the broadcast address `255.255.255.255`.
 */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * `::/128` unspecified, `::1/128` loopback, `fc00::/7` unique-local (which contains the cloud
 * metadata address `fd00:ec2::254`), `fe80::/10` link-local and `ff00::/8` multicast.
 *
 * IPv6 transition forms are refused outright, because their embedded IPv4 address can name a
 * private or metadata target even when the transitional prefix itself looks public:
 * `64:ff9b:1::/48` (local-use NAT64, RFC 8215) and `2001::/32` (Teredo, RFC 4380). The well-known
 * NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are checked through the IPv4 block list instead, so a
 * transition address that embeds a public address can still be reached.
 */
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const ipv4BlockList = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4) ipv4BlockList.addSubnet(network, prefix, 'ipv4');

const ipv6BlockList = new BlockList();
for (const [network, prefix] of BLOCKED_IPV6) ipv6BlockList.addSubnet(network, prefix, 'ipv6');

/** Host names that only ever resolve inside a machine or a LAN. */
const INTERNAL_HOST_SUFFIXES: ReadonlyArray<string> = ['localhost', 'local', 'internal', 'home.arpa'];

/** Trims, lower-cases and unbrackets a host, and drops a DNS root dot. */
export function normalizeHostname(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/** Removes a zone id (`fe80::1%eth0`) and brackets from an address literal. */
function plainAddress(address: string): string {
  const unbracketed = address.trim().replace(/^\[|\]$/g, '');
  const zone = unbracketed.indexOf('%');
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
}

/** Whether a string is an IPv4 or IPv6 address literal, in any of Node's or the URL parser's forms. */
export function isIpAddress(value: string): boolean {
  return isIP(plainAddress(value)) !== 0;
}

/** The eight 16-bit words of an IPv6 address, with a dotted IPv4 tail folded into the last two. */
function ipv6Words(address: string): number[] | null {
  const value = plainAddress(address).toLowerCase();
  if (isIP(value) !== 6) return null;
  const [left = '', right = ''] = value.split('::');
  const words = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const word of part.split(':')) {
      if (word.includes('.')) {
        const octets = word.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        const n = Number.parseInt(word, 16);
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };
  const l = words(left);
  const r = words(right);
  if (!l || !r) return null;
  const missing = 8 - l.length - r.length;
  if (missing < 0) return null;
  return [...l, ...Array<number>(missing).fill(0), ...r];
}

const dottedIpv4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * The IPv4 address an IPv6 form embeds, or null. IPv4-mapped (`::ffff:0:0/96`), IPv4-translated
 * (`::ffff:0:0:0/96`, the SIIT form), IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) and 6to4
 * (`2002::/16`, address in bits 16–48) all carry an IPv4 address that must be checked against the
 * IPv4 block list.
 */
function embeddedIpv4(address: string): string | null {
  const words = ipv6Words(address);
  if (!words) return null;
  const zeroBetween = (from: number, to: number) => words.slice(from, to).every((n) => n === 0);
  if (zeroBetween(0, 5) && words[5] === 0xffff) return dottedIpv4(words[6]!, words[7]!);
  if (zeroBetween(0, 4) && words[4] === 0xffff && words[5] === 0) return dottedIpv4(words[6]!, words[7]!);
  if (zeroBetween(0, 6)) return dottedIpv4(words[6]!, words[7]!);
  if (words[0] === 0x64 && words[1] === 0xff9b && zeroBetween(2, 6)) return dottedIpv4(words[6]!, words[7]!);
  if (words[0] === 0x2002) return dottedIpv4(words[1]!, words[2]!);
  return null;
}

/**
 * Whether an address literal is private, loopback, link-local, multicast, reserved or a cloud
 * metadata address — directly, or through an IPv4-mapped/compatible/NAT64/6to4 IPv6 form.
 *
 * A value that is not an address literal returns `false`; callers resolve names themselves and
 * check every address they get back.
 */
export function isBlockedAddress(address: string): boolean {
  const value = plainAddress(address);
  const family = isIP(value);
  if (family === 4) return ipv4BlockList.check(value, 'ipv4');
  if (family !== 6) return false;
  if (ipv6BlockList.check(value, 'ipv6')) return true;
  const embedded = embeddedIpv4(value);
  return embedded !== null && isBlockedAddress(embedded);
}

/**
 * Whether a host name only points inside a machine or a LAN (`localhost`, `*.local`, `*.internal`,
 * `*.home.arpa`). A literal address is handled by {@link isBlockedAddress}.
 */
export function isInternalHostname(host: string): boolean {
  const name = normalizeHostname(host);
  if (!name || isIP(name) !== 0) return false;
  return INTERNAL_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** The cloud metadata endpoints of security-and-privacy.md §1, in every spelling. */
const METADATA_IPV4 = '169.254.169.254';
const METADATA_IPV6 = 'fd00:ec2::254';

/**
 * Whether an address is a cloud metadata endpoint. These stay blocked even when the host is on a
 * site's private allow-list: a metadata page is never a site, and a rebinding name must not be able
 * to read instance credentials through a staging-host exception.
 */
export function isMetadataAddress(address: string): boolean {
  const value = plainAddress(address).toLowerCase();
  if (isIP(value) === 4) return value === METADATA_IPV4;
  if (isIP(value) !== 6) return false;
  if (value === METADATA_IPV6) return true;
  const embedded = embeddedIpv4(value);
  return embedded !== null && embedded === METADATA_IPV4;
}

/** Ports a request may use when the site has not allowed any others (security-and-privacy.md §1). */
export const DEFAULT_ALLOWED_PORTS: ReadonlyArray<number> = [80, 443];

/** The port a URL effectively reaches: its own, or the scheme's default. */
export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Whether a port may be reached: 80/443, or one the caller or site explicitly allowed. */
export function isAllowedPort(port: number, allowedPorts: ReadonlyArray<number> = []): boolean {
  return DEFAULT_ALLOWED_PORTS.includes(port) || allowedPorts.includes(port);
}
