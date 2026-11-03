import type { OsFamily } from "./os-marks";

const OS_MARKERS: readonly (readonly [OsFamily, readonly string[]])[] = [
  ["macos", ["macos", "mac os", "os x", "darwin"]],
  ["windows", ["windows"]],
  ["freebsd", ["freebsd"]],
  ["endeavouros", ["endeavour"]],
  ["manjaro", ["manjaro"]],
  ["arch", ["arch linux", "archlinux", "artix", "cachyos", "garuda", "steamos"]],
  ["alpine", ["alpine"]],
  ["nixos", ["nixos"]],
  ["alma", ["almalinux", "alma linux"]],
  ["rocky", ["rocky linux"]],
  ["centos", ["centos"]],
  ["redhat", ["red hat", "rhel"]],
  ["fedora", ["fedora", "nobara", "bazzite"]],
  ["suse", ["opensuse", "suse"]],
  ["ubuntu", ["ubuntu"]],
  ["mint", ["linux mint"]],
  ["popos", ["pop!_os", "pop os", "popos"]],
  ["elementary", ["elementary"]],
  ["kali", ["kali"]],
  ["zorin", ["zorin"]],
  ["raspberrypi", ["raspberry pi", "raspbian"]],
  ["debian", ["debian"]],
  ["gentoo", ["gentoo"]],
  ["void", ["void linux"]],
  ["solus", ["solus"]],
  ["linux", ["linux"]]
];

export function osFamily(os: string | undefined): OsFamily | undefined {
  if (os === undefined) return undefined;
  const name = os.toLowerCase();
  return OS_MARKERS.find(([, markers]) => markers.some(marker => name.includes(marker)))?.[0];
}
