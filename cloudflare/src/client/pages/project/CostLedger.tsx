import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { bytes, count, dollarsPrecise, milliseconds, percent } from "../../format";
import { metricTrack } from "../../history";
import { Segmented } from "../../components/ui";
import { Sparkline } from "../../components/Sparkline";
import { PanelChart, PanelLabel } from "../host/shared";
import { holdLast } from "../../math.ts";
import { WORKERS_PAID_MONTHLY_FEE } from "../../../cost/pricing.ts";
import { isResidual, MONTH_MS, monthlyOf, type Amount, type CostLine, type LedgerHistories } from "../../../cost/ledger.ts";
import type { CostReport, PlanBillReport } from "../../../cost/report.ts";
import "./cost-ledger.css";

type Order = "cost" | "change";

const DAYS_PER_MONTH = MONTH_MS / 86_400_000;
const FOLD_AFTER = 8;
const COMPONENT_COLORS: Readonly<Record<string, string>> = { worker: "var(--viz-blue)", objects: "var(--viz-violet)", d1: "var(--viz-magenta)", r2: "var(--viz-aqua)" };

const perDay = (amount: Amount): Amount => ({ now: amount.now / DAYS_PER_MONTH, before: amount.before === null ? null : amount.before / DAYS_PER_MONTH });
const change = (amount: Amount | null): number | null => amount === null || amount.before === null ? null : amount.now - amount.before;
const per = (part: Amount, whole: Amount): Amount => ({ now: whole.now > 0 ? part.now / whole.now : 0, before: whole.before === null || part.before === null || whole.before <= 0 ? null : part.before / whole.before });

function Delta(props: { readonly amount: Amount | null }): JSX.Element {
  const diff = () => change(props.amount);
  const flat = () => {
    const value = diff();
    const base = props.amount?.before ?? 0;
    return value === null || Math.abs(value) < Math.max(1e-7, Math.abs(base) * 0.05);
  };
  return (
    <span class={`ledger-delta${flat() ? "" : (diff() ?? 0) > 0 ? " up" : " down"}`}>
      {diff() === null ? "—" : flat() ? "±0" : `${(diff() ?? 0) > 0 ? "+" : "−"}${dollarsPrecise(Math.abs(diff() ?? 0))}`}
    </span>
  );
}

function Ratio(props: { readonly amount: Amount; readonly worseUp?: boolean | undefined }): JSX.Element {
  const ratioText = () => {
    const before = props.amount.before;
    if (before === null || before <= 0 || props.amount.now <= 0) return "";
    const value = props.amount.now / before;
    if (Math.abs(value - 1) < 0.1) return "";
    return value >= 2 ? `${value.toFixed(1)}×` : `${value > 1 ? "+" : "−"}${Math.abs((value - 1) * 100).toFixed(0)}%`;
  };
  const tone = () => props.worseUp === undefined || ratioText() === "" ? "" : (props.amount.now > (props.amount.before ?? 0)) === props.worseUp ? " worse" : " better";
  return <Show when={ratioText()}>{text => <span class={`ledger-ratio${tone()}`}>{text()}</span>}</Show>;
}

function usageText(line: CostLine): string {
  const usage = line.usage;
  switch (usage.kind) {
    case "requests": return `${count(Math.round(perDay(usage.calls).now))} ${line.kind === "worker" ? "req" : "calls"}`;
    case "objects": return `${count(Math.round(perDay(usage.calls).now))} calls`;
    case "rows": return usage.queries === null ? `${count(Math.round(perDay(usage.read).now + perDay(usage.written).now))} rows` : `${count(Math.round(perDay(usage.queries).now))} queries`;
    case "stored": return bytes(usage.bytes.now);
    case "none": return "";
  }
}

