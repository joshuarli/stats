import assert from "node:assert/strict";

export async function captureObjectSnapshot({ request, restore }, name) {
  const object = `/api/v1/admin/objects/${name}`;
  assert.equal((await request(`${object}/maintenance`)).body.state, "open");
  const errors = [];
  let result;
  try {
    assert.equal((await request(`${object}/maintenance`, { fenced: true })).status, 200);
    const manifest = await request(`${object}/export/manifest`);
    assert.equal(manifest.status, 200);
    result = { tables: manifest.body.tables.map(table => ({ name: table.name, rows: table.rows, sha256: table.sha256 })), schema: manifest.body.schema };
  } catch (error) { errors.push(error); }
  try { await restore(`${object}/maintenance`); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "private snapshot and fence restoration failed");
  return result;
}
