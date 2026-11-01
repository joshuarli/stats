import { describe, expect, it } from "vitest";
import { MAX_PROBES_PER_PROJECT, parseProjects, ProjectConfigError, type ProjectConfig } from "../src/projects/config";

const valid = {
  id: "stuff",
  name: "stuff",
  worker: "stuff",
  buckets: ["stuff-mycrates", "stuff-mynpm"],
  durableObjectNamespaces: [], d1Databases: [],
  probes: [{ name: "npm", url: "https://npm.17166969.xyz/current/" }],
};

function parse(project: unknown): ProjectConfig[] {
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

  it("accepts a project without buckets and rejects more than eight or duplicate buckets", () => {
    expect(parse({ ...valid, buckets: [] })[0]?.buckets).toEqual([]);
    expect(rejection({ ...valid, buckets: Array.from({ length: 9 }, (_, i) => `bucket-${i}`) })).toContain("projects[0].buckets: expected at most 8");
    expect(rejection({ ...valid, buckets: ["stuff-mynpm", "stuff-mynpm"] })).toContain("projects[0].buckets: duplicate");
  });

  it("accepts distinct D1 database ids up to eight and rejects anything else", () => {
    const id = (n: number) => `9870c4da-3758-4f0c-ab6d-2372eb3400${String(n).padStart(2, "0")}`;
    expect(parse({ ...valid, d1Databases: [id(9)] })[0]?.d1Databases).toEqual([id(9)]);
    expect(rejection({ ...valid, d1Databases: Array.from({ length: 9 }, (_, i) => id(i)) })).toContain("projects[0].d1Databases: expected at most 8");
    expect(rejection({ ...valid, d1Databases: [id(1), id(1)] })).toContain("projects[0].d1Databases: duplicate");
    expect(rejection({ ...valid, d1Databases: ["usr-memories"] })).toContain("projects[0].d1Databases[0]");
    expect(rejection(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "d1Databases")))).toContain("projects[0].d1Databases: missing");
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