function UnitCell(props: { readonly line: CostLine; readonly window: number }): JSX.Element {
  const usage = props.line.usage;
  switch (usage.kind) {
    case "requests": {
      const value = per(usage.cpuMs, usage.calls);
      return <>{milliseconds(Number(value.now.toPrecision(2)))} CPU/{props.line.kind === "worker" ? "req" : "call"}<Ratio amount={value} worseUp /></>;
    }
    case "objects": {
      const value = per(usage.wallMs, usage.calls);
      return <>{milliseconds(Number(value.now.toPrecision(2)))} wall/call<Ratio amount={value} worseUp /></>;
    }
    case "rows": {
      if (usage.queries === null || usage.queries.now <= 0) return <></>;
      const rows = { now: usage.read.now + usage.written.now, before: usage.read.before === null || usage.written.before === null ? null : usage.read.before + usage.written.before };
      const value = per(rows, usage.queries);
      return <>{count(Math.round(value.now))} rows/query<Ratio amount={value} worseUp /></>;
    }
    case "stored": {
      if (usage.bytes.before === null) return <></>;
      const grew = usage.bytes.now - usage.bytes.before;
      const days = props.window / 86_400_000;
      return <>{grew >= 0 ? "+" : "−"}{bytes(Math.abs(grew) / days)}/day</>;
    }
    case "none": return <></>;
  }
}

function moneyText(line: CostLine): string {
  const price = line.price;
  return price.kind === "uncollected" ? (price.cause === "no-data" ? "no data" : "not collected") : `${price.bound === "upper" ? "≤ " : ""}${dollarsPrecise(price.monthly.now)}`;
}

function partsText(line: CostLine): string {
  return line.parts.length < 2 ? "" : line.parts.map(part => `${part.label} ${part.bound === "upper" ? "≤ " : ""}${dollarsPrecise(part.monthly)}`).join(" · ");
}

function noteFor(line: CostLine): string {
  if (line.price.kind === "uncollected") {
    return line.price.cause === "no-source"
      ? `Durable Object ${line.label} have no collector source, so they are not in the total.`
      : "Nothing was collected for this component in the window, so it is left out of the total rather than counted as zero.";
  }
  return "The component total minus what its per-route or per-statement analytics account for.";
}

function duration(value: number): string {
  if (value >= 3_600_000) return `${(value / 3_600_000).toPrecision(3)} h`;
  if (value >= 60_000) return `${(value / 60_000).toPrecision(3)} min`;
  if (value >= 1000) return `${(value / 1000).toPrecision(3)} s`;
  return milliseconds(Number(value.toPrecision(2)));
}

function Fact(props: { readonly label: string; readonly value: string; readonly amount?: Amount | undefined; readonly worseUp?: boolean | undefined }): JSX.Element {
  return <div class="ledger-fact"><b>{props.value}<Show when={props.amount}>{amount => <Ratio amount={amount()} worseUp={props.worseUp} />}</Show></b><span>{props.label}</span></div>;
}

