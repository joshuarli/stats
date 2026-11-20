import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

closure, out, candidate = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
source = subprocess.check_output(['git', '-C', '/Users/josh/repos/stats/.work/tmp/stuff', 'show', 'origin/main:deploy/openorange/lib/oorollout_native.py'], text=True)
module = {}
exec(compile(source, 'oorollout_native.py', 'exec'), module)
namespace = {}
exec(module['GUEST_SCRIPT'].split('\nOPERATIONS = ')[0], namespace)
modules = closure / 'node_modules/.modules.yaml'
metadata = json.loads(modules.read_text())
metadata['prunedAt'] = 'Thu, 01 Jan 1970 00:00:00 GMT'
modules.write_text(json.dumps(metadata, indent=2) + '\n')
state = closure / 'node_modules/.pnpm-workspace-state-v1.json'
data = json.loads(state.read_text())
def normalize(value):
    if isinstance(value, dict):
        return {key: 0 if key in ('lastValidatedTimestamp', 'recordedAtNs', 'mtimeNs', 'ctimeNs') else normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value
state.write_text(json.dumps(normalize(data), indent=2) + '\n')
digest = namespace['closure_digest'](str(closure))
archive = out / 'runtime.tar'
with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
    for path in sorted(closure.rglob('*'), key=lambda p: str(p.relative_to(closure))):
        info = tar.gettarinfo(str(path), arcname=str(path.relative_to(closure)))
        info.uid = info.gid = info.mtime = 0
        info.uname = info.gname = ''
        if info.isfile():
            with path.open('rb') as stream:
                tar.addfile(info, stream)
        else:
            tar.addfile(info)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {'closure_digest': digest, 'tar_sha256': sha(archive), 'open_orange_version': json.loads((closure / 'node_modules/open-orange/package.json').read_text())['version'], 'inputs': {'tarball_sha256': candidate or None, 'lockfile_sha256': sha(closure / 'pnpm-lock.yaml'), 'base_image_digest': 'sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5', 'node_version': '26.13.1', 'pnpm_version': '12.21.0'}}
(out / 'artifact.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
