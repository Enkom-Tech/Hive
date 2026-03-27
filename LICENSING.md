# Licensing

This repository is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). License identifiers follow the [SPDX License List](https://spdx.org/licenses/).

Copyright (C) 2025 Enkom.

## AGPL-3.0 compliance

Hive is open-source infrastructure for Hive worker orchestration (Kubernetes operator, K3s, JuiceFS, RustFS, DragonflyDB, GitOps). Whether your use or integration triggers AGPL-3.0 obligations is your responsibility.

We recommend consulting legal or licensing advice to ensure your use of this software and any integrated projects complies with their licenses.

If your use triggers AGPL-3.0 obligations and you wish to avoid them (for example, you do not plan to open-source your modifications or application), contact Enkom to discuss commercial licensing options. Using Hive without verifying your license compliance is at your own risk.

## Scope

The entire *Hive* repository is under AGPL-3.0. There are no exceptions or alternative licenses for subdirectories.

## Third-party components

Hive orchestrates or references the following upstream projects. They are not part of this repository and have their own licenses. We do not distribute or relicense them.

| Component     | License | Notes |
|---------------|---------|--------|
| Kubernetes    | Apache-2.0 | API and tooling we target |
| K3s           | Apache-2.0 | [k3s-io/k3s](https://github.com/k3s-io/k3s) |
| JuiceFS       | Apache-2.0 | [juicedata/juicefs](https://github.com/juicedata/juicefs) |
| DragonflyDB   | BSL 1.1    | Converts to Apache-2.0 after the change date; see [Dragonfly license](https://dragonflydb.io/docs/about/license) |
| RustFS        | Apache-2.0 | [rustfs/rustfs](https://github.com/rustfs/rustfs) |
| MinIO         | AGPL-3.0   | Optional in-cluster object store via overlay; [minio/minio](https://github.com/minio/minio) |

Check each project’s current license and terms before use. Your deployment must comply with both this repository’s AGPL-3.0 and the licenses of any components you run.

## Contributions

Contributions are welcome under the same license. By submitting a contribution, you agree that it may be used under AGPL-3.0.
