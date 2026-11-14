import { describe, expect, it } from 'vitest';
import { normalizeDomain, normalizeHost, siteHosts } from '../src';

// Domain normalisation is the gate every site and competitor goes through: the stored form must be
// usable by the crawler and every provider, and anything that is not a public domain is refused
// with a message a person can act on.

describe('normalizeDomain', () => {
  it('lower-cases, converts IDN labels to punycode and drops the DNS root dot', () => {
    expect(normalizeDomain('Example.COM')).toBe('example.com');
    expect(normalizeDomain('  example.com.  ')).toBe('example.com');
    expect(normalizeDomain('München.de')).toBe('xn--mnchen-3ya.de');
  });

  it('refuses a URL, a path, a port and embedded credentials', () => {
    for (const input of ['https://example.com', 'example.com/pricing', 'example.com:8080', 'user@example.com', 'example.com?q=1'])
      expect(() => normalizeDomain(input), input).toThrow();
  });

  it('refuses IP literals in their many spellings', () => {
    for (const input of ['127.0.0.1', '10.1.2.3', '2130706433', '0177.0.0.1', '[::1]'])
      expect(() => normalizeDomain(input), input).toThrow();
    expect(() => normalizeDomain('127.0.0.1')).toThrowError(/IP address/);
  });

  it('refuses internal and reserved names', () => {
    for (const input of ['localhost', 'intranet', 'printer.local', 'build.internal', 'host.home.arpa'])
      expect(() => normalizeDomain(input), input).toThrow();
    expect(() => normalizeDomain('localhost')).toThrowError(/internal/i);
  });

  it('refuses an empty value and invalid labels', () => {
    for (const input of ['', '   ', 'exa mple.com', 'example..com', '-example.com', 'example-.com'])
      expect(() => normalizeDomain(input), input).toThrow();
  });

  it('refuses a numeric top-level label, which is an address rather than a domain', () => {
    expect(() => normalizeDomain('1.2.3.4')).toThrowError(/IP address|cannot be a site/);
  });

  it('refuses a domain that is itself a public suffix, ICANN or private', () => {
    for (const input of ['co.uk', 'github.io', 'blogspot.com']) expect(() => normalizeDomain(input), input).toThrowError(/public suffix/);
    expect(() => normalizeDomain('co.uk')).toThrowError(/yourcompany\.co\.uk/);
  });

  it('allows a real site below a public or private suffix', () => {
    expect(normalizeDomain('blog.example.co.uk')).toBe('blog.example.co.uk');
    expect(normalizeDomain('user.github.io')).toBe('user.github.io');
  });

  it('normalises an extra host the same way, and siteHosts lists the primary domain once', () => {
    expect(normalizeHost('WWW.Example.com')).toBe('www.example.com');
    expect(() => normalizeHost('github.io')).toThrowError(/public suffix/);
    expect(siteHosts({ primaryDomain: 'example.com', hosts: ['www.example.com', 'example.com'] })).toEqual([
      'example.com',
      'www.example.com',
    ]);
  });
});
