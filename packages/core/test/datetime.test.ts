import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dayInZone, isoDateTime, searchConsoleDay } from '../src';

describe('isoDateTime', () => {
  it('accepts Z and numeric offsets and normalises to UTC', () => {
    const field = isoDateTime('sendAt');
    expect(field.parse('2026-10-24T15:00:00+02:00')).toBe('2026-10-24T13:00:00.000Z');
    expect(field.parse('2026-10-24T15:00:00-0500')).toBe('2026-10-24T20:00:00.000Z');
    expect(field.parse('2026-10-24T13:00:00.250Z')).toBe('2026-10-24T13:00:00.250Z');
    expect(field.parse('2026-10-24T13:00Z')).toBe('2026-10-24T13:00:00.000Z');
  });

  it('rejects a date-time without a time zone, naming the field and showing both forms', () => {
    const result = isoDateTime('sendAt').safeParse('2026-10-24T15:00:00');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('sendAt needs a time zone, e.g. 2026-10-30T07:00:00Z or 2026-10-30T09:00:00+02:00.');
  });

  it('stays a described string in the input JSON schema', () => {
    const schema = z.object({ sendAt: isoDateTime('sendAt').optional() });
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as unknown as {
      properties: { sendAt: { type: string; description: string } };
    };
    expect(json.properties.sendAt.type).toBe('string');
    expect(json.properties.sendAt.description).toContain('ISO 8601 with a time zone');
  });
});

describe('isoDateTime calendar validation', () => {
  it('rejects impossible calendar dates instead of rolling them over', () => {
    const field = isoDateTime('at');
    expect(field.safeParse('2026-02-30T12:00:00Z').success).toBe(false);
    expect(field.safeParse('2026-02-29T12:00:00Z').success).toBe(false);
    expect(field.safeParse('2028-02-29T12:00:00Z').success).toBe(true);
    expect(field.safeParse('2026-04-31T09:00:00+02:00').success).toBe(false);
  });
});

describe('searchConsoleDay', () => {
  it('is the Pacific day, not the UTC one, around midnight', () => {
    // 18:00 PST on 15 November is 02:00 UTC on the 16th: Search Console still calls it the 15th.
    expect(searchConsoleDay(new Date('2026-11-16T02:00:00Z'))).toBe('2026-11-15');
    expect(searchConsoleDay(new Date('2026-11-16T07:59:00Z'))).toBe('2026-11-15');
    expect(searchConsoleDay(new Date('2026-11-16T08:00:00Z'))).toBe('2026-11-16');
  });

  it('follows the daylight-saving change instead of a fixed offset', () => {
    // 2026-03-08: PST (UTC−8) until 02:00 local, PDT (UTC−7) after. 09:30 UTC is 01:30 PST.
    expect(searchConsoleDay(new Date('2026-03-08T09:30:00Z'))).toBe('2026-03-08');
    // 10:30 UTC is 03:30 PDT: the same calendar day, one hour of clock time later.
    expect(searchConsoleDay(new Date('2026-03-08T10:30:00Z'))).toBe('2026-03-08');
    // 07:30 UTC the next day is 00:30 PDT on the 9th (UTC would say the 9th too, but through a
    // different offset); 06:30 UTC is 23:30 PDT on the 8th.
    expect(searchConsoleDay(new Date('2026-03-09T06:30:00Z'))).toBe('2026-03-08');
    // 2026-11-01: PDT (UTC−7) until 02:00 local, PST (UTC−8) after: both 08:30 and 09:30 UTC are
    // 01:30 local, on the same day.
    expect(searchConsoleDay(new Date('2026-11-01T08:30:00Z'))).toBe('2026-11-01');
    expect(searchConsoleDay(new Date('2026-11-01T09:30:00Z'))).toBe('2026-11-01');
    // The next UTC day at 07:30 is still 23:30 on 1 November in Pacific time.
    expect(searchConsoleDay(new Date('2026-11-02T07:30:00Z'))).toBe('2026-11-01');
  });

  it('counts the day in any zone it is given', () => {
    const at = new Date('2026-11-16T02:00:00Z');
    expect(dayInZone(at, 'UTC')).toBe('2026-11-16');
    expect(dayInZone(at, 'Asia/Tokyo')).toBe('2026-11-16');
    expect(dayInZone(at, 'America/Los_Angeles')).toBe('2026-11-15');
  });
});
