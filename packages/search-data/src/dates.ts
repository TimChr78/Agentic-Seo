import { searchConsoleDay } from '@agentic-seo/core';

// Calendar days for search facts. Search Console speaks YYYY-MM-DD and, as the Search Analytics
// reference says, its dates are "in PT time (UTC - 7:00/8:00)": the day Google answers for is the
// one in America/Los_Angeles, not in UTC. Arithmetic on a day that is already a calendar date stays
// UTC arithmetic (a day is a day); only "today" comes from the Search Console calendar.

export { searchConsoleDay };

/** "Today" as Search Console counts it (America/Los_Angeles, DST-safe). */
export const today = (now: Date = new Date()): string => searchConsoleDay(now);

/** A day as a UTC string: used for a Date that already denotes a calendar day. */
export const dayString = (date: Date): string => date.toISOString().slice(0, 10);

/** A day shifted by whole days (negative moves back). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dayString(date);
}

/** A day shifted by whole months, clamped to the end of a shorter month (31 Jan − 1 month = 28 Feb). */
export function addMonths(day: string, months: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  const targetMonth = date.getUTCMonth() + months;
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(targetMonth);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDay));
  return dayString(date);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The number of days in a range, inclusive. */
export const rangeDays = (start: string, end: string): number => daysBetween(start, end) + 1;

/** True when `day` is on or before `end` and on or after `start`. */
export const within = (day: string, start: string, end: string): boolean => day >= start && day <= end;

/** The earlier (or later) of two calendar days; null loses. */
export const minDay = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a <= b ? a : b);
export const maxDay = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a >= b ? a : b);
