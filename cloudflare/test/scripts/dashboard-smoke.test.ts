import test from "node:test";
import assert from "node:assert/strict";
import { LOG_CALL, withWorkspace, type Outcome, type Workspace } from "./harness.ts";

const CURL = `${LOG_CALL}out=; hdr=; fmt=; method=GET; auth=; ctype=; data=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -D) hdr=$2; shift 2 ;;
    -w) fmt=$2; shift 2 ;;
    -X) method=$2; shift 2 ;;
    -H)
      case "$2" in
        Authorization:*) auth=$2 ;;
        Content-Type:*) ctype=$2 ;;
      esac
      shift 2 ;;
    --data|--data-binary) data=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
body=; status=; type=
case "$url" in
  */health)
    printf 'content-type: application/json\\r\\ncontent-security-policy: default-src '"'"'self'"'"'; frame-ancestors '"'"'none'"'"'\\r\\nx-frame-options: DENY\\r\\nx-content-type-options: nosniff\\r\\ncache-control: no-store\\r\\n' > "$hdr"
    body='{"ok":true,"service":"stats"}'
    status=200
    ;;
  */ingest/v1/batches)
    body='{"error":{"code":"gone"}}'
    status=410
    ;;
  */ingest/v2/batches)
    case "$method" in
      GET) body='{"error":{"code":"invalid_request"}}'; status=405 ;;
      *)
        if [ "$ctype" != "\${ctype#*json}" ]; then
          body='{"error":{"code":"invalid_request"}}'; status=415
        elif [ -z "$auth" ]; then
          body='{"error":{"code":"unauthorized"}}'; status=401
        else
          file=
          case "$data" in @*) file=\${data#@} ;; esac
          version=
          [ -z "$file" ] || version=$(tail -c +5 "$file" | head -c 1 | od -An -tu1 | tr -d ' ')
          if [ "$version" = 1 ]; then
            body='{"error":{"code":"unknown_version"}}'; status=400
          else
            body='{"error":{"code":"unauthorized"}}'; status=401
          fi
        fi
        ;;
    esac
    ;;
  */api/v1/hosts)
    body='{"hosts":[]}'
    status=200
    ;;
  */assets/*)
    if [ "$STUB_DASHBOARD_BROKEN" = yes ]; then
      status=404
    else
      case "$url" in
        *.css) type='text/css; charset=utf-8' ;;
        *) type='text/javascript; charset=utf-8' ;;
      esac
      status=200
    fi
    ;;
  */)
    if [ "$STUB_DASHBOARD_BROKEN" = yes ]; then
      body='<html><head><script type="module" src="/assets/missing.js"></script></head></html>'
    else
      body='<html><head><script type="module" src="/assets/index-CLFITwEE.js"></script><link rel="stylesheet" href="/assets/index-w52zXCeE.css"></head></html>'
    fi
    status=200
    ;;
esac
[ -z "$out" ] || printf '%s' "$body" > "$out"
[ -z "$fmt" ] || { case "$fmt" in *content_type*) printf '%s %s\\n' "$status" "$type" ;; *) printf '%s\\n' "$status" ;; esac; }
`;

function stubs(workspace: Workspace): void {
  workspace.install("curl", CURL);
  workspace.install("sleep", "exit 0\n");
  workspace.install("date", `n=$(cat "$STUB_STATE/clock" 2>/dev/null || echo 0); n=$((n + 30)); echo "$n" > "$STUB_STATE/clock"; echo "$n"\n`);
}

function smoke(env: Record<string, string>): Promise<Outcome> {
  return withWorkspace(async workspace => {
    stubs(workspace);
    return workspace.run("deployed-smoke.sh", [], { STATS_URL: "https://stats.example", ...env });
  });
}

await test("the smoke reports the dashboard entry assets when the deploy serves them", async () => {
  const outcome = await smoke({});
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.match(outcome.stdout, /dashboard entry assets/u);
});

await test("the smoke fails when the entry page references an asset the deploy does not serve", async () => {
  const outcome = await smoke({ STUB_DASHBOARD_BROKEN: "yes" });
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /did not serve the assets its entry page references/u);
});
