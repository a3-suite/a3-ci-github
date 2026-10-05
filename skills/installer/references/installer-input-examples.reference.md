# インストーラ入力サンプル

## 理解できること
- use case と target platform を選択済みの manifest / execution request sample
- execution request の最小例
- install state と handoff state の最小例

## 補足
- 本リファレンスは入力契約の形を理解するためのサンプルであり、実行可能な installer 実装ではない。
- 本リファレンスは監査証跡ではない。監査の fixture 対応はインストーラ契約 coverage matrix とインストーラ fixture baseline を正本とする。
- field 名と階層は例であり、実 project では project の manifest schema を SSOT とする。
- production manifest では、project schema が定義していない field を拒否する。
- token、secret、auth header、env value は manifest、execution request、install state、handoff state、audit log に含めない。
- checksum 値は説明用の短縮表記であり、実際は project が定める完全な checksum 形式を使う。

## use case 別 sample bundle
- use case と sample path の対応、選択可能な全 platform、use case ごとの追加必須入力は `installer-use-case-contract.reference.yml` を正本とする。
- sample はコピーして project 固有値へ適合させる入力例であり、実行可能な installer 本体ではない。manifest を変更した場合は execution request の manifest checksum も再計算する。

## execution request 例
```json
{
  "manifest": {
    "path": "/tmp/example-app/manifest.json",
    "checksum": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  },
  "execution": {
    "operationMode": "upgrade",
    "sourceMode": "online",
    "instanceId": "default"
  },
  "audit": {
    "requestedBy": "release-operator",
    "requestedAt": "2026-06-17T10:00:00Z",
    "reason": "scheduled release"
  }
}
```

## dry-run execution request 例
```json
{
  "manifest": {
    "path": "/tmp/example-web/manifest.json",
    "checksum": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "execution": {
    "operationMode": "dry-run",
    "sourceMode": "online",
    "instanceId": "default"
  },
  "audit": {
    "requestedBy": "release-operator",
    "requestedAt": "2026-06-17T10:05:00Z",
    "reason": "preflight validation"
  }
}
```

## offline execution request 例
```json
{
  "manifest": {
    "path": "/tmp/example-app/manifest.json",
    "checksum": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  },
  "execution": {
    "operationMode": "upgrade",
    "sourceMode": "offline",
    "localArtifactPath": "/var/cache/example-app/example-app-1.4.2.jar",
    "instanceId": "default"
  },
  "audit": {
    "requestedBy": "release-operator",
    "requestedAt": "2026-06-17T10:08:00Z",
    "reason": "offline release"
  }
}
```

## install state 例
```json
{
  "releaseVersion": "1.4.2",
  "artifactChecksum": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "manifestChecksum": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "installedAt": "2026-06-17T10:10:00Z",
  "previousRelease": "1.4.1",
  "activationStrategy": "active-pointer",
  "activationState": {
    "currentLink": "/opt/example-app/current",
    "activeReleasePath": "/opt/example-app/releases/1.4.2"
  },
  "installerVersion": "1.2.0",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "sourceTag": "v1.4.2",
  "ciRunId": "1234567890"
}
```

## external handoff state 例
```json
{
  "releaseVersion": "2.8.0",
  "artifactChecksum": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "manifestChecksum": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "handoffRecordedAt": "2026-06-17T10:10:00Z",
  "previousRelease": "2.7.9",
  "activationStrategy": "external-orchestrated",
  "verifiedReleasePath": "/opt/example-web/releases/2.8.0",
  "externalOrchestrationRef": "deployment/example-web/2.8.0",
  "installerVersion": "1.2.0",
  "sourceCommit": "abcdef0123456789abcdef0123456789abcdef01",
  "sourceTag": "v2.8.0",
  "ciRunId": "2234567890"
}
```

## audit log entry 例
```json
{
  "eventType": "install.result",
  "operationMode": "upgrade",
  "sourceMode": "online",
  "result": "success",
  "manifestChecksum": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "artifactChecksum": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "releaseVersion": "1.4.2",
  "requestedBy": "release-operator",
  "requestedAt": "2026-06-17T10:00:00Z",
  "reason": "scheduled release"
}
```

## 禁止例
- `operationMode` を manifest に含める。
- token、secret、auth header、env value を manifest、execution request、install state、handoff state、audit log に含める。
- `latest`、version range、SNAPSHOT、moving branch を production manifest に含める。
- checksum がない artifact、shared asset、SBOM を production manifest に含める。
