export default async function workload(origin) {
  for (let index = 0; index < 4; index += 1) await send(origin, "/insert?count=5");
  for (let index = 0; index < 2; index += 1) await send(origin, "/scan?limit=3");
  await send(origin, "/media");
  for (let index = 0; index < 2; index += 1) await send(origin, "/");
}

async function send(origin, path) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  await response.arrayBuffer();
}
