/**
 * Money + date formatting helpers, shared by every Server/Client Component.
 *
 * Money is stored as integer satang (THB minor unit, 1 THB = 100 satang) end
 * to end — see the comment at the top of supabase/migrations/0001_core_schema.sql.
 * Never do this math inline in a component; always go through here so a
 * future currency/locale change has one place to land.
 *
 * Time is stored as timestamptz (UTC) in Postgres; this file is the only
 * place that should convert to Asia/Bangkok for display.
 */

const THB_FORMATTER = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  currencyDisplay: "symbol",
});

/** e.g. 125050 (satang) -> "฿1,250.50" */
export function formatSatangToThb(satang: number): string {
  return THB_FORMATTER.format(satang / 100);
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  dateStyle: "medium",
  timeStyle: "short",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  dateStyle: "medium",
});

/** ISO timestamp (UTC) -> Thai-locale date + time string in Asia/Bangkok. */
export function formatDateTimeBangkok(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

/** ISO timestamp (UTC) -> Thai-locale date-only string in Asia/Bangkok. */
export function formatDateBangkok(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso));
}
