import { createContext } from "solid-js";
import type { ChartEvent } from "./TimeChart";

/** Empty on host pages; project pages provide their deployment annotations. */
export const DeploymentEvents = createContext<() => readonly ChartEvent[]>(() => []);
