import { describe, expect, it } from "vitest";
import { homeWeek } from "./week.js";
describe("Home calendar week", () => {
  it("uses local Sunday through Saturday and hides future navigation", () => {
    expect(homeWeek(Date.parse("1970-01-05T01:00:00Z"), undefined, "America/Los_Angeles")).toEqual({
      startDate: "1970-01-04",
      timeZone: "America/Los_Angeles",
      start: Date.parse("1970-01-04T08:00:00Z"),
      end: Date.parse("1970-01-11T08:00:00Z"),
      label: "Jan 4, 1970 – Jan 10, 1970",
      previousUrl: "/home/history?week=1969-12-28&tz=America%2FLos_Angeles",
    });
  });
  it("converts both DST boundaries separately and keeps week arrows on local Sundays", () => {
    const week = homeWeek(Date.parse("1970-05-04T00:00:00Z"), "1970-04-26", "America/Los_Angeles");
    expect(week).toMatchObject({
      start: Date.parse("1970-04-26T08:00:00Z"),
      end: Date.parse("1970-05-03T07:00:00Z"),
      previousUrl: "/home/history?week=1970-04-19&tz=America%2FLos_Angeles",
      nextUrl: "/home/history?week=1970-05-03&tz=America%2FLos_Angeles",
    });
  });
  it("refuses an invalid date, a non-Sunday, a future week or an unrecognized zone", () => {
    const now = Date.parse("1970-02-02T12:00:00Z");
    for (const value of ["1970-02-30", "1970-02-02", "1970-02-08", "not-a-date"])
      expect(() => homeWeek(now, value)).toThrow();
    expect(() => homeWeek(now, undefined, "not-a-zone")).toThrow();
  });
});
