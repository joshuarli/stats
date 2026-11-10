export async function attachPreviewFallbacks(page, fallbackServices, missing) {
  if (!missing.services && !missing.deployments) return;
  const pattern = missing.services && missing.deployments
    ? /\/api\/v1\/services(?:\/[^/]+\/deployments)?(?:\?.*)?$/u
    : missing.services
      ? /\/api\/v1\/services(?:\?.*)?$/u
      : /\/api\/v1\/services\/[^/]+\/deployments(?:\?.*)?$/u;
  await page.route(pattern, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/services") {
      const upstream = await route.fetch();
      if (upstream.status() === 404) {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
          body: JSON.stringify({ services: fallbackServices })
        });
        return;
      }
      await route.fulfill({ response: upstream });
      return;
    }
    const serviceDeploys = /^\/api\/v1\/services\/([^/]+)\/deployments$/u.exec(url.pathname);
    if (serviceDeploys !== null) {
      const upstream = await route.fetch();
      if (upstream.status() === 404) {
        const svcName = decodeURIComponent(serviceDeploys[1]);
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
          body: JSON.stringify({
            projectId: svcName,
            worker: svcName,
            enabled: true,
            sync: null,
            versions: [],
            deployments: [],
            markers: []
          })
        });
        return;
      }
      await route.fulfill({ response: upstream });
      return;
    }
    await route.continue();
  });
}

