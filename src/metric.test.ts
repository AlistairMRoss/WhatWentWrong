import { describe, expect, test } from "bun:test";
import {
  buildAccessLogFilterPattern,
  parseMetric,
  resolveAlarmClasses,
} from "./metric.js";

describe("parseMetric", () => {
  test("defaults to 5xx when undefined", () => {
    const parsed = parseMetric(undefined);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      low: 500,
      high: 599,
      wildcard: "5*",
      klass: "5xx",
      label: "5xx",
    });
  });

  test("normalizes a single value to a one-element array", () => {
    expect(parseMetric("4xx")).toHaveLength(1);
    expect(parseMetric(503)).toHaveLength(1);
  });

  test("parses an array of mixed matchers", () => {
    expect(parseMetric([404, "50x", "5xx"])).toHaveLength(3);
  });

  test("parses a class wildcard", () => {
    expect(parseMetric("4xx")[0]).toMatchObject({
      low: 400,
      high: 499,
      wildcard: "4*",
      klass: "4xx",
    });
  });

  test("parses an exact code", () => {
    expect(parseMetric(503)[0]).toMatchObject({
      low: 503,
      high: 503,
      wildcard: "503",
      klass: "5xx",
    });
  });

  test("parses a prefix wildcard", () => {
    expect(parseMetric("50x")[0]).toMatchObject({
      low: 500,
      high: 509,
      wildcard: "50*",
      klass: "5xx",
    });
  });

  test("maps non 4xx/5xx codes to a null class", () => {
    expect(parseMetric("2xx")[0].klass).toBeNull();
    expect(parseMetric(301)[0].klass).toBeNull();
  });

  test.each([["6xx"], ["abc"], ["xx"], ["0xx"], ["999x"]])(
    "throws on invalid string %p",
    (value) => {
      expect(() => parseMetric(value as never)).toThrow(/invalid metric/);
    },
  );

  test.each([[700], [99], [503.5], [-1]])(
    "throws on out-of-range number %p",
    (value) => {
      expect(() => parseMetric(value as never)).toThrow(/invalid metric/);
    },
  );
});

describe("buildAccessLogFilterPattern", () => {
  test("builds a single-matcher pattern", () => {
    expect(buildAccessLogFilterPattern(parseMetric("5xx"))).toBe(
      '{ ($.status >= 500 && $.status <= 599) || $.status = "5*" }',
    );
  });

  test("builds a mixed-array pattern joined with ||", () => {
    expect(buildAccessLogFilterPattern(parseMetric([404, "50x", "5xx"]))).toBe(
      '{ ($.status >= 404 && $.status <= 404) || $.status = "404" || ' +
        '($.status >= 500 && $.status <= 509) || $.status = "50*" || ' +
        '($.status >= 500 && $.status <= 599) || $.status = "5*" }',
    );
  });
});

describe("resolveAlarmClasses", () => {
  test("passes class wildcards through without widening", () => {
    expect(resolveAlarmClasses(parseMetric(["4xx", "5xx"]))).toEqual({
      classes: ["4xx", "5xx"],
      widened: [],
      dropped: [],
    });
  });

  test("widens exact and prefix matchers to their class", () => {
    expect(resolveAlarmClasses(parseMetric([503, "50x"]))).toEqual({
      classes: ["5xx"],
      widened: ["503", "50x"],
      dropped: [],
    });
  });

  test("dedupes classes preserving order", () => {
    expect(resolveAlarmClasses(parseMetric(["5xx", 503, "4xx"]))).toEqual({
      classes: ["5xx", "4xx"],
      widened: ["503"],
      dropped: [],
    });
  });

  test("drops matchers without an API Gateway metric", () => {
    expect(resolveAlarmClasses(parseMetric(["2xx", 301, 503, "5xx"]))).toEqual({
      classes: ["5xx"],
      widened: ["503"],
      dropped: ["2xx", "301"],
    });
  });
});
