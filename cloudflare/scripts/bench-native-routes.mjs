export function isNative(capabilities) {
  return capabilities?.applicationEvents === true && !capabilities.analyticsCollection && !capabilities.cloudflareDeployments && !capabilities.tailEvents;
}

export function nativeRoutes(base, service) {
  const project = `#/project/${encodeURIComponent(service)}`;
  const pivotReady = 'table[aria-label="Projects"] tbody tr';
  const make = (name, hash, ready) => ({ name, hash, url: `${base}/${hash}`, pivotHash: '#/projects', pivotReady, ready });
  return [
    make('project', project, 'h2:text-is("Application overview")'),
    make('project-requests', `${project}?section=requests`, 'table[aria-label="Recent application events"], .empty-state:has-text("No recent events in this window")'),
    make('project-signals', `${project}?section=signals`, '[aria-label="Application signals"] .uplot'),
    make('project-errors', `${project}?section=errors`, '#issues .issue-list, #issues .observe-empty')
  ];
}

export function selectRoutes(routes, selection) {
  if (!selection) return routes;
  const names = selection.split(',');
  if (names.some(name => !name || !routes.some(route => route.name === name))) throw new Error(`Unknown or unavailable route: ${selection}`);
  return routes.filter(route => names.includes(route.name));
}

export function accountNetwork(records, summary) {
  const failedRequests = records.filter(record => !(record.status >= 200 && record.status < 300) && record.status !== 304).map(({ path, status }) => ({ path, status }));
  return { ...summary, successfulRequests: records.length - failedRequests.length, failedRequests, requestDetails: records };
}

export function validSamples(samples) {
  return samples.filter(sample => sample.failedRequests.length === 0);
}
