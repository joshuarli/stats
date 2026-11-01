import { describe, expect, it } from "vitest";
import { MAX_PROBES_PER_PROJECT, parseProjects, ProjectConfigError } from "../src/projects/config";

const valid = {
  id: "stuff",
  name: "stuff",
  worker: "stuff",
  buckets: ["stuff-mycrates", "stuff-mynpm"],
  probes: [{ name: "npm", url: "https://npm.17166969.xyz/current/" }],
};

function parse(project: unknown): unknown {
  return parseProjects(JSON.stringify([project]));
}

function rejection(project: unknown): string {
  try {
    parse(project);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConfigError);
    return (error as ProjectConfigError).message;
  }
  throw new Error("registry was accepted");
}

describe("project registry", () => {
  it("returns the typed registry unchanged", () => {
    expect(parseProjects(JSON.stringify([valid]))).toEqual([valid]);
    expect(parseProjects("[]")).toEqual([]);
  });

  it("rejects text that is not a JSON array", () => {
    expect(() => parseProjects("{")).toThrow(ProjectConfigError);
    expect(() => parseProjects("{}")).toThrow("expected an array");
    expect(() => parseProjects('["stuff"]')).toThrow("projects[0]: expected an object");
  });

  it("rejects unknown and missing keys at both levels", () => {
    expect(rejection({ ...valid, token: "x" })).toContain("projects[0].token: unknown key");
    const withoutProbes = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "probes"));
    expect(rejection(withoutProbes)).toContain("projects[0].probes: missing");
    expect(rejection({ ...valid, probes: [{ name: "npm", url: valid.probes[0]?.url, method: "POST" }] })).toContain("probes[0].method: unknown key");
  });

  it("rejects duplicate project ids", () => {
    expect(() => parseProjects(JSON.stringify([valid, { ...valid, name: "other" }]))).toThrow("projects[1].id: duplicate");
  });

  it("rejects ids, workers, and bucket names outside their patterns", () => {
    expect(rejection({ ...valid, id: "Stuff" })).toContain("projects[0].id");
    expect(rejection({ ...valid, id: "1stuff" })).toContain("projects[0].id");
    expect(rejection({ ...valid, id: "a".repeat(33) })).toContain("projects[0].id");
    expect(rejection({ ...valid, worker: "stuff worker" })).toContain("projects[0].worker");
    expect(rejection({ ...valid, buckets: ["stuff-mycrates", "Stuff_Bucket"] })).toContain("buckets[1]");
    expect(rejection({ ...valid, buckets: ["x"] })).toContain("buckets[0]");
    expect(rejection({ ...valid, buckets: ["a') OR ('1'='1"] })).toContain("buckets[0]");
    expect(rejection({ ...valid, name: " stuff" })).toContain("projects[0].name");
    expect(rejection({ ...valid, name: "" })).toContain("projects[0].name");
  });

  it("requires one to eight distinct buckets", () => {
    expect(rejection({ ...valid, buckets: [] })).toContain("projects[0].buckets: expected 1 to 8");
    expect(rejection({ ...valid, buckets: Array.from({ length: 9 }, (_, i) => `bucket-${i}`) })).toContain("projects[0].buckets: expected 1 to 8");
    expect(rejection({ ...valid, buckets: ["stuff-mynpm", "stuff-mynpm"] })).toContain("projects[0].buckets: duplicate");
  });

  it("accepts only https probe URLs without credentials or fragments", () => {
    const withUrl = (url: string) => ({ ...valid, probes: [{ name: "npm", url }] });
    expect(parse(withUrl("https://example.com/"))).toBeDefined();
    expect(rejection(withUrl("http://example.com/"))).toContain("probes[0].url");
    expect(rejection(withUrl("ftp://example.com/"))).toContain("probes[0].url");
    expect(rejection(withUrl("https://user:pw@example.com/"))).toContain("probes[0].url");
    expect(rejection(withUrl("https://example.com/#x"))).toContain("probes[0].url");
    expect(rejection(withUrl("npm.17166969.xyz"))).toContain("probes[0].url: not a URL");
  });

  it("limits and distinguishes probes", () => {
    const probe = (n: number) => ({ name: `probe-${n}`, url: `https://example.com/${n}` });
    const many = Array.from({ length: MAX_PROBES_PER_PROJECT }, (_, i) => probe(i));
    expect(parse({ ...valid, probes: many })).toBeDefined();
    expect(rejection({ ...valid, probes: [...many, probe(9)] })).toContain("projects[0].probes: expected at most 8");
    expect(rejection({ ...valid, probes: [probe(1), { ...probe(2), name: "probe-1" }] })).toContain("probes[1].name: duplicate");
    expect(rejection({ ...valid, probes: [{ name: "Bad Name", url: "https://example.com/" }] })).toContain("probes[0].name");
  });

  it("keeps rejected values out of the error message", () => {
    const secret = "https://user:hunter2@example.com/";
    expect(() => parse({ ...valid, probes: [{ name: "npm", url: secret }] })).not.toThrow(/hunter2/);
  });
});
