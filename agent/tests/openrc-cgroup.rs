use stats::cgroup::{read_services, unit_cgroup, ServiceCgroup};
use stats::model::{Service, ServiceIo, ServiceMemory, ServiceUsage};
use std::path::{Path, PathBuf};

#[test]
fn an_openrc_unit_resolves_to_its_cgroup_and_reads_the_real_fixture() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/openrc-tansu");
    let service = ServiceCgroup {
        name: "tansu".to_owned(),
        cgroup: unit_cgroup("openrc.tansu").expect("openrc unit"),
    };
    assert_eq!(service.cgroup, PathBuf::from("openrc.tansu"));
    let services = read_services(&root, &[service]).expect("controllers");
    assert_eq!(
        services,
        vec![Service::measured(
            "tansu",
            ServiceUsage {
                cpu_usec: 12_884_901_888,
                memory: Some(ServiceMemory { current: 268_435_456, peak: None }),
                io: Some(ServiceIo { read_bytes: 1_052_672, write_bytes: 2_105_344, reads: 20, writes: 40 }),
            },
        )]
    );
}
