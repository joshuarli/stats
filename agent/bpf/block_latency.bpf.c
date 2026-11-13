// Block request issue-to-complete latency histogram, in eBPF. The per-CPU
// stats slot layout is the protocol with the userspace loader in
// agent/src/block_bpf.rs.

#define SEC(NAME) __attribute__((section(NAME), used))
#define __uint(name, val) int (*name)[val]
#define __type(name, val) __typeof__(val) *name

#define STATS_SLOTS 20
#define BUCKET_SLOTS 0
#define COUNT_SLOT 16
#define TOTAL_US_SLOT 17
#define MIN_US_SLOT 18
#define MAX_US_SLOT 19

static void *(*bpf_map_lookup_elem)(void *map, const void *key) = (void *) 1;
static int (*bpf_map_update_elem)(void *map, const void *key, const void *value, unsigned long long flags) = (void *) 2;
static int (*bpf_map_delete_elem)(void *map, const void *key) = (void *) 3;
static unsigned long long (*bpf_ktime_get_ns)(void) = (void *) 5;

struct rq_key {
    unsigned int dev;
    unsigned long long sector;
};

struct {
    __uint(type, 1);
    __uint(max_entries, 4096);
    __type(key, struct rq_key);
    __type(value, unsigned long long);
} issue_start SEC(".maps");

struct {
    __uint(type, 6);
    __uint(max_entries, STATS_SLOTS);
    __type(key, unsigned int);
    __type(value, unsigned long long);
} stats SEC(".maps");

#define STATS_UPDATE(slot, value) \
    do { \
        unsigned int key = (slot); \
        unsigned long long *cell = bpf_map_lookup_elem(&stats, &key); \
        if (cell) *cell += (value); \
    } while (0)

struct block_rq_issue {
    unsigned short common_type;
    unsigned char common_flags;
    unsigned char common_preempt_count;
    int common_pid;
    unsigned int dev;
    unsigned long long sector;
};

struct block_rq_complete {
    unsigned short common_type;
    unsigned char common_flags;
    unsigned char common_preempt_count;
    int common_pid;
    unsigned int dev;
    unsigned long long sector;
};

#define BOUND1 100ULL
#define BOUND2 250ULL
#define BOUND3 500ULL
#define BOUND4 1000ULL
#define BOUND5 2500ULL
#define BOUND6 5000ULL
#define BOUND7 10000ULL
#define BOUND8 25000ULL
#define BOUND9 50000ULL
#define BOUND10 100000ULL
#define BOUND11 250000ULL
#define BOUND12 500000ULL
#define BOUND13 1000000ULL
#define BOUND14 2500000ULL
#define BOUND15 5000000ULL

static unsigned int bucket_of(unsigned long long latency_us) {
    if (latency_us <= BOUND1) return 0;
    if (latency_us <= BOUND2) return 1;
    if (latency_us <= BOUND3) return 2;
    if (latency_us <= BOUND4) return 3;
    if (latency_us <= BOUND5) return 4;
    if (latency_us <= BOUND6) return 5;
    if (latency_us <= BOUND7) return 6;
    if (latency_us <= BOUND8) return 7;
    if (latency_us <= BOUND9) return 8;
    if (latency_us <= BOUND10) return 9;
    if (latency_us <= BOUND11) return 10;
    if (latency_us <= BOUND12) return 11;
    if (latency_us <= BOUND13) return 12;
    if (latency_us <= BOUND14) return 13;
    if (latency_us <= BOUND15) return 14;
    return 15;
}

SEC("tracepoint/block/block_rq_issue")
int rq_issue(struct block_rq_issue *ctx) {
    struct rq_key key = { .dev = ctx->dev, .sector = ctx->sector };
    unsigned long long now = bpf_ktime_get_ns();
    bpf_map_update_elem(&issue_start, &key, &now, 0);
    return 0;
}

SEC("tracepoint/block/block_rq_complete")
int rq_complete(struct block_rq_complete *ctx) {
    struct rq_key key = { .dev = ctx->dev, .sector = ctx->sector };
    unsigned long long *started = bpf_map_lookup_elem(&issue_start, &key);
    if (!started) return 0;
    unsigned long long latency_us = (bpf_ktime_get_ns() - *started) / 1000;
    bpf_map_delete_elem(&issue_start, &key);
    unsigned int bucket = bucket_of(latency_us);
    STATS_UPDATE(BUCKET_SLOTS + bucket, 1);
    STATS_UPDATE(COUNT_SLOT, 1);
    STATS_UPDATE(TOTAL_US_SLOT, latency_us);
    unsigned int min_key = MIN_US_SLOT;
    unsigned long long *min_cell = bpf_map_lookup_elem(&stats, &min_key);
    if (min_cell && (*min_cell == 0 || latency_us < *min_cell)) *min_cell = latency_us;
    unsigned int max_key = MAX_US_SLOT;
    unsigned long long *max_cell = bpf_map_lookup_elem(&stats, &max_key);
    if (max_cell && latency_us > *max_cell) *max_cell = latency_us;
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
