# Pilot verification — 23 September 2026

## Infrastructure observations

The two-node dedicated pilot in `eu-west-1` reached Ready on Kubernetes
`v1.36.4+k3s1`, containerd `2.3.4-k3s1.36`, Ubuntu 24.04.4 and kernel
`7.0.0-1012-aws`. The worker runs gVisor `release-20260914.0`; host process
inspection observed actual `runsc-sandbox` and `runsc-gofer` processes with
`--platform=systrap` while real candidate fixtures were active.

EC2 reports the worker metadata endpoint disabled and applied, IPv6 metadata
disabled, and no IAM instance profile. The dedicated VPC route tables contain
only the VPC local route and an internet-gateway default route. No peering, VPN
or production route is present in those tables. The control role has no
production database secret access; application reconciliation is separate.

Both hosts have active persistent nftables guard services. Kubernetes kubelet
configuration reports a 256-process per-pod limit and system/Kubernetes memory
reservations. Node impersonation could not change the protected placement label.
Unauthenticated API requests returned HTTP 401.

Control and worker service restarts preserved the cluster fingerprint, protected
labels, real gVisor RuntimeClass, CoreDNS management-node placement, disabled
external DNS forwarding and the host guards. Temporary Docker registry login
credentials had been removed after the image build.

## Live test record

The operator suite created two separate candidate environments, repaired both
defective checkout services, and verified all 43 assertions, including candidate
RBAC restrictions, Restricted Pod Security, required runtime/image/placement,
protected console, blocked finalizers, internal DNS, same-namespace HTTP,
cross-namespace network denial, node/kubelet/SSH denial, metadata denial and
public egress denial. Both fixture namespaces were confirmed deleted.

The first full successful run was `d326db6e0f7f`. The upgraded Debian Trixie image
also passed all 43 checks in run `c9871649ee58`, after the service restarts. The
final source-built curl image passed all 43 checks in run `2d748ff0be3d`; both
fixture namespaces were removed. These observations attest only the recorded
digests and configuration, and must be repeated after relevant changes.

The initial failed probe run revealed two test-harness problems: an invalid
privileged-pod combination was rejected by schema validation before reaching
Pod Security, and a full PodList exceeded the runner's 32 KiB output bound. The
probe now presents a valid unsafe pod to admission and selects only the pod IP
and readiness data needed for the network check. Neither fix weakens enforcement.

## Image remediation and source review

The initial Debian Bookworm images produced ECR findings of 4 critical, 15 high,
7 medium and 1 low. Moving to the official Python 3.12 Debian Trixie base and
applying available updates installed Perl `5.40.1-6+deb13u1`, OpenSSL
`3.5.7-1~deb13u2`, util-linux `2.41.5-0+deb13u1` and zlib
`1:1.3.dfsg+really1.3.1-1+b1`.

