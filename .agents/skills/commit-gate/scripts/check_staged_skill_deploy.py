"""staged の公開スキルを配備先へ反映し、配備整合を検証する。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = Path(os.environ.get("A3_REPO_ROOT", SCRIPT_PATH.parents[4])).resolve()
SKILL_ROOT = Path("skills")
DESTINATION_CONFIG = "a3-ci-github.skillDeployRoot"
CLI_ENV = "A3_PROJECT_SKILL_DEPLOY_CLI"
CLI_RELATIVE = Path("project-skill-deploy/scripts/deploy_project_skills.py")
EXCLUDED_PARTS = {"_build", "__pycache__"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}
PLAN_KEYS = ("updates", "stale_files", "explicit_prune_skills", "replacement_skill_roots")


def run_git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )


def git_paths(*args: str) -> list[Path]:
    result = run_git(*args)
    if result.returncode != 0:
        message = os.fsdecode(result.stderr).strip() or "git command failed"
        raise RuntimeError(message)
    return [Path(os.fsdecode(item)) for item in result.stdout.split(b"\0") if item]


def is_deployable(path: Path) -> bool:
    if path != SKILL_ROOT and SKILL_ROOT not in path.parents:
        return False
    if len(path.parts) < 3:
        return False
    root = Path(*path.parts[:2])
    if path.name != "SKILL.md" and not (REPO_ROOT / root / "SKILL.md").is_file():
        return False
    relative = path.relative_to(root)
    if any(part in EXCLUDED_PARTS for part in relative.parts):
        return False
    return path.suffix not in EXCLUDED_SUFFIXES


def staged_changes() -> list[tuple[str, Path]]:
    result = run_git(
        "diff",
        "--cached",
        "--no-renames",
        "--name-status",
        "-z",
        "--",
        SKILL_ROOT.as_posix(),
    )
    if result.returncode != 0:
        message = os.fsdecode(result.stderr).strip() or "git diff --cached failed"
        raise RuntimeError(message)
    fields = [item for item in result.stdout.split(b"\0") if item]
    if len(fields) % 2:
        raise RuntimeError("unexpected git diff --name-status output")
    return [
        (os.fsdecode(fields[index]), Path(os.fsdecode(fields[index + 1])))
        for index in range(0, len(fields), 2)
    ]


def deployable_staged_changes() -> list[tuple[str, Path]]:
    return [
        (status, path)
        for status, path in staged_changes()
        if is_deployable(path=path)
    ]


def indexed(pathspec: Path) -> bool:
    # root 名の記号を Git の pathspec として解釈させない。
    return bool(git_paths("--literal-pathspecs", "ls-files", "--cached", "-z", "--", pathspec.as_posix()))


def roots_without_skill_md() -> list[Path]:
    changed_roots = {Path(*path.parts[:2]) for _, path in deployable_staged_changes()}
    return sorted(root for root in changed_roots if not indexed(root / "SKILL.md"))


def deleted_skill_mds() -> list[Path]:
    return [path for status, path in staged_changes() if status == "D" and path.name == "SKILL.md"]


def removed_skill_roots() -> list[Path]:
    # ゲートが扱う公開 root は skills/<name> の1階層とし、その root 全体の削除だけを配備先の確認対象にする。
    return sorted({
        path.parent
        for path in deleted_skill_mds()
        if len(path.parts) == 3 and not indexed(path)
    })


def removes_nested_skill() -> bool:
    # 入れ子のスキルは配備先で別名の root にもなるため、削除時の確認範囲を確定できず停止する。
    return any(len(path.parts) > 3 for path in deleted_skill_mds())


def is_removed_root(root: Path) -> bool:
    # 改名・廃止で root 全体が index から消えた場合だけを削除として扱い、SKILL.md だけの欠落は停止する。
    return not indexed(root)


def unstaged_overlaps() -> list[str]:
    paths = [
        path
        for path in git_paths(
            "diff", "--name-only", "-z", "--", SKILL_ROOT.as_posix()
        )
        if is_deployable(path)
    ]
    tracked = set(git_paths("ls-files", "--cached", "-z", "--", SKILL_ROOT.as_posix()))
    # 配備CLIはGitのignoreを使わず収集するため、同じ公開ソースをindexと照合する。
    for candidate in (REPO_ROOT / SKILL_ROOT).rglob("*"):
        path = candidate.relative_to(REPO_ROOT)
        if candidate.is_file() and is_deployable(path) and path not in tracked:
            paths.append(path)
    return sorted({path.as_posix() for path in paths})


def resolve_cli(destination: Path) -> Path:
    override = os.environ.get(CLI_ENV)
    if override:
        return Path(override).expanduser()
    return destination / CLI_RELATIVE


def run_cli(cli: Path, destination: Path, *extra: str) -> tuple[int, str, str]:
    result = subprocess.run(
        [
            sys.executable,
            str(cli),
            "--source-root",
            str(REPO_ROOT / "skills"),
            "--target-root",
            str(destination),
            "--json",
            *extra,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout, result.stderr


def parse_plan(stdout: str) -> dict[str, object]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"deploy CLI returned invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise TypeError("deploy CLI returned a non-object JSON payload")
    for key in PLAN_KEYS:
        as_list(payload, key)
    return payload


def as_list(plan: dict[str, object], key: str) -> list[object]:
    # 欠落や型違いを空の計画として読むと、配備整合を確認しないまま通過する。
    value = plan.get(key)
    if not isinstance(value, list):
        raise TypeError(f"deploy CLI plan field is missing or not a list: {key}")
    return value


def blockers_from(plan: dict[str, object]) -> list[str]:
    items: list[str] = []
    for key in PLAN_KEYS[1:]:
        items.extend(str(item) for item in as_list(plan, key))
    return items


def nested_skill_mds() -> list[Path]:
    # 配備CLIは入れ子の SKILL.md も別 root として扱うが、本ゲートの検査範囲は skills/<name> に固定している。
    tracked = git_paths("ls-files", "--cached", "-z", "--", SKILL_ROOT.as_posix())
    present = [candidate.relative_to(REPO_ROOT) for candidate in (REPO_ROOT / SKILL_ROOT).rglob("SKILL.md")]
    return sorted({
        path for path in [*tracked, *present]
        if path.name == "SKILL.md" and len(path.parts) > 3
        and not any(part in EXCLUDED_PARTS for part in path.parts)
    })


def main() -> int:
    try:
        if not git_paths("diff", "--cached", "--name-only", "-z"):
            print(
                "skill-deploy-parity: 非適用 "
                "(no staged commit)"
            )
            return 0
        removed_roots = removed_skill_roots()
        if removes_nested_skill():
            print(
                "skill-deploy-parity: STOP: 入れ子のスキルを含む公開スキル root の削除は自動確認の対象外です。",
                file=sys.stderr,
            )
            return 1
        nested = nested_skill_mds()
        if nested:
            print(
                "skill-deploy-parity: STOP: 入れ子のスキルは自動確認の対象外です。",
                file=sys.stderr,
            )
            for path in nested:
                print(f"- {path.as_posix()}", file=sys.stderr)
            return 1
        if any(root not in removed_roots or not is_removed_root(root) for root in roots_without_skill_md()):
            print(
                "skill-deploy-parity: STOP: "
                "staged snapshot no longer contains a changed public skill SKILL.md",
                file=sys.stderr,
            )
            return 1
        overlaps = unstaged_overlaps()
        if overlaps:
            print(
                "skill-deploy-parity: STOP: "
                "対象 root に未ステージ差分または未追跡ファイルがあります。",
                file=sys.stderr,
            )
            for path in overlaps:
                print(f"- {path}", file=sys.stderr)
            return 1
        destination_config = run_git("config", "--local", "--get", DESTINATION_CONFIG)
        if destination_config.returncode not in (0, 1):
            raise RuntimeError("cannot read skill deployment destination config")
        destination_value = os.fsdecode(destination_config.stdout).strip()
        if not destination_value:
            print(
                f"skill-deploy-parity: STOP: {DESTINATION_CONFIG} is not configured",
                file=sys.stderr,
            )
            return 1
        destination = Path(destination_value).expanduser()
        if not destination.is_absolute():
            raise ValueError("skill deployment destination must be an absolute path")
        # 削除した root の配備先からの削除は自動反映しない。明示操作で削除済みの場合だけ続行する。
        remaining = [root.name for root in removed_roots if (destination / root.name).exists()]
        if remaining:
            print(
                "skill-deploy-parity: STOP: 削除した公開スキルが配備先に残っています。"
                "skills-deploy の明示操作で削除してください。",
                file=sys.stderr,
            )
            for name in remaining:
                print(f"- {destination / name}", file=sys.stderr)
            return 1
        cli = resolve_cli(destination)
        if not cli.is_file():
            print(
                f"skill-deploy-parity: ERROR: deploy CLI not found: {cli}",
                file=sys.stderr,
            )
            return 2

        code, stdout, stderr = run_cli(cli, destination, "--dry-run")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy dry-run failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        plan = parse_plan(stdout)
        blockers = blockers_from(plan)
        if blockers:
            print(
                "skill-deploy-parity: STOP: 配備先に削除候補があります。"
                "削除を伴うデプロイは明示操作で実行してください。",
                file=sys.stderr,
            )
            for item in blockers:
                print(f"- {item}", file=sys.stderr)
            return 1

        updates = [str(item) for item in as_list(plan, "updates")]
        if not updates:
            print("skill-deploy-parity: PASS (updates=0, deletions=0)")
            return 0

        # 検査から反映までの間に公開ソースや配備先が変わっていないことを、反映の直前に確かめる。
        code, stdout, stderr = run_cli(cli, destination, "--dry-run")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy dry-run failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        current = parse_plan(stdout)
        if unstaged_overlaps() or blockers_from(current) or [str(item) for item in as_list(current, "updates")] != updates:
            print(
                "skill-deploy-parity: STOP: 検査後に公開ソースまたは配備先が変わりました。",
                file=sys.stderr,
            )
            return 1

        code, _stdout, stderr = run_cli(cli, destination, "--yes")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy apply failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        code, stdout, stderr = run_cli(cli, destination, "--dry-run")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy recheck failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        remaining_plan = parse_plan(stdout)
        remaining = blockers_from(remaining_plan) + [
            str(item) for item in as_list(remaining_plan, "updates")
        ] + unstaged_overlaps()
        if remaining:
            print(
                "skill-deploy-parity: STOP: 自動反映後も配備先に差分があります。",
                file=sys.stderr,
            )
            for item in remaining:
                print(f"- {item}", file=sys.stderr)
            return 1
        print(
            f"skill-deploy-parity: PASS "
            f"(auto-deployed updates={len(updates)}, deletions=0)"
        )
        return 0
    except (OSError, RuntimeError, ValueError, TypeError, subprocess.SubprocessError) as error:
        print(f"skill-deploy-parity: ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