function Detail(props: { readonly line: CostLine; readonly histories: LedgerHistories }): JSX.Element {
  const line = () => props.line;
  const facts = (): JSX.Element => {
    const usage = line().usage;
    const money = line().parts.map(part => <Fact label={`${part.label} $/mo`} value={`${part.bound === "upper" ? "≤ " : ""}${dollarsPrecise(part.monthly)}`} />);
    switch (usage.kind) {
      case "requests": return <>
        <Fact label="calls/day" value={count(Math.round(perDay(usage.calls).now))} amount={usage.calls} />
        <Fact label="CPU/call" value={milliseconds(Number(per(usage.cpuMs, usage.calls).now.toPrecision(2)))} amount={per(usage.cpuMs, usage.calls)} worseUp />
        <Fact label="CPU/day" value={duration(perDay(usage.cpuMs).now)} amount={usage.cpuMs} worseUp />
        {money}
      </>;
      case "objects": return <>
        <Fact label="calls/day" value={count(Math.round(perDay(usage.calls).now))} amount={usage.calls} />
        <Fact label="wall/call" value={milliseconds(Number(per(usage.wallMs, usage.calls).now.toPrecision(2)))} amount={per(usage.wallMs, usage.calls)} worseUp />
        <Fact label="CPU/call" value={milliseconds(Number(per(usage.cpuMs, usage.calls).now.toPrecision(2)))} amount={per(usage.cpuMs, usage.calls)} worseUp />
        <Show when={usage.latency}>{latency => <>
          <Fact label="p50 wall" value={milliseconds(latency().p50WallMs)} />
          <Fact label="p95 wall" value={milliseconds(latency().p95WallMs)} />
          <Fact label="failed" value={count(latency().failed)} />
        </>}</Show>
        {money}
      </>;
      case "rows": return <>
        <Show when={usage.queries}>{queries => <Fact label="queries/day" value={count(Math.round(perDay(queries()).now))} amount={queries()} />}</Show>
        <Fact label="rows read/day" value={count(Math.round(perDay(usage.read).now))} amount={usage.read} worseUp />
        <Fact label="rows written/day" value={count(Math.round(perDay(usage.written).now))} amount={usage.written} worseUp />
        {money}
      </>;
      case "stored": return <>
        <Fact label="stored" value={bytes(usage.bytes.now)} />
        <Show when={usage.bytes.before}>{before => <Fact label="at window start" value={bytes(before())} />}</Show>
        {money}
      </>;
      case "none": return <p class="ledger-note">{noteFor(line())}</p>;
    }
  };
  const charts = (): JSX.Element => {
    const current = line();
    if (current.kind === "route") {
      const calls = metricTrack(props.histories.routes, `route.${current.label}.invocations`);
      const cpu = metricTrack(props.histories.routes, `route.${current.label}.cpuMsSum`);
      const common = { stepMs: props.histories.routes.stepMs, min: 0, compact: true };
      return <div class="ledger-charts">
        <div><PanelLabel>Calls per bucket</PanelLabel><PanelChart label="Calls per bucket" area series={[{ label: "calls", color: "blue", track: calls }]} format={count} {...common} /></div>
        <div><PanelLabel>CPU time per bucket</PanelLabel><PanelChart label="CPU time per bucket" area series={[{ label: "CPU", color: "violet", track: cpu }]} format={milliseconds} {...common} /></div>
      </div>;
    }
    if (current.kind === "bucket") {
      return <div class="ledger-charts">
        <PanelLabel>Stored bytes</PanelLabel>
        <PanelChart label="Stored bytes" area series={[{ label: "stored", color: "aqua", track: holdLast(metricTrack(props.histories.r2, `r2.${current.label}.storageBytes`)) }]} format={bytes} min={0} stepMs={props.histories.r2.stepMs} compact />
      </div>;
    }
    if (current.kind === "object-storage" && props.histories.durableObjects !== undefined) {
      return <div class="ledger-charts">
        <PanelLabel>Stored bytes, as the object reports its own database size</PanelLabel>
        <PanelChart label="Stored bytes" area series={[{ label: "stored", color: "aqua", track: holdLast(metricTrack(props.histories.durableObjects, "do.storageBytes")) }]} format={bytes} min={0} stepMs={props.histories.durableObjects.stepMs} compact />
      </div>;
    }
    return <></>;
  };
  return <div class="ledger-detail"><div class="ledger-facts">{facts()}</div>{charts()}</div>;
}

function MonthChart(props: { readonly plan: Extract<PlanBillReport, { readonly kind: "isolated" }> }): JSX.Element {
  return (
    <div class="ledger-month">
      <PanelLabel>Billed beyond the ${WORKERS_PAID_MONTHLY_FEE} plan this month: {dollarsPrecise(props.plan.billedSoFar)} so far, {dollarsPrecise(props.plan.projectedMonthEnd)} by month end at the rate above</PanelLabel>
      <PanelChart
        label="Billed this month"
        series={() => [
          { label: "billed", color: "blue", track: props.plan.billed },
          { label: "projected", color: "blue", track: props.plan.projected, dashed: true }
        ]}
        format={value => dollarsPrecise(value)}
        min={0}
      />
      <span class="ledger-month-note">Usage beyond the Workers Paid allowances at list price, counted from the 1st (UTC) as if this project had the account's allowances to itself.</span>
    </div>
  );
}

