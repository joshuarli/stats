# RFC STA-142: per-service disk usage

Status: proposed, 2026-11-26. No mechanism is chosen yet; this records the
requirement, the measurements and the options so the design can be done
deliberately.

## Problem

Stats attributes CPU, memory and I/O to a service through its cgroup, and it
reports disk usage only per mounted filesystem. A host whose filesystem
holds several services' data cannot say which service owns the space, and a
service whose data sits on a shared root (`/`) has no number at all.

The first question was how much space Stuff uses. On 2026-11-26 the answer
had to be measured by hand on the `stuff-primary` guest, which runs no
Stats agent:

| Location | Size |
| --- | --- |
| `stuff-oci-blobs` bucket | 11 GB |
| `stuff-mynpm` | 2.9 GB |
| `stuff-mirror` | 2.5 GB |
| `stuff-mycrates` | 2.3 GB |
| `stuff-mypypi` | 1.2 GB |
| Retired Engine depot (`/var/lib/openorange/engine`) | 521 MB |
| Releases (`/opt/stuff-native`) | 223 MB |
| Publisher state (`/var/lib/stuff-native`) | 29 MB |

The data volume (`/dev/vdb`, ext4, 157 GB) held 20 GB in 154,803 files and
87,223 directories. Cloudflare R2 holds a second copy, which no host metric
can see.

## Requirements

- Attribute allocated bytes, and ideally file counts, to a named service on a
  host, where the service's data may share a filesystem with other services.
- The cost must not grow with the number of files on every sample. A
  service with millions of small objects must cost about what a small one
  costs.
- No root for the default agent build, consistent with the agent's
  invariants; Linux first, macOS where a service runs there.
- Counted once: hard links, reflinks and overlay layers must not inflate a
  total, and bind mounts must not be crossed twice.
- Delivered on the existing host ingest path or a documented successor; any
  STB2 change is a protocol change with fixtures.

## Measurements

A warm-cache `du -s` of Stuff's store took 0.59–0.67 s wall time (0.11–0.14 s
user, 0.47–0.49 s system, 3.8 MiB RSS) under `nice 19` and `ionice -c3`. That
is the best case: once the dentry and inode caches are cold, a walk issues
random metadata reads for each of the 87,223 directories, and the cost grows
with file count. A periodic walk is therefore rejected as the default
mechanism.

## Options

1. **Filesystem project quotas** (ext4 `project` + `quota`, XFS `prjquota`).
   Each service root gets a project ID (`chattr -p ID +P`), and the kernel
   keeps exact usage; a read is one `quotactl` per service. Costs: enabling
   the ext4 feature needs `tune2fs` on an unmounted filesystem, reading
   quotas needs `CAP_SYS_ADMIN` or a privileged helper, Linux only, and files
   moved in from outside keep their old project until reassigned.
2. **One filesystem per service.** Each service's data lives on its own
   volume (LV, qcow2 data disk, loop image or dataset) and the agent's
   existing per-mount report is attributed to the service. No new
   measurement and no privilege, but every host needs volume management, and
   shared roots cannot be split. The Stuff guest is already close to this:
   `/dev/vdb` holds only Stuff data and the retired depot.
3. **Btrfs or ZFS accounting.** Subvolume qgroups or dataset `used`
   properties give per-service totals cheaply, but they require those
   filesystems; current hosts use ext4.
4. **Incremental accounting from change events.** Walk once, then keep
   totals current from fanotify filesystem marks (create, delete, modify,
   move), rescanning a subtree on queue overflow. Cost follows the write
   rate, not the file count; it needs `CAP_SYS_ADMIN` for filesystem marks,
   and correctness depends on overflow and restart handling.
5. **Service-reported usage.** The service reports what it stores (Stuff
   already knows every object's size through its store and coordinator
   state) as application telemetry. Cheap and semantically rich (per
   registry), but it trusts the service and misses files the service does
   not track: logs, caches, old releases.

Combinations are plausible: project quotas or per-service volumes for the
authoritative host number, plus service-reported breakdowns for detail.

## Open questions

- Which hosts and services need this first, and do they share filesystems?
- Is a privileged helper acceptable for quota reads, or must the agent stay
  unprivileged end to end?
- Does usage belong in STB2 samples, or in a new low-frequency record (disk
  usage changes slowly)?
- Should R2 and other remote storage be reported per service (from the
  Cloudflare API) beside host disk?
- The Stuff guest and the Stats guest run no Stats agent, so neither their
  disk nor their CPU and memory reach Stats. Installing agents there is a
  prerequisite for any option.
