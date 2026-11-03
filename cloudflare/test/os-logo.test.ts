import { describe, expect, it } from "vitest";
import { osFamily } from "../src/client/os";

describe("operating system marks", () => {
  it.each([
    ["macOS 27.2", "macos"],
    ["Windows 11 Pro", "windows"],
    ["FreeBSD 14.2-RELEASE", "freebsd"],
    ["Ubuntu 24.04.4 LTS", "ubuntu"],
    ["Debian GNU/Linux 13 (trixie)", "debian"],
    ["Linux Mint 22.1", "mint"],
    ["Pop!_OS 24.04 LTS", "popos"],
    ["elementary OS 8.0", "elementary"],
    ["Kali GNU/Linux Rolling", "kali"],
    ["Zorin OS 17.3", "zorin"],
    ["Raspberry Pi OS (64-bit)", "raspberrypi"],
    ["Fedora Linux 42 (Workstation Edition)", "fedora"],
    ["Nobara Linux 41", "fedora"],
    ["Arch Linux", "arch"],
    ["EndeavourOS", "endeavouros"],
    ["Manjaro Linux", "manjaro"],
    ["Alpine Linux edge", "alpine"],
    ["NixOS 25.05", "nixos"],
    ["CentOS Stream 10", "centos"],
    ["Red Hat Enterprise Linux 9.5", "redhat"],
    ["Rocky Linux 9.5", "rocky"],
    ["AlmaLinux 9.5", "alma"],
    ["openSUSE Tumbleweed", "suse"],
    ["Gentoo Linux", "gentoo"],
    ["Void Linux", "void"],
    ["Solus 4.6", "solus"],
    ["Unknown Linux", "linux"],
    ["Plan 9", undefined]
  ] as const)("maps %s", (name, family) => {
    expect(osFamily(name)).toBe(family);
  });

  it("has no mark for a missing system report", () => {
    expect(osFamily(undefined)).toBeUndefined();
  });
});