export function CostLedger(props: { readonly report: CostReport; readonly histories: LedgerHistories; readonly windowLabel: string; readonly spendPending: boolean }): JSX.Element {
  const initial = (): { readonly expanded: ReadonlySet<string>; readonly selected: string | null } => {
    const top = props.report.lines[0];
    const first = top?.children.find(child => !isResidual(child));
    return { expanded: new Set(top === undefined || top.children.length === 0 ? [] : [top.id]), selected: first?.id ?? top?.id ?? null };
  };
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(initial().expanded);
  const [selected, setSelected] = createSignal<string | null>(initial().selected);
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<string>>(new Set());
  const [order, setOrder] = createSignal<Order>("cost");
  const windowMs = () => props.report.windows.current.toMs - props.report.windows.current.fromMs;
  const total = () => props.report.total.monthly.now;

  const sorted = (lines: readonly CostLine[]) => order() === "cost" ? lines : [...lines].sort((left, right) => Number(isResidual(left)) - Number(isResidual(right)) || (change(monthlyOf(right)) ?? -Infinity) - (change(monthlyOf(left)) ?? -Infinity));
  const toggle = (line: CostLine) => {
    if (line.children.length > 0) {
      setExpanded(current => {
        const next = new Set(current);
        if (next.has(line.id)) next.delete(line.id); else next.add(line.id);
        return next;
      });
      return;
    }
    setSelected(current => (current === line.id ? null : line.id));
  };
  const reveal = (line: CostLine) => {
    setExpanded(current => new Set([...current, line.id]));
    document.getElementById(`ledger-${line.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const Row = (rowProps: { readonly line: CostLine; readonly depth: number; readonly color: string }): JSX.Element => {
    const line = () => rowProps.line;
    const amount = () => monthlyOf(line());
    const share = () => (amount()?.now ?? 0) / Math.max(1e-12, total());
    const open = () => expanded().has(line().id);
    const kids = createMemo(() => sorted(line().children));
    const ordinary = () => kids().filter(child => !isResidual(child));
    const visible = () => unfolded().has(line().id) ? ordinary() : ordinary().slice(0, FOLD_AFTER);
    const hidden = () => ordinary().slice(visible().length);
    const leaf = () => line().children.length === 0;
    const trend = () => line().trend;
    return (
      <>
        <button
          type="button"
          id={`ledger-${line().id}`}
          class={`ledger-row depth-${rowProps.depth}${selected() === line().id && leaf() ? " selected" : ""}${line().kind === "uncollected" ? " uncollected" : ""}`}
          aria-expanded={leaf() ? (selected() === line().id ? "true" : "false") : open() ? "true" : "false"}
          onClick={() => toggle(line())}
        >
          <span class="ledger-name" style={`--indent:${rowProps.depth}`}>
            <span class={`ledger-twist${leaf() ? " leaf" : ""}`} aria-hidden="true">›</span>
            <span class="ledger-swatch" style={`background:${rowProps.color}`} />
            <span class="ledger-label">
              <span class={rowProps.depth > 0 && !isResidual(line()) ? "mono" : undefined} title={line().label}>{line().label}</span>
              <Show when={partsText(line())}>{text => <small>{text()}</small>}</Show>
            </span>
          </span>
          <span class="ledger-money">{moneyText(line())}</span>
          <span class="ledger-share"><i style={`width:${Math.max(0.5, share() * 100)}%;background:${rowProps.color}`} /><em>{amount() === null ? "" : percent(Math.round(share() * 1000) / 10)}</em></span>
          <span class="ledger-change"><Delta amount={amount()} /></span>
          <span class="ledger-usage">{usageText(line())}</span>
          <span class="ledger-unit"><UnitCell line={line()} window={windowMs()} /></span>
          <span class="ledger-trend">
            <Show when={trend()}>{track => <Sparkline series={[{ values: track().values }]} times={track().times} window={props.report.windows.current} label={`${line().label} cost`} zeroBased />}</Show>
          </span>
        </button>
        <Show when={leaf() && selected() === line().id}><Detail line={line()} histories={props.histories} /></Show>
        <Show when={!leaf() && open()}>
          <For each={visible()}>{child => <Row line={child} depth={rowProps.depth + 1} color={rowProps.color} />}</For>
          <Show when={hidden().length > 0}>
            <button type="button" class="ledger-fold" style={`--indent:${rowProps.depth + 1}`} onClick={() => setUnfolded(current => new Set([...current, line().id]))}>
              {hidden().length} more · {dollarsPrecise(hidden().reduce((sum, child) => sum + (monthlyOf(child)?.now ?? 0), 0))}/mo
            </button>
          </Show>
          <For each={kids().filter(isResidual)}>{child => <Row line={child} depth={rowProps.depth + 1} color={rowProps.color} />}</For>
        </Show>
      </>
    );
  };

  return (
    <section class="ledger" aria-label="Cost ledger">
      <header class="ledger-hero">
        <div class="ledger-total">
          <span class="ledger-amount">{dollarsPrecise(total())}<small>/mo</small></span>
          <Delta amount={props.report.total.monthly} />
          <Show when={props.report.total.monthly.before}>{before => <span class="ledger-was">was {dollarsPrecise(before())}/mo{props.report.total.uncompared.length > 0 ? ` · change excludes ${props.report.total.uncompared.join(", ")} (no baseline)` : ""}</span>}</Show>
          <span class="ledger-basis">{props.windowLabel}, projected to 30 days at list price</span>
        </div>
        <div class="ledger-bar" role="img" aria-label="Cost by component">
          <For each={props.report.lines}>{line => <span style={`flex:${Math.max(0, monthlyOf(line)?.now ?? 0)};background:${COMPONENT_COLORS[line.id] ?? "var(--viz-neutral)"}`} title={`${line.label} ${dollarsPrecise(monthlyOf(line)?.now)}`} />}</For>
        </div>
        <div class="ledger-key">
          <For each={props.report.lines}>{line => (
            <button type="button" onClick={() => reveal(line)}>
              <i style={`background:${COMPONENT_COLORS[line.id] ?? "var(--viz-neutral)"}`} />{line.label} <b>{dollarsPrecise(monthlyOf(line)?.now)}</b><Delta amount={monthlyOf(line)} />
            </button>
          )}</For>
        </div>
        <Show when={props.report.planBill.kind === "isolated" ? props.report.planBill : null} fallback={props.spendPending ? <div class="ledger-month-pending" aria-hidden="true" /> : null}>{plan => <MonthChart plan={plan()} />}</Show>
      </header>
      <div class="ledger-table">
        <div class="ledger-tools">
          <span class="ledger-caption">Per day and per call figures cover the same window</span>
          <Segmented label="Order lines" value={order()} options={[["cost", "By cost"], ["change", "By change"]]} onChange={setOrder} />
        </div>
        <div class="ledger-head" aria-hidden="true">
          <span>Item</span><span class="num">$/mo</span><span>Share</span><span class="num">Δ $/mo</span><span class="num">Per day</span><span>Unit</span><span>Cost trend</span>
        </div>
        <For each={sorted(props.report.lines)}>{line => <Row line={line} depth={0} color={COMPONENT_COLORS[line.id] ?? "var(--viz-neutral)"} />}</For>
        <p class="ledger-foot">
          List prices without plan allowances: Worker $0.30/M requests and $0.02/M CPU ms; Durable Objects $0.15/M requests and $12.50/M GB-s at 128 MB, duration bounded above by summed request wall time; D1 $0.001/M rows read, $1.00/M rows written, $0.75/GB-month; R2 $0.015/GB-month with operations unpriced. GB is 10⁹ bytes.
        </p>
      </div>
    </section>
  );
}
