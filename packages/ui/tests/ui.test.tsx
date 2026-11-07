import { describe, expect, it } from "vitest";
import { renderToString } from "@solidjs/web";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Meter,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Segmented,
  Skeleton
} from "../src/index";

describe("@joshuarli/ui", () => {
  it("renders Badge with tone and dot", () => {
    const html = renderToString(() => <Badge tone="ok" dot>Healthy</Badge>);
    expect(html).toContain("ui-badge");
    expect(html).toContain("ui-badge-ok");
    expect(html).toContain("ui-badge-dot");
    expect(html).toContain("Healthy");
  });

  it("renders Button with variant and disabled", () => {
    const html = renderToString(() => <Button variant="small" disabled>Click</Button>);
    expect(html).toContain("ui-btn");
    expect(html).toContain("ui-btn-small");
    expect(html).toContain("disabled");
    expect(html).toContain("Click");
  });

  it("renders Panel with title and meta", () => {
    const html = renderToString(() => (
      <Panel title="System Status" meta={<span>Live</span>}>
        <p>All operational</p>
      </Panel>
    ));
    expect(html).toContain("ui-panel");
    expect(html).toContain("System Status");
    expect(html).toContain("Live");
    expect(html).toContain("All operational");
  });

  it("renders Segmented with options and selection", () => {
    const html = renderToString(() => (
      <Segmented
        label="Range"
        value="1h"
        options={[["1h", "1 Hour"], ["24h", "24 Hours"]]}
        onChange={() => {}}
      />
    ));
    expect(html).toContain("ui-segmented");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("1 Hour");
    expect(html).toContain("24 Hours");
  });

  it("renders EmptyState", () => {
    const html = renderToString(() => (
      <EmptyState title="No records" detail="Try broadening your search" />
    ));
    expect(html).toContain("ui-empty-state");
    expect(html).toContain("No records");
    expect(html).toContain("Try broadening your search");
  });

  it("renders ErrorState with retry", () => {
    const html = renderToString(() => (
      <ErrorState title="Failed" detail="Network timeout" retry={() => {}} />
    ));
    expect(html).toContain("ui-error-state");
    expect(html).toContain("Failed");
    expect(html).toContain("Network timeout");
    expect(html).toContain("Retry");
  });

  it("renders Notice", () => {
    const html = renderToString(() => <Notice tone="warn">Check configuration</Notice>);
    expect(html).toContain("ui-notice");
    expect(html).toContain("ui-notice-warn");
    expect(html).toContain("Check configuration");
  });

  it("renders Skeleton with rows and chart", () => {
    const html = renderToString(() => <Skeleton rows={4} chart />);
    expect(html).toContain("ui-skeleton");
    expect(html).toContain("ui-skeleton-chart");
  });

  it("renders Pagination", () => {
    const html = renderToString(() => (
      <Pagination page={1} pages={5} from={1} to={20} total={100} onChange={() => {}} />
    ));
    expect(html).toContain("ui-pagination");
    expect(html).toContain("Showing");
    expect(html).toContain("100");
    expect(html).toContain("disabled");
  });

  it("renders Meter clamping and tones", () => {
    const html = renderToString(() => <Meter value={85} warn={70} bad={90} />);
    expect(html).toContain("ui-meter");
    expect(html).toContain("ui-meter-warn");
    expect(html).toContain("85.0%");
  });

  it("renders PageHeader", () => {
    const html = renderToString(() => (
      <PageHeader title="Overview" mark={<span>MARK</span>}>
        <button type="button">Action</button>
      </PageHeader>
    ));
    expect(html).toContain("ui-page-header");
    expect(html).toContain("Overview");
    expect(html).toContain("MARK");
    expect(html).toContain("Action");
  });

  it("renders Icon", () => {
    const html = renderToString(() => <Icon name="activity" size={20} />);
    expect(html).toContain("ui-icon");
    expect(html).toContain('width="20"');
  });
});
