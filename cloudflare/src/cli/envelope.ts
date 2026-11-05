import type { ExitCode } from "./exit.ts";

export const ENVELOPE_SCHEMA = "statsctl/1";

export interface Window {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface Warning {
  readonly code: string;
  readonly message: string;
}

export interface Identities {
  readonly deploymentIds: readonly string[];
  readonly versionIds: readonly string[];
}

export interface ResultMeta {
  readonly project?: string;
  readonly windows?: readonly Window[];
  readonly pricingRevision?: string;
  readonly measurementRevision?: string;
  readonly coverage?: Readonly<Record<string, string>>;
  readonly units?: Readonly<Record<string, string>>;
  readonly priced?: readonly string[];
  readonly excluded?: readonly string[];
  readonly warnings?: readonly Warning[];
  readonly identities?: Partial<Identities>;
}

export interface EnvelopeBase {
  readonly schema: typeof ENVELOPE_SCHEMA;
  readonly command: string;
  readonly generatedAtMs: number;
  readonly origin: string;
  readonly project: string | null;
  readonly windows: readonly Window[];
  readonly pricingRevision: string | null;
  readonly measurementRevision: string | null;
  readonly coverage: Readonly<Record<string, string>> | null;
  readonly units: Readonly<Record<string, string>> | null;
  readonly priced: readonly string[];
  readonly excluded: readonly string[];
  readonly warnings: readonly Warning[];
  readonly identities: Identities;
}

export interface FailureBody {
  readonly code: string;
  readonly message: string;
}

export type Envelope<P> = EnvelopeBase & ({ readonly payload: P } | { readonly error: FailureBody });

export interface CommandResult<P> extends ResultMeta {
  readonly payload: P;
  readonly exit?: ExitCode;
}

export function envelopeBase(command: string, origin: string, generatedAtMs: number, meta: ResultMeta): EnvelopeBase {
  return {
    schema: ENVELOPE_SCHEMA,
    command,
    generatedAtMs,
    origin,
    project: meta.project ?? null,
    windows: meta.windows ?? [],
    pricingRevision: meta.pricingRevision ?? null,
    measurementRevision: meta.measurementRevision ?? null,
    coverage: meta.coverage ?? null,
    units: meta.units ?? null,
    priced: meta.priced ?? [],
    excluded: meta.excluded ?? [],
    warnings: meta.warnings ?? [],
    identities: { deploymentIds: meta.identities?.deploymentIds ?? [], versionIds: meta.identities?.versionIds ?? [] }
  };
}

export function successEnvelope<P>(base: EnvelopeBase, payload: P): Envelope<P> {
  return { ...base, payload };
}

export function failureEnvelope(base: EnvelopeBase, error: FailureBody): Envelope<never> {
  return { ...base, error };
}
