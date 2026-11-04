import type { SummaryField } from "../binary/history";

export type PsiWindow = "10" | "60" | "300";
export type PsiGroup = "cpu" | "memory" | "io";
export type PsiKind = "some" | "full";

export const PSI_WINDOWS = [
  { value: "10", label: "10 s" },
  { value: "60", label: "1 min" },
  { value: "300", label: "5 min" }
] as const satisfies readonly { readonly value: PsiWindow; readonly label: string }[];

export function psiField(group: PsiGroup, kind: PsiKind, window: PsiWindow): SummaryField {
  return `psi.${group}.${kind}${window}` as SummaryField;
}

export function psiWindowLabel(window: PsiWindow): string {
  return PSI_WINDOWS.find(option => option.value === window)?.label ?? window;
}
