// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0.
//   Source: src/paperless/network.py (`is_public_ip`, `resolve_hostname_ips`), commit
//   c50c6f5517e3fd8f97fa546ede69a52b622e2b20; the Python is kept unchanged in ./reference/ for provenance.
//   Modified: translated to JavaScript for GinChugger, 15 October 2026. Python's `ipaddress` properties
//   (is_private, is_loopback, is_link_local, is_multicast, is_unspecified) are spelled out as the address blocks
//   CPython 3.12 lists for them, checked with node:net's BlockList; an IPv4-mapped IPv6 address is judged by the IPv4
//   address it carries (as CPython 3.13 does). `getaddrinfo` is `dns.lookup(host, { all: true })`. The httpx
//   transports are left out: the mail consumer is the only outbound connection the team server makes (spec 8.1 T3).
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const block = (list, type) => {
  const b = new net.BlockList();
  for (const [address, prefix] of list) b.addSubnet(address, prefix, type);
  return b;
};

// CPython 3.12 ipaddress: IPv4Address.is_private, is_loopback, is_link_local, is_multicast, is_unspecified.
const V4_NON_PUBLIC = block([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['240.0.0.0', 4], ['255.255.255.255', 32], // is_private
  ['224.0.0.0', 4], // is_multicast
  // _NON_PUBLIC_NETWORKS: RFC 6598 shared address space (CGNAT, and the pod/service range of several managed clusters)
  ['100.64.0.0', 10],
], 'ipv4');
// IPv6Address.is_private, is_loopback, is_link_local, is_multicast, is_unspecified.
const V6_NON_PUBLIC = block([
  ['::1', 128], ['::', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2001:10::', 28],
  ['fc00::', 7], ['fe80::', 10], // is_private (fe80::/10 is also is_link_local)
  ['ff00::', 8], // is_multicast
  // _NON_PUBLIC_NETWORKS: RFC 6052 NAT64 well-known prefix (64:ff9b::7f00:1 is 127.0.0.1 behind a NAT64 gateway)
  ['64:ff9b::', 96],
], 'ipv6');
// CPython carves these out of 2001::/23 (IANA special-purpose registry: globally reachable).
const V6_PUBLIC_EXCEPTIONS = block([['2001:1::1', 128], ['2001:1::2', 128], ['2001:3::', 32], ['2001:4:112::', 48], ['2001:20::', 28], ['2001:30::', 28]], 'ipv6');

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) carries, or null. */
function mappedV4(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!h) return null;
  const a = parseInt(h[1], 16), b = parseInt(h[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** is_public_ip: false for private, loopback, link-local, multicast, unspecified and the extra non-public ranges. */
export function isPublicIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = net.isIP(s);
  if (kind === 4) return !V4_NON_PUBLIC.check(s, 'ipv4');
  if (kind === 6) {
    const v4 = mappedV4(s);
    if (v4) return isPublicIp(v4);
    if (V6_PUBLIC_EXCEPTIONS.check(s, 'ipv6')) return true;
    return !V6_NON_PUBLIC.check(s, 'ipv6');
  }
  return false; // not an address: Python's ValueError branch
}

/** resolve_hostname_ips: every address the name resolves to, in resolver order. Throws "Could not resolve hostname". */
export async function resolveHostnameIps(hostname, { lookup = dnsLookup } = {}) {
  if (net.isIP(String(hostname))) return [String(hostname)];
  let found;
  try { found = await lookup(hostname, { all: true, verbatim: true }); } catch (e) { throw Object.assign(new Error(`Could not resolve hostname: ${hostname}`), { cause: e }); }
  const ips = (Array.isArray(found) ? found : [found]).map(a => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!ips.length) throw new Error(`Could not resolve hostname: ${hostname}`);
  return ips;
}