Debian confirms the Trixie versions fix the earlier critical findings:
[Perl Storable](https://security-tracker.debian.org/tracker/CVE-2026-57433),
[Perl Socket](https://security-tracker.debian.org/tracker/CVE-2026-12087),
[Perl regex](https://security-tracker.debian.org/tracker/CVE-2026-13221), and
[OpenSSL AEAD](https://security-tracker.debian.org/tracker/CVE-2026-75803).

That intermediate image still produced 2 critical and 3 high ECR findings,
including curl `8.14.1-2+deb13u5`. The final build therefore compiles official
curl `8.22.0` from its SHA-256-pinned source archive in a disposable build stage.
It retains HTTP/2, TLS, compression and public-suffix support. The runtime image
contains the resulting tool and runtime libraries, without a compiler or the
older distro curl/libcurl packages. Upstream confirms fixes for
[CVE-2026-8927](https://curl.se/docs/CVE-2026-8927.html) and
[CVE-2026-8924](https://curl.se/docs/CVE-2026-8924.html) in curl 8.21.0 and later.
The image records tool versions and checksums in
`/usr/local/share/uniqassess/tool-versions.json`. All setuid/setgid file bits are
removed after account creation; runtime admission additionally enforces
non-root execution, dropped capabilities and no privilege escalation.

Any remaining scan findings require component-level review. The Perl finding
[CVE-2026-82560](https://security-tracker.debian.org/tracker/CVE-2026-82560)
concerns the `Pod::Text` formatter, so actual module presence must be checked in
the final minimal image. The zlib finding
[CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091)
remains listed by Debian; its description and affected-version table disagree,
so a version-string comparison alone does not justify dismissing it. The broker
does not invoke Perl/POD processing or zlib's non-blocking gzip write API.
Candidate code is confined by the observed sandbox, workload limits and network
restrictions. These controls are mitigation, not a claim that a listed package
has been patched.

ECR package scanning is one check. The source-built curl tool also requires its
explicit version/checksum record and upstream advisory review; absence of an OS
package finding does not by itself verify that manually built software is safe.

Final image digests, completed scan counts, component checks and the final
43-assertion run are recorded below. No verification flag is set by the probe or
this document.

## Final image validation

| Item | Verified result |
| --- | --- |
| Workspace digest | `sha256:93f17bab6f19e9c600de0202e3e58e25fa8d5441198cff7e36ee1612d96290d4` |
| Broker digest | `sha256:8c1ec29cf62b0615c978e57f8f40195f4657c77afd7172064d681f1443b00663` |
| ECR scan, both images | COMPLETE: **0 critical**, 2 high, 2 medium, 1 low |
| Live run | `2d748ff0be3d`: **43/43 passed**, both namespaces deleted |
| Actual curl | `8.22.0`, OpenSSL 3.5.7, zlib 1.3.1, HTTP/2, PSL and TLS enabled |
| Older distro curl/libcurl | Not installed |
| Setuid/setgid files under `/usr` | None |
| Perl `Pod::Text` | Module absent; explicit module-load check failed as expected |

The two remaining high findings are `CVE-2026-82560` (Perl, affected formatter
absent) and `CVE-2026-85091` (zlib, remains listed). The remaining medium findings
are `CVE-2026-58055` (nghttp2) and `CVE-2026-86805` (glibc); the low finding is
`CVE-2026-95818` (glibc). Keep them visible in maintenance review and rebuild when
vendor fixes become available. This is a bounded pilot with observed isolation,
not a zero-vulnerability claim or a validated hiring pass threshold.

For zlib specifically, the stable package has not been replaced with an unreviewed
testing/unstable package or a hand-edited package version. The upstream
[fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)
is known, but this pilot does not claim that fix is present in the installed
Debian package. Maintain the two-lab cap, non-root execution, no privilege
escalation, gVisor runtime, resource limits and blocked external networking.
The broker does not call the affected non-blocking gzip-write API. Candidates
can execute their own code inside a disposable lab, so the package finding is
contained by the sandbox boundary rather than treated as repaired. Before
broadening candidate use, review vendor status, rebuild with a supported fixed
package when available, rescan both digests and repeat the live isolation tests.

Sanitized structured observations are in [pilot-evidence.json](pilot-evidence.json).
Full non-secret operator outputs are retained locally in `.deployment/`:
`infra-isolation-final-result.json`, `infra-host-result.json`,
`infra-package-final-result.json`, `infra-restart-result.json`,
`infra-worker-cloud-evidence.json`, and `image-scan-final-{workspace,broker}.json`.
The corresponding SSM command IDs are included in those records.

Temporary IAM and SSH access was removed after final application acceptance on
23 September 2026. The runner credential and management policy were preserved,
the bootstrap secret was scheduled with a seven-day recovery window, and
post-cleanup app/broker health checks passed. Exact scope and sanitized evidence
are in [BOOTSTRAP_CLEANUP.md](BOOTSTRAP_CLEANUP.md) and
[bootstrap-cleanup-evidence.json](bootstrap-cleanup-evidence.json).
